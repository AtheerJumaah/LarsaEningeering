"use client";

/* Structure: the shape of the company, drawn rather than listed.
 *
 * The old version was a scrolling list of names with four numbers each, which
 * is what the Dashboard already does better. This tab answers a different
 * question -- how is the company arranged -- so it shows departments as cards
 * sized by headcount, with their teams and people as chips. Per-person figures
 * deliberately do not appear here.
 *
 * Everything is drag to reorder: departments among themselves, teams within
 * their department. Order is stored in the chart, so it is the same order for
 * everyone.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "./Dialog";
import { GripVertical, Pencil, Plus, Save, Undo2, X } from "lucide-react";
import { pushSyncedKeyNow } from "../lib/supabase/sync";
import {
  assignableTo,
  canCreateDepartments,
  canEditDepartment,
  effectiveOrg,
  isOrgAdmin,
  newId,
  teamsVisibleTo,
  writeOrg,
} from "../lib/org";
import type { Department, OrgChart, OrgUser, Team } from "../lib/org";

function initials(name: string): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* Keep this component outside OrgStructure. The structure can repaint when
 * the shared roster or sync stamp changes; defining the picker inside the
 * parent would give React a new component type on every repaint and reset its
 * open state while the user is moving toward a person. */
function AddPerson({ pool, chosen, onAdd, label }: { pool: OrgUser[]; chosen: string[]; onAdd: (id: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const options = pool.filter((row) => chosen.indexOf(row.id) < 0);
  const filteredOptions = options.filter((row) => String(row.name || "").toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;

    const positionMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.max(rect.width, 240);
      const gap = 5;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      const left = Math.min(Math.max(8, rect.left), maxLeft);
      const maxHeight = Math.min(300, Math.max(160, window.innerHeight - 16));
      const below = window.innerHeight - rect.bottom - gap;
      const above = rect.top - gap;
      const placeAbove = below < 180 && above > below;
      setMenuStyle({
        position: "fixed",
        left,
        width,
        ...(placeAbove
          ? { bottom: window.innerHeight - rect.top + gap, maxHeight }
          : { top: rect.bottom + gap, maxHeight }),
      });
    };

    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    function closeOutside(event: PointerEvent) {
      const target = event.target as Node;
      if (!pickerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  if (!options.length) return null;
  return (
    <div ref={pickerRef} className="struct-picker">
      <button
        type="button"
        className="struct-select-trigger"
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => {
          if (!value) setQuery("");
          return !value;
        })}
      >
        {label}<span aria-hidden="true">⌄</span>
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div
          ref={menuRef}
          className="struct-select-menu"
          style={menuStyle}
          role="listbox"
          aria-label={label}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="struct-select-search-wrap">
            <input
              className="struct-select-search"
              type="search"
              value={query}
              autoFocus
              placeholder={`Search ${label.toLowerCase().replace(/^add /, "")}...`}
              aria-label={`Search ${label}`}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
            />
            <small>{filteredOptions.length} of {options.length} available</small>
          </div>
          {filteredOptions.length ? filteredOptions.map((row) => (
            <button
              type="button"
              role="option"
              aria-selected="false"
              className="struct-select-option"
              key={row.id}
              onClick={() => { onAdd(row.id); setOpen(false); setQuery(""); }}
            >
              <em>{initials(String(row.name || ""))}</em>{row.name}
            </button>
          )) : (
            <p className="struct-select-empty">No matching people</p>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export function OrgStructure({
  viewer,
  users,
  onSaved,
}: {
  viewer: OrgUser | null;
  users: OrgUser[];
  onSaved?: () => void;
}) {
  const [tick, setTick] = useState(0);
  const dialog = useDialog();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragDep, setDragDep] = useState("");
  const [overDep, setOverDep] = useState("");
  const [dragTeam, setDragTeam] = useState(""); const [dragPerson, setDragPerson] = useState("");
  const [overTeam, setOverTeam] = useState("");

  const serverChart = useMemo(() => effectiveOrg(users), [users, tick]);
  const [draft, setDraft] = useState<OrgChart | null>(null);
  const chart = draft || serverChart;
  const active = useMemo(() => users.filter((row) => row.enabled !== false), [users]);

  /* Resolves an id to a real, non-empty name -- and nothing else. A team or
     department can reference an id that no longer has a matching staff record
     (someone removed, or leftover seed data); that is not a person named
     "Unknown", it is nobody, and every caller below is expected to treat an
     empty string as "leave this id out" rather than inventing a placeholder. */
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((row) => {
      const name = String(row.name || "").trim();
      if (name) map.set(row.id, name);
    });
    return (id: string) => map.get(id) || "";
  }, [users]);
  function isKnown(id: string): boolean {
    return Boolean(nameOf(id));
  }

  /* Functional roles (department head and team lead) are intentionally not
     treated as a person's only manager. The reporting map lets an admin add
     an operational or technical manager without removing those roles. Older
     staff records still get their existing Reports To value as the starting
     line until an explicit list is saved here. */
  function reportingFor(personId: string): string[] {
    if (chart.reporting && Object.prototype.hasOwnProperty.call(chart.reporting, personId)) {
      return (chart.reporting[personId] || []).filter((id) => id !== personId && isKnown(id));
    }
    const person = active.find((row) => row.id === personId);
    const named = String(person?.manager || "").trim().toLowerCase();
    if (!named) return [];
    const manager = active.find((row) => row.id.toLowerCase() === named || String(row.name || "").trim().toLowerCase() === named);
    return manager && manager.id !== personId ? [manager.id] : [];
  }

  function setReporting(personId: string, managerIds: string[]) {
    const reporting = { ...(chart.reporting || {}) };
    reporting[personId] = [...new Set(managerIds.filter((id) => id !== personId && isKnown(id)))];
    save({ ...chart, reporting }, "Reporting line updated.");
  }

  function save(next: OrgChart, message: string) {
    setDraft(next);
    setNote(`${message} Review the change, then click Save changes.`);
  }

  async function commitChanges() {
    if (!draft || saving) return;
    if (writeOrg(draft)) {
      /* A successful localStorage write is not a successful company-wide
         save. Wait for Supabase to acknowledge the latest blob before
         clearing the user's draft or claiming that the change synced. */
      setSaving(true);
      setNote("Saving organization changes to the company server…");
      try {
        const synced = await pushSyncedKeyNow("larsaStaffV8");
        if (!synced) {
          setNote("Changes are saved on this device, but server sync is unavailable. Keep this app open and try Save changes again.");
          return;
        }
        setDraft(null);
        setTick((value) => value + 1);
        setNote("Changes saved to the company server.");
        if (onSaved) onSaved();
      } catch (error) {
        console.error("[organization] save was not confirmed by the company server:", error);
        setNote("Changes are on this device but were not confirmed by the company server. Keep this app open and try Save changes again.");
      } finally {
        setSaving(false);
      }
    } else {
      setNote("Could not save. Reload and try again.");
    }
  }

  function discardChanges() {
    if (!draft) return;
    setDraft(null);
    setNote("Unsaved changes discarded.");
  }

  const visibleTeams = teamsVisibleTo(chart, viewer);
  const visibleTeamIds = new Set(visibleTeams.map((row) => row.id));
  const departments = chart.departments.filter(
    (row) => isOrgAdmin(viewer) || visibleTeams.some((team) => team.departmentId === row.id),
  );

  function membersOf(team: Team): string[] {
    return [...new Set((team.leadIds || []).concat(team.memberIds || []))].filter(isKnown);
  }
  function peopleIn(department: Department): string[] {
    const ids = new Set<string>();
    chart.teams
      .filter((team) => team.departmentId === department.id)
      .forEach((team) => membersOf(team).forEach((id) => ids.add(id)));
    return [...ids];
  }

  const placed = new Set<string>();
  chart.teams.forEach((team) => membersOf(team).forEach((id) => placed.add(id)));
  const unassigned = active.filter((row) => !placed.has(row.id));
  const leadershipIds = new Set<string>([
    ...chart.departments.flatMap((department) => department.headIds || []),
    ...chart.teams.flatMap((team) => team.leadIds || []),
  ]);
  const additionalReportingPeople = active.filter((person) => !leadershipIds.has(person.id));
  const largest = Math.max(1, ...departments.map((row) => peopleIn(row).length));

  function moveDepartment(fromId: string, toId: string) {
    if (!fromId || !toId || fromId === toId) return;
    const list = chart.departments.slice();
    const from = list.findIndex((row) => row.id === fromId);
    const to = list.findIndex((row) => row.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    save({ departments: list, teams: chart.teams }, "Order saved.");
    setDragDep("");
    setOverDep("");
  }

  function moveTeam(fromId: string, toId: string) {
    if (!fromId || !toId || fromId === toId) return;
    const list = chart.teams.slice();
    const from = list.findIndex((row) => row.id === fromId);
    const to = list.findIndex((row) => row.id === toId);
    if (from < 0 || to < 0) return;
    if (list[from].departmentId !== list[to].departmentId) { setDragTeam(""); setOverTeam(""); return; }
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    save({ departments: chart.departments, teams: list }, "Order saved.");
    setDragTeam("");
    setOverTeam("");
  }

  async function addDepartment() {
    const name = await dialog.prompt("Department name");
    if (!name || !name.trim()) return;
    save({ ...chart, departments: [...chart.departments, { id: newId("dep"), name: name.trim(), headIds: [] }] }, "Department added.");
  }
  async function addTeam(departmentId: string) {
    const name = await dialog.prompt("Team name");
    if (!name || !name.trim()) return;
    save({ ...chart, teams: [...chart.teams, { id: newId("team"), departmentId, name: name.trim(), leadIds: [], memberIds: [] }] }, "Team added.");
  }
  function setHeads(department: Department, headIds: string[]) {
    save({ ...chart, departments: chart.departments.map((row) => (row.id === department.id ? { ...row, headIds } : row)) }, "Saved.");
  }
  function setTeamField(team: Team, field: "leadIds" | "memberIds", ids: string[]) {
    save({ ...chart, teams: chart.teams.map((row) => (row.id === team.id ? { ...row, [field]: ids } : row)) }, "Saved.");
  }
  async function renameDepartment(department: Department) {
    const value = await dialog.prompt({
      title: "Rename department",
      message: "Choose the name shown to everyone in the organization.",
      defaultValue: department.name,
      confirmLabel: "Apply name",
      placeholder: "Department name",
    });
    const name = String(value || "").trim();
    if (!name || name === department.name) return;
    save({
      ...chart,
      departments: chart.departments.map((row) => (row.id === department.id ? { ...row, name } : row)),
    }, "Department name saved.");
  }
  async function renameTeam(team: Team) {
    const value = await dialog.prompt({
      title: "Rename team",
      message: "Choose the name shown to everyone in the organization.",
      defaultValue: team.name,
      confirmLabel: "Apply name",
      placeholder: "Team name",
    });
    const name = String(value || "").trim();
    if (!name || name === team.name) return;
    save({
      ...chart,
      teams: chart.teams.map((row) => (row.id === team.id ? { ...row, name } : row)),
    }, "Team name saved.");
  }
  async function removeTeam(team: Team) {
    if (!(await dialog.confirm("Remove " + team.name + "?"))) return;
    save({ ...chart, teams: chart.teams.filter((row) => row.id !== team.id), removedTeamIds: [...new Set([...(chart.removedTeamIds || []), team.id])] }, "Team removed.");
  }
  async function removeDepartment(department: Department) {
    if (!(await dialog.confirm("Remove " + department.name + " and its teams?"))) return;
    const removedTeams = chart.teams.filter((row) => row.departmentId === department.id).map((row) => row.id);
    save({
      ...chart,
      departments: chart.departments.filter((row) => row.id !== department.id),
      teams: chart.teams.filter((row) => row.departmentId !== department.id),
      removedDepartmentIds: [...new Set([...(chart.removedDepartmentIds || []), department.id])],
      removedTeamIds: [...new Set([...(chart.removedTeamIds || []), ...removedTeams])],
    }, "Department removed.");
  }

  function moveMember(team: Team, fromId: string, toId: string) {    if (!fromId || !toId || fromId === toId) return;    const list = (team.memberIds || []).slice();    const from = list.indexOf(fromId);    const to = list.indexOf(toId);    if (from < 0 || to < 0) return;    const [moved] = list.splice(from, 1);    list.splice(to, 0, moved);    setTeamField(team, "memberIds", list);    setDragPerson("");  }
  /* ids can carry references to people who no longer resolve to a name (see
     nameOf above); those are filtered out here rather than at every call
     site, so an unresolvable id silently disappears and the field falls back
     to its own empty-state copy ("No head" / "No lead" / "Nobody yet") the
     same as if the id had never been added. Nobody ever renders as "Unknown". */
  function Chips({ ids, onRemove, empty, onReorder }: { ids: string[]; onRemove?: (id: string) => void; empty: string; onReorder?: (fromId: string, toId: string) => void }) {
    const visible = ids.filter(isKnown);
    if (!visible.length) return <span className="struct-empty">{empty}</span>;
    return (
      <span className="struct-chips">
        {visible.map((id) => (
          <span className={"struct-chip" + (onReorder ? " is-movable" : "")} key={id} title={nameOf(id)} draggable={Boolean(onReorder)} onDragStart={onReorder ? (event) => { event.stopPropagation(); setDragPerson(id); } : undefined} onDragOver={onReorder ? (event) => { event.preventDefault(); event.stopPropagation(); } : undefined} onDrop={onReorder ? (event) => { event.preventDefault(); event.stopPropagation(); onReorder(dragPerson, id); } : undefined}>
            <em>{initials(nameOf(id))}</em>
            {nameOf(id)}
            {onRemove ? (
              <button type="button" aria-label={"Remove " + nameOf(id)} onClick={() => onRemove(id)}><X size={12} /></button>
            ) : null}
          </span>
        ))}
      </span>
    );
  }

  return (
    <div className="struct">
      <section className="struct-summary">
        <span className="hier-stat"><small>Departments</small><b>{departments.length}</b></span>
        <span className="hier-stat"><small>Teams</small><b>{visibleTeams.length}</b></span>
        <span className="hier-stat"><small>People</small><b>{placed.size}</b></span>
        <span className="hier-stat"><small>Unassigned</small><b>{unassigned.length}</b></span>
        {canCreateDepartments(viewer) ? (
          <button type="button" className="org-add struct-add" onClick={addDepartment}><Plus size={15} /> Department</button>
        ) : null}
      </section>

      <div className={`struct-savebar${draft ? " is-dirty" : ""}`} role="status">
        <span className="struct-save-state"><span className="struct-save-dot" />{saving ? "Saving to company server" : draft ? "Changes need server confirmation" : "All organization changes saved"}</span>
        <span className="struct-save-help">{draft ? "Keep this app open until the server confirms the save." : "Changes stay in place after you save them."}</span>
        <button type="button" className="struct-discard" disabled={!draft || saving} onClick={discardChanges}><Undo2 size={14} /> Discard</button>
        <button type="button" className="struct-save" disabled={!draft || saving} onClick={commitChanges}><Save size={15} /> {saving ? "Saving…" : "Save changes"}</button>
      </div>

      {note ? <p className="struct-note">{note}</p> : null}

      <div className="struct-grid">
        {departments.map((department) => {
          const editable = canEditDepartment(chart, viewer, department.id, users);
          const teams = chart.teams.filter(
            (team) => team.departmentId === department.id && (isOrgAdmin(viewer) || visibleTeamIds.has(team.id)),
          );
          const headcount = peopleIn(department).length;
          const pool = assignableTo(chart, viewer, users, department.id);
          return (
            <section
              className={"struct-dep" + (dragDep === department.id ? " is-dragging" : "") + (overDep === department.id ? " is-over" : "")}
              key={department.id}
              onDragEnd={() => { setDragDep(""); setOverDep(""); }}
              onDragOver={(event) => { event.preventDefault(); if (overDep !== department.id) setOverDep(department.id); }}
              onDrop={(event) => { event.preventDefault(); moveDepartment(dragDep, department.id); }}
            >
              <header className="struct-dep-head">
                <span
                  className="hier-drag"
                  title="Drag to reorder"
                  aria-label={`Drag ${department.name} to reorder`}
                  role="button"
                  draggable
                  onDragStart={() => setDragDep(department.id)}
                ><GripVertical size={15} /></span>
                <span className="struct-dep-title">
                  <b>{department.name}</b>
                  <small>{teams.length} {teams.length === 1 ? "team" : "teams"} {"\u00b7"} {headcount} {headcount === 1 ? "person" : "people"}</small>
                </span>
                {editable ? (
                  <button type="button" className="struct-x struct-edit" title="Rename department" aria-label={`Rename ${department.name}`} onClick={() => renameDepartment(department)}><Pencil size={13} /><span className="struct-edit-label">Rename</span></button>
                ) : null}
                {editable && isOrgAdmin(viewer) ? (
                  <button type="button" className="struct-x" title="Remove department" onClick={() => removeDepartment(department)}><X size={14} /></button>
                ) : null}
              </header>

              <span className="struct-share" aria-hidden="true">
                <i style={{ width: Math.max(4, (headcount / largest) * 100) + "%" }} />
              </span>

              <div className="struct-field">
                <span className="struct-label">Head</span>
                <Chips
                  ids={department.headIds || []}
                  empty="No head"
                  onRemove={isOrgAdmin(viewer) ? (id) => setHeads(department, (department.headIds || []).filter((row) => row !== id)) : undefined}
                />
                {isOrgAdmin(viewer) ? (
                  <AddPerson pool={active} chosen={department.headIds || []} label="Add head" onAdd={(id) => setHeads(department, [...(department.headIds || []), id])} />
                ) : null}
              </div>
              {(department.headIds || []).filter(isKnown).map((headId) => {
                const managerIds = reportingFor(headId);
                const managerPool = isOrgAdmin(viewer) ? active : assignableTo(chart, viewer, users, department.id);
                return (
                  <div className="struct-reporting" key={`department-reporting-${department.id}-${headId}`}>
                    <span className="struct-reporting-label"><small>Reports to</small><b>{nameOf(headId)}</b></span>
                    <Chips
                      ids={managerIds}
                      empty="No line manager"
                      onRemove={editable ? (id) => setReporting(headId, managerIds.filter((row) => row !== id)) : undefined}
                    />
                    {editable ? (
                      <AddPerson pool={managerPool.filter((row) => row.id !== headId)} chosen={managerIds} label="Add manager" onAdd={(id) => setReporting(headId, [...managerIds, id])} />
                    ) : null}
                  </div>
                );
              })}

              {teams.map((team) => (
                <div
                  className={"struct-team" + (dragTeam === team.id ? " is-dragging" : "") + (overTeam === team.id ? " is-over" : "")}
                  key={team.id}
                  onDragStart={(event) => { event.stopPropagation(); setDragTeam(team.id); }}
                  onDragEnd={() => { setDragTeam(""); setOverTeam(""); }}
                  onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); if (overTeam !== team.id) setOverTeam(team.id); }}
                  onDrop={(event) => { event.preventDefault(); event.stopPropagation(); moveTeam(dragTeam, team.id); }}
                >
                  <div className="struct-team-head">
                    <span
                      className="hier-drag"
                      title="Drag to reorder"
                      aria-label={`Drag ${team.name} to reorder`}
                      role="button"
                      draggable
                      onDragStart={(event) => { event.stopPropagation(); setDragTeam(team.id); }}
                    ><GripVertical size={13} /></span>
                    <b>{team.name}</b>
                    <span className="struct-count">{membersOf(team).length}</span>
                    {editable ? (
                      <button type="button" className="struct-x struct-edit" title="Rename team" aria-label={`Rename ${team.name}`} onClick={() => renameTeam(team)}><Pencil size={12} /><span className="struct-edit-label">Rename</span></button>
                    ) : null}
                    {editable ? (
                      <button type="button" className="struct-x" title="Remove team" onClick={() => removeTeam(team)}><X size={13} /></button>
                    ) : null}
                  </div>
                  <div className="struct-field">
                    <span className="struct-label">Lead</span>
                    <Chips
                      ids={team.leadIds || []}
                      empty="No lead"
                      onRemove={editable ? (id) => setTeamField(team, "leadIds", (team.leadIds || []).filter((row) => row !== id)) : undefined}
                    />
                    {editable ? (
                      <AddPerson pool={pool} chosen={team.leadIds || []} label="Add lead" onAdd={(id) => setTeamField(team, "leadIds", [...(team.leadIds || []), id])} />
                    ) : null}
                  </div>
                  {(team.leadIds || []).filter(isKnown).map((leadId) => {
                    const managerIds = reportingFor(leadId);
                    return (
                      <div className="struct-reporting" key={`team-reporting-${team.id}-${leadId}`}>
                        <span className="struct-reporting-label"><small>Reports to</small><b>{nameOf(leadId)}</b></span>
                        <Chips
                          ids={managerIds}
                          empty="No line manager"
                          onRemove={editable ? (id) => setReporting(leadId, managerIds.filter((row) => row !== id)) : undefined}
                        />
                        {editable ? (
                          <AddPerson pool={pool.filter((row) => row.id !== leadId)} chosen={managerIds} label="Add manager" onAdd={(id) => setReporting(leadId, [...managerIds, id])} />
                        ) : null}
                      </div>
                    );
                  })}
                  <div className="struct-field">
                    <span className="struct-label">Members</span>
                    <Chips
                      ids={team.memberIds || []}
                      empty="Nobody yet"                      onReorder={editable ? (fromId, toId) => moveMember(team, fromId, toId) : undefined}
                      onRemove={editable ? (id) => setTeamField(team, "memberIds", (team.memberIds || []).filter((row) => row !== id)) : undefined}
                    />
                    {editable ? (
                      <AddPerson pool={pool} chosen={team.memberIds || []} label="Add member" onAdd={(id) => setTeamField(team, "memberIds", [...(team.memberIds || []), id])} />
                    ) : null}
                  </div>
                </div>
              ))}

              {editable ? (
                <button type="button" className="struct-addteam" onClick={() => addTeam(department.id)}><Plus size={14} /> Team</button>
              ) : null}
            </section>
          );
        })}
      </div>

      {isOrgAdmin(viewer) && additionalReportingPeople.length ? (
        <section className="struct-reporting-panel">
          <div className="struct-reporting-panel-head">
            <div><span className="struct-label">Line reporting</span><h3>Additional reporting lines</h3></div>
            <p>Assign operational or technical managers independently from team membership.</p>
          </div>
          <div className="struct-reporting-list">
            {additionalReportingPeople.map((person) => {
              const managerIds = reportingFor(person.id);
              return (
                <div className="struct-reporting-person" key={`person-reporting-${person.id}`}>
                  <span className="struct-reporting-label"><small>{person.department || "Unassigned"}</small><b>{person.name}</b></span>
                  <Chips ids={managerIds} empty="No line manager" onRemove={(id) => setReporting(person.id, managerIds.filter((row) => row !== id))} />
                  <AddPerson pool={active.filter((row) => row.id !== person.id)} chosen={managerIds} label="Add manager" onAdd={(id) => setReporting(person.id, [...managerIds, id])} />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {unassigned.length && isOrgAdmin(viewer) ? (
        <section className="struct-dep struct-unassigned">
          <header className="struct-dep-head">
            <span className="struct-dep-title">
              <b>Not on a team</b>
              <small>{unassigned.length} {unassigned.length === 1 ? "person" : "people"}</small>
            </span>
          </header>
          <Chips ids={unassigned.map((row) => row.id)} empty="Everyone is placed" />
        </section>
      ) : null}

      {departments.length === 0 ? (
        <p className="struct-empty">No departments to show yet.</p>
      ) : null}
    </div>
  );
}
