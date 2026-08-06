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

import { useMemo, useState } from "react";
import { useDialog } from "./Dialog";
import { GripVertical, Plus, X } from "lucide-react";
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
  const [dragDep, setDragDep] = useState("");
  const [overDep, setOverDep] = useState("");
  const [dragTeam, setDragTeam] = useState(""); const [dragPerson, setDragPerson] = useState("");
  const [overTeam, setOverTeam] = useState("");

  const chart = useMemo(() => effectiveOrg(users), [users, tick]);
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

  function save(next: OrgChart, message: string) {
    if (writeOrg(next)) {
      setTick((value) => value + 1);
      setNote(message);
      if (onSaved) onSaved();
    } else {
      setNote("Could not save. Reload and try again.");
    }
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
  async function removeTeam(team: Team) {
    if (!(await dialog.confirm("Remove " + team.name + "?"))) return;
    save({ ...chart, teams: chart.teams.filter((row) => row.id !== team.id) }, "Team removed.");
  }
  async function removeDepartment(department: Department) {
    if (!(await dialog.confirm("Remove " + department.name + " and its teams?"))) return;
    save({ departments: chart.departments.filter((row) => row.id !== department.id), teams: chart.teams.filter((row) => row.departmentId !== department.id) }, "Department removed.");
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

  function AddPerson({ pool, chosen, onAdd, label }: { pool: OrgUser[]; chosen: string[]; onAdd: (id: string) => void; label: string }) {
    const options = pool.filter((row) => chosen.indexOf(row.id) < 0);
    if (!options.length) return null;
    return (
      <select className="struct-select" value="" onChange={(event) => { if (event.target.value) onAdd(event.target.value); }}>
        <option value="">{label}</option>
        {options.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select>
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

      {note ? <p className="struct-note">{note}</p> : null}

      <div className="struct-grid">
        {departments.map((department) => {
          const editable = canEditDepartment(chart, viewer, department.id);
          const teams = chart.teams.filter(
            (team) => team.departmentId === department.id && (isOrgAdmin(viewer) || visibleTeamIds.has(team.id)),
          );
          const headcount = peopleIn(department).length;
          const pool = assignableTo(chart, viewer, users, department.id);
          return (
            <section
              className={"struct-dep" + (dragDep === department.id ? " is-dragging" : "") + (overDep === department.id ? " is-over" : "")}
              key={department.id}
              draggable
              onDragStart={() => setDragDep(department.id)}
              onDragEnd={() => { setDragDep(""); setOverDep(""); }}
              onDragOver={(event) => { event.preventDefault(); if (overDep !== department.id) setOverDep(department.id); }}
              onDrop={(event) => { event.preventDefault(); moveDepartment(dragDep, department.id); }}
            >
              <header className="struct-dep-head">
                <span className="hier-drag" title="Drag to reorder" aria-hidden="true"><GripVertical size={15} /></span>
                <span className="struct-dep-title">
                  <b>{department.name}</b>
                  <small>{teams.length} {teams.length === 1 ? "team" : "teams"} {"\u00b7"} {headcount} {headcount === 1 ? "person" : "people"}</small>
                </span>
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

              {teams.map((team) => (
                <div
                  className={"struct-team" + (dragTeam === team.id ? " is-dragging" : "") + (overTeam === team.id ? " is-over" : "")}
                  key={team.id}
                  draggable
                  onDragStart={(event) => { event.stopPropagation(); setDragTeam(team.id); }}
                  onDragEnd={() => { setDragTeam(""); setOverTeam(""); }}
                  onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); if (overTeam !== team.id) setOverTeam(team.id); }}
                  onDrop={(event) => { event.preventDefault(); event.stopPropagation(); moveTeam(dragTeam, team.id); }}
                >
                  <div className="struct-team-head">
                    <span className="hier-drag" title="Drag to reorder" aria-hidden="true"><GripVertical size={13} /></span>
                    <b>{team.name}</b>
                    <span className="struct-count">{membersOf(team).length}</span>
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
