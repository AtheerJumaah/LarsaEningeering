"use client";

/* The visual organization editor. People are reusable objects that can be
 * dragged into more than one role, while the matrix and person inspector make
 * overlapping assignments explicit and keyboard/touch accessible. */

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  Check,
  ChevronDown,
  Crown,
  Eye,
  EyeOff,
  GripVertical,
  LayoutGrid,
  Maximize2,
  Minus,
  Network,
  Pencil,
  Plus,
  Save,
  Search,
  TableProperties,
  Undo2,
  UserCog,
  X,
} from "lucide-react";
import { useDialog } from "./Dialog";
import { pushSyncedKeyNow } from "../lib/supabase/sync";
import {
  canCreateDepartments,
  canEditDepartment,
  effectiveOrg,
  isOrgAdmin,
  newId,
  teamsVisibleTo,
  writeOrg,
} from "../lib/org";
import type { Department, ExecutivePosition, OrgChart, OrgUser, Team } from "../lib/org";

type Structure2View = "chart" | "diagram" | "matrix";
type DropKind = "executive" | "head" | "lead" | "member";
type PeopleSort = "asc" | "desc";
type DiagramDragItem = { kind: "executive" | "department" | "team"; id: string };

const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const EXECUTIVE_TITLES = [
  { title: "Chief Executive Officer (CEO)", pattern: /\b(ceo|chief executive officer)\b/i },
  { title: "President", pattern: /^(?:(?!vice president).)*\bpresident\b/i },
  { title: "Chief Operating Officer (COO)", pattern: /\b(coo|chief operating officer)\b/i },
  { title: "Chief Financial Officer (CFO)", pattern: /\b(cfo|chief financial officer)\b/i },
  { title: "Chief Technology Officer (CTO)", pattern: /\b(cto|chief technology officer)\b/i },
  { title: "Chief Information Officer (CIO)", pattern: /\b(cio|chief information officer)\b/i },
  { title: "Chief Human Resources Officer (CHRO)", pattern: /\b(chro|chief human resources officer)\b/i },
  { title: "Chief People Officer", pattern: /\bchief people officer\b/i },
  { title: "Chief Product Officer", pattern: /\bchief product officer\b/i },
  { title: "Chief Marketing Officer (CMO)", pattern: /\b(cmo|chief marketing officer)\b/i },
  { title: "Chief Legal Officer (CLO)", pattern: /\b(clo|chief legal officer)\b/i },
  { title: "Chief Strategy Officer (CSO)", pattern: /\b(cso|chief strategy officer)\b/i },
  { title: "Managing Director", pattern: /\bmanaging director\b/i },
  { title: "Executive Vice President (EVP)", pattern: /\b(evp|executive vice president)\b/i },
  { title: "Senior Vice President (SVP)", pattern: /\b(svp|senior vice president)\b/i },
  { title: "Vice President (VP)", pattern: /\b(vp|vice president)\b/i },
] as const;

function inferredExecutivePositions(users: OrgUser[]): ExecutivePosition[] {
  return EXECUTIVE_TITLES.flatMap(({ title, pattern }, index) => {
    const personIds = users.filter((person) => pattern.test(String(person.role || ""))).map((person) => person.id);
    return personIds.length ? [{ id: `executive_inferred_${index}`, title, personIds }] : [];
  });
}

function initials(name: string): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function unique(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function reorderById<T extends { id: string }>(rows: T[], sourceId: string, targetId: string): T[] {
  if (!sourceId || sourceId === targetId) return rows;
  const sourceIndex = rows.findIndex((row) => row.id === sourceId);
  const targetIndex = rows.findIndex((row) => row.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return rows;
  const next = [...rows];
  [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
  return next;
}

function PeopleSortControl({ value, onChange }: { value: PeopleSort; onChange: (value: PeopleSort) => void }) {
  return (
    <span className="s2-sort-toggle" role="group" aria-label="Sort people by first name">
      <button type="button" aria-pressed={value === "asc"} className={value === "asc" ? "active" : ""} onClick={() => onChange("asc")}>A–Z</button>
      <button type="button" aria-pressed={value === "desc"} className={value === "desc" ? "active" : ""} onClick={() => onChange("desc")}>Z–A</button>
    </span>
  );
}

function PersonToken({ person, removable, onOpen, onRemove }: {
  person: OrgUser;
  removable?: boolean;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  return (
    <span className="s2-person-token">
      <button type="button" className="s2-person-open" onClick={onOpen} title={`Open ${person.name}`}>
        <span>{initials(String(person.name || ""))}</span><b>{person.name}</b>
      </button>
      {removable ? <button type="button" className="s2-person-remove" aria-label={`Remove ${person.name}`} onClick={onRemove}><X size={12} /></button> : null}
    </span>
  );
}

function DiagramPeople({ people, namesVisible, emptyLabel, onOpen }: {
  people: OrgUser[];
  namesVisible: boolean;
  emptyLabel: string;
  onOpen: (personId: string) => void;
}) {
  if (!people.length) return <span className="s2-diagram-empty">{emptyLabel}</span>;
  if (!namesVisible) return <span className="s2-diagram-count">{people.length} {people.length === 1 ? "person" : "people"}</span>;
  return <div className="s2-diagram-people">{people.map((person) => <button type="button" key={person.id} onClick={() => onOpen(person.id)} title={`Open ${person.name}`}><span>{initials(String(person.name || ""))}</span><b>{person.name}</b></button>)}</div>;
}

function PeoplePicker({ title, people, assignedIds, onSelect, onClose }: {
  title: string;
  people: OrgUser[];
  assignedIds: string[];
  onSelect: (personId: string) => void;
  onClose: () => void;
}) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PeopleSort>("asc");
  const assigned = useMemo(() => new Set(assignedIds), [assignedIds]);
  const visiblePeople = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...people]
      .filter((person) => !needle || [person.name, person.role, person.department]
        .some((value) => String(value || "").toLowerCase().includes(needle)))
      .sort((left, right) => {
        const compared = NAME_COLLATOR.compare(String(left.name || ""), String(right.name || ""));
        return sort === "asc" ? compared : -compared;
      });
  }, [people, query, sort]);

  useEffect(() => {
    searchRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="s2-picker-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="s2-picker" role="dialog" aria-modal="true" aria-labelledby="s2-picker-title">
        <header><div><span className="eyebrow">People directory</span><h3 id="s2-picker-title">{title}</h3><p>Search or browse every active employee, then select one name.</p></div><button type="button" aria-label="Close people directory" onClick={onClose}><X size={17} /></button></header>
        <div className="s2-picker-tools">
          <label className="s2-search"><Search size={15} /><input ref={searchRef} type="search" aria-label="Search all people" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, role, or department" /></label>
          <PeopleSortControl value={sort} onChange={setSort} />
          <span>{visiblePeople.length} of {people.length} names</span>
        </div>
        <div className="s2-picker-list" aria-label={`All people sorted ${sort === "asc" ? "A to Z" : "Z to A"}`}>
          {visiblePeople.map((person) => {
            const isAssigned = assigned.has(person.id);
            return <button type="button" key={person.id} disabled={isAssigned} aria-label={`${isAssigned ? "Already assigned" : "Select"} ${person.name}`} onClick={() => { onSelect(person.id); onClose(); }}>
              <span className="s2-avatar large">{initials(String(person.name || ""))}</span>
              <span><b>{person.name}</b><small>{person.role || person.department || "Employee"}</small></span>
              {isAssigned ? <i><Check size={13} /> Assigned</i> : <i>Select</i>}
            </button>;
          })}
          {!visiblePeople.length ? <p className="s2-picker-empty">No names match this search.</p> : null}
        </div>
      </section>
    </div>
  );
}

function DropZone({ kind, targetId, label, people, directoryPeople, editable, activeTarget, draggedPersonId, onTarget, onAccept, onRemove, onOpen }: {
  kind: DropKind;
  targetId: string;
  label: string;
  people: OrgUser[];
  editable: boolean;
  activeTarget: string;
  draggedPersonId: string;
  onTarget: (target: string) => void;
  onAccept: (kind: DropKind, targetId: string, personId: string) => void;
  onRemove: (personId: string) => void;
  onOpen: (personId: string) => void;
  directoryPeople: OrgUser[];
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const key = `${kind}:${targetId}`;
  return (
    <><div
      className={`s2-dropzone${activeTarget === key ? " is-over" : ""}`}
      onDragEnter={(event) => { if (editable && (draggedPersonId || event.dataTransfer.types.includes("application/x-larsa-person"))) { event.preventDefault(); onTarget(key); } }}
      onDragOver={(event) => { if (editable && (draggedPersonId || event.dataTransfer.types.includes("application/x-larsa-person"))) event.preventDefault(); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) onTarget(""); }}
      onDrop={(event) => { event.preventDefault(); if (editable) onAccept(kind, targetId, event.dataTransfer.getData("application/x-larsa-person") || draggedPersonId); }}
    >
      <span className="s2-drop-label">{label}<small>{editable ? "Drop a person here" : "Assigned people"}</small></span>
      <div className="s2-token-row">
        {people.map((person) => <PersonToken key={person.id} person={person} removable={editable} onOpen={() => onOpen(person.id)} onRemove={() => onRemove(person.id)} />)}
        {!people.length ? <span className="s2-empty">None yet</span> : null}
        {editable ? <button type="button" className="s2-pick-person" onClick={() => setPickerOpen(true)}><Plus size={12} /> Choose person</button> : null}
      </div>
    </div>{pickerOpen ? <PeoplePicker title={`Choose ${label.toLowerCase()}`} people={directoryPeople} assignedIds={people.map((person) => person.id)} onSelect={(personId) => onAccept(kind, targetId, personId)} onClose={() => setPickerOpen(false)} /> : null}</>
  );
}

function ExecutiveReportingEditor({ position, positions, editable, labelFor, canReportTo, onAddParent, onRemoveParent, onAddChild, onRemoveChild }: {
  position: ExecutivePosition;
  positions: ExecutivePosition[];
  editable: boolean;
  labelFor: (position: ExecutivePosition) => string;
  canReportTo: (positionId: string, managerPositionId: string) => boolean;
  onAddParent: (positionId: string, managerPositionId: string) => void;
  onRemoveParent: (positionId: string, managerPositionId: string) => void;
  onAddChild: (managerPositionId: string, childPositionId: string) => void;
  onRemoveChild: (managerPositionId: string, childPositionId: string) => void;
}) {
  const parentIds = unique(position.reportsToPositionIds || []);
  const parents = positions.filter((candidate) => parentIds.includes(candidate.id));
  const children = positions.filter((candidate) => (candidate.reportsToPositionIds || []).includes(position.id));
  const parentCandidates = positions.filter((candidate) => !parentIds.includes(candidate.id) && canReportTo(position.id, candidate.id));
  const childCandidates = positions.filter((candidate) => !children.some((child) => child.id === candidate.id) && canReportTo(candidate.id, position.id));

  return (
    <details className="s2-executive-reporting">
      <summary><span>Reporting lines</span><small>{parents.length} reports to · {children.length} direct</small></summary>
      <div className="s2-executive-report-grid">
        <section>
          <b>Reports to</b>
          <p>Position(s) above this role</p>
          <div className="s2-position-links">
            {parents.map((parent) => <span key={parent.id}>{labelFor(parent)}{editable ? <button type="button" aria-label={`Remove ${position.title} reporting to ${parent.title}`} onClick={() => onRemoveParent(position.id, parent.id)}><X size={11} /></button> : null}</span>)}
            {!parents.length ? <i>No executive manager assigned</i> : null}
          </div>
          {editable ? <select aria-label={`Add who ${position.title} reports to`} defaultValue="" disabled={!parentCandidates.length} onChange={(event) => { const id = event.target.value; event.target.value = ""; if (id) onAddParent(position.id, id); }}><option value="">{parentCandidates.length ? "Choose a manager position…" : "No available position"}</option>{parentCandidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{labelFor(candidate)}</option>)}</select> : null}
        </section>
        <section>
          <b>Direct reports</b>
          <p>Position(s) reporting to this role</p>
          <div className="s2-position-links">
            {children.map((child) => <span key={child.id}>{labelFor(child)}{editable ? <button type="button" aria-label={`Remove ${child.title} reporting to ${position.title}`} onClick={() => onRemoveChild(position.id, child.id)}><X size={11} /></button> : null}</span>)}
            {!children.length ? <i>No direct-report position assigned</i> : null}
          </div>
          {editable ? <select aria-label={`Add who reports to ${position.title}`} defaultValue="" disabled={!childCandidates.length} onChange={(event) => { const id = event.target.value; event.target.value = ""; if (id) onAddChild(position.id, id); }}><option value="">{childCandidates.length ? "Choose a direct-report position…" : "No available position"}</option>{childCandidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{labelFor(candidate)}</option>)}</select> : null}
        </section>
      </div>
    </details>
  );
}

export function OrgStructure2({
  viewer,
  users,
  onSaved,
}: {
  viewer: OrgUser | null;
  users: OrgUser[];
  onSaved?: () => void;
}) {
  const dialog = useDialog();
  const structureRef = useRef<HTMLDivElement | null>(null);
  const diagramScrollRef = useRef<HTMLDivElement | null>(null);
  const diagramPanRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const dragPointerYRef = useRef<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<OrgChart | null>(null);
  const [view, setView] = useState<Structure2View>("chart");
  const [diagramNamesVisible, setDiagramNamesVisible] = useState(true);
  const [diagramZoom, setDiagramZoom] = useState(1);
  const [diagramPanning, setDiagramPanning] = useState(false);
  const [search, setSearch] = useState("");
  const [peopleSort, setPeopleSort] = useState<PeopleSort>("asc");
  const [peopleOpen, setPeopleOpen] = useState(true);
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [dragPersonId, setDragPersonId] = useState("");
  const [dragTeamId, setDragTeamId] = useState("");
  const [dragDepartmentId, setDragDepartmentId] = useState("");
  const [diagramDragItem, setDiagramDragItem] = useState<DiagramDragItem | null>(null);
  const [diagramDropTarget, setDiagramDropTarget] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [managerChoice, setManagerChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  /* Native drag-and-drop does not scroll the app shell reliably. Track only
     the transient pointer position in a ref, then move the real .native
     scroller in animation frames while the pointer rests near an edge. No
     React state changes happen in the loop, so a long drag stays responsive. */
  useEffect(() => {
    if (!dragPersonId && !dragTeamId && !dragDepartmentId && !diagramDragItem) return;
    const surface = structureRef.current?.closest<HTMLElement>(".native");
    if (!surface) return;
    let frame = 0;
    const trackPointer = (event: DragEvent) => { dragPointerYRef.current = event.clientY; };
    const clearPointer = () => { dragPointerYRef.current = null; };
    const scrollAtEdge = () => {
      const pointerY = dragPointerYRef.current;
      if (pointerY !== null) {
        const rect = surface.getBoundingClientRect();
        const top = Math.max(0, rect.top);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        const height = Math.max(1, bottom - top);
        const edge = Math.min(150, Math.max(72, height * 0.18));
        let speed = 0;
        if (pointerY < top + edge) speed = -Math.ceil(4 + 22 * (top + edge - pointerY) / edge);
        else if (pointerY > bottom - edge) speed = Math.ceil(4 + 22 * (pointerY - (bottom - edge)) / edge);
        if (speed) surface.scrollTop += speed;
      }
      frame = window.requestAnimationFrame(scrollAtEdge);
    };
    document.addEventListener("dragover", trackPointer);
    document.addEventListener("drop", clearPointer);
    document.addEventListener("dragend", clearPointer);
    frame = window.requestAnimationFrame(scrollAtEdge);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("dragover", trackPointer);
      document.removeEventListener("drop", clearPointer);
      document.removeEventListener("dragend", clearPointer);
      dragPointerYRef.current = null;
    };
  }, [dragDepartmentId, dragPersonId, dragTeamId, diagramDragItem]);

  const savedChart = useMemo(() => effectiveOrg(users), [users, revision]);
  const chart = draft || savedChart;
  const active = useMemo(() => users.filter((row) => row.enabled !== false && String(row.name || "").trim()), [users]);
  const byId = useMemo(() => new Map(active.map((row) => [row.id, row])), [active]);
  const visibleTeams = teamsVisibleTo(chart, viewer);
  const visibleTeamIds = new Set(visibleTeams.map((row) => row.id));
  const departments = chart.departments.filter(
    (department) => isOrgAdmin(viewer) || visibleTeams.some((team) => team.departmentId === department.id),
  );
  const selectedPerson = byId.get(selectedPersonId) || null;
  const executivePositions = useMemo(
    () => chart.executivePositions || inferredExecutivePositions(active),
    [active, chart.executivePositions],
  );
  const executiveById = useMemo(() => new Map(executivePositions.map((position) => [position.id, position])), [executivePositions]);
  const sortedActive = useMemo(() => [...active].sort((left, right) => {
    const compared = NAME_COLLATOR.compare(String(left.name || ""), String(right.name || ""));
    return peopleSort === "asc" ? compared : -compared;
  }), [active, peopleSort]);
  const filteredPeople = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sortedActive.filter((person) => !needle || [person.name, person.role, person.department]
      .some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [search, sortedActive]);

  function nameOf(id: string): string {
    return String(byId.get(id)?.name || "").trim();
  }

  function departmentTeams(departmentId: string): Team[] {
    return chart.teams.filter((team) => team.departmentId === departmentId && (isOrgAdmin(viewer) || visibleTeamIds.has(team.id)));
  }

  function teamPeople(team: Team): string[] {
    return unique([...(team.leadIds || []), ...(team.memberIds || [])]).filter((id) => byId.has(id));
  }

  function peopleFor(ids: string[]): OrgUser[] {
    return ids.map((id) => byId.get(id)).filter((person): person is OrgUser => Boolean(person));
  }

  function executivePositionLabel(position: ExecutivePosition): string {
    const holders = peopleFor(position.personIds || []).map((person) => String(person.name || "").trim()).filter(Boolean);
    return holders.length ? `${position.title} — ${holders.join(", ")}` : position.title;
  }

  function executiveParents(position: ExecutivePosition): ExecutivePosition[] {
    return unique(position.reportsToPositionIds || []).map((id) => executiveById.get(id)).filter((row): row is ExecutivePosition => Boolean(row));
  }

  function executiveChildren(positionId: string): ExecutivePosition[] {
    return executivePositions.filter((position) => (position.reportsToPositionIds || []).includes(positionId));
  }

  function canExecutiveReportTo(positionId: string, managerPositionId: string): boolean {
    if (!positionId || !managerPositionId || positionId === managerPositionId || !executiveById.has(positionId) || !executiveById.has(managerPositionId)) return false;
    const pending = [managerPositionId];
    const visited = new Set<string>();
    while (pending.length) {
      const currentId = pending.pop() || "";
      if (currentId === positionId) return false;
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);
      pending.push(...(executiveById.get(currentId)?.reportsToPositionIds || []));
    }
    return true;
  }

  function setExecutiveParents(positionId: string, parentIds: string[], message: string) {
    const validParents = unique(parentIds).filter((parentId) => canExecutiveReportTo(positionId, parentId));
    editExecutivePositions(
      executivePositions.map((position) => position.id === positionId ? { ...position, reportsToPositionIds: validParents } : position),
      message,
    );
  }

  function addExecutiveParent(positionId: string, parentId: string) {
    const position = executiveById.get(positionId);
    const parent = executiveById.get(parentId);
    if (!position || !parent || !canExecutiveReportTo(positionId, parentId)) return;
    setExecutiveParents(positionId, [...(position.reportsToPositionIds || []), parentId], `${position.title} now reports to ${parent.title}.`);
  }

  function removeExecutiveParent(positionId: string, parentId: string) {
    const position = executiveById.get(positionId);
    const parent = executiveById.get(parentId);
    if (!position || !parent) return;
    setExecutiveParents(positionId, (position.reportsToPositionIds || []).filter((id) => id !== parentId), `${position.title} no longer reports to ${parent.title}.`);
  }

  const placedIds = new Set(chart.teams.flatMap(teamPeople));
  const unassignedCount = active.filter((person) => !placedIds.has(person.id)).length;

  function reportingFor(personId: string): string[] {
    if (chart.reporting && Object.prototype.hasOwnProperty.call(chart.reporting, personId)) {
      return unique(chart.reporting[personId] || []).filter((id) => id !== personId && byId.has(id));
    }
    const person = byId.get(personId);
    const named = String(person?.manager || "").trim().toLowerCase();
    if (!named) return [];
    const manager = active.find((row) => row.id.toLowerCase() === named || String(row.name || "").trim().toLowerCase() === named);
    return manager && manager.id !== personId ? [manager.id] : [];
  }

  function rolesFor(personId: string): { label: string; tone: "executive" | "head" | "lead" | "member" }[] {
    const roles: { label: string; tone: "executive" | "head" | "lead" | "member" }[] = [];
    executivePositions.forEach((position) => {
      if ((position.personIds || []).includes(personId)) roles.push({ label: position.title, tone: "executive" });
    });
    chart.departments.forEach((department) => {
      if ((department.headIds || []).includes(personId)) roles.push({ label: `Head · ${department.name}`, tone: "head" });
    });
    chart.teams.forEach((team) => {
      if ((team.leadIds || []).includes(personId)) roles.push({ label: `Lead · ${team.name}`, tone: "lead" });
      if ((team.memberIds || []).includes(personId)) roles.push({ label: team.name, tone: "member" });
    });
    return roles;
  }

  function stage(next: OrgChart, message: string) {
    setDraft(next);
    setNote(`${message} Review it, then choose Save changes.`);
  }

  async function commitChanges() {
    if (!draft || saving) return;
    if (!writeOrg(draft)) {
      setNote("Could not save the organization. Reload and try again.");
      return;
    }
    setSaving(true);
    setNote("Saving organization changes to the company server…");
    try {
      const synced = await pushSyncedKeyNow("larsaStaffV8");
      if (!synced) {
        setNote("The change is on this device, but the company server has not confirmed it. Keep the app open and try Save changes again.");
        return;
      }
      setDraft(null);
      setRevision((value) => value + 1);
      setNote("Organization changes saved to the company server.");
      onSaved?.();
    } catch (error) {
      console.error("[structure-2] save was not confirmed:", error);
      setNote("The change is on this device, but the company server did not confirm it. Keep the app open and try again.");
    } finally {
      setSaving(false);
    }
  }

  function discardChanges() {
    setDraft(null);
    setNote("Unsaved organization changes discarded.");
  }

  function editDepartment(departmentId: string, update: (department: Department) => Department, message: string) {
    stage({ ...chart, departments: chart.departments.map((department) => department.id === departmentId ? update(department) : department) }, message);
  }

  function editTeam(teamId: string, update: (team: Team) => Team, message: string) {
    stage({ ...chart, teams: chart.teams.map((team) => team.id === teamId ? update(team) : team) }, message);
  }

  function editExecutivePositions(next: ExecutivePosition[], message: string) {
    stage({ ...chart, executivePositions: next }, message);
  }

  function toggleExecutive(position: ExecutivePosition, personId: string, checked: boolean) {
    const personIds = checked
      ? unique([...(position.personIds || []), personId])
      : (position.personIds || []).filter((id) => id !== personId);
    editExecutivePositions(
      executivePositions.map((row) => row.id === position.id ? { ...row, personIds } : row),
      checked ? "Executive position assigned." : "Executive position removed.",
    );
  }

  function toggleHead(department: Department, personId: string, checked: boolean) {
    const ids = checked ? unique([...(department.headIds || []), personId]) : (department.headIds || []).filter((id) => id !== personId);
    editDepartment(department.id, (row) => ({ ...row, headIds: ids }), checked ? "Department-head role added." : "Department-head role removed.");
  }

  function toggleTeamRole(team: Team, field: "leadIds" | "memberIds", personId: string, checked: boolean) {
    const ids = checked ? unique([...(team[field] || []), personId]) : (team[field] || []).filter((id) => id !== personId);
    editTeam(team.id, (row) => ({ ...row, [field]: ids }), checked ? "Team assignment added." : "Team assignment removed.");
  }

  function setReporting(personId: string, managerIds: string[]) {
    const reporting = { ...(chart.reporting || {}), [personId]: unique(managerIds).filter((id) => id !== personId && byId.has(id)) };
    stage({ ...chart, reporting }, "Reporting line updated.");
  }

  function acceptPerson(kind: DropKind, targetId: string, personId: string) {
    if (!personId) return;
    if (kind === "executive") {
      const position = executivePositions.find((row) => row.id === targetId);
      if (position && isOrgAdmin(viewer)) toggleExecutive(position, personId, true);
    } else if (kind === "head") {
      const department = chart.departments.find((row) => row.id === targetId);
      if (department && canEditDepartment(chart, viewer, department.id, users)) toggleHead(department, personId, true);
    } else {
      const team = chart.teams.find((row) => row.id === targetId);
      if (team && canEditDepartment(chart, viewer, team.departmentId, users)) {
        toggleTeamRole(team, kind === "lead" ? "leadIds" : "memberIds", personId, true);
      }
    }
    setDragPersonId("");
    setDropTarget("");
  }

  function removePersonRole(kind: DropKind, targetId: string, personId: string) {
    if (kind === "executive") {
      const position = executivePositions.find((row) => row.id === targetId);
      if (position) toggleExecutive(position, personId, false);
      return;
    }
    if (kind === "head") {
      const department = chart.departments.find((row) => row.id === targetId);
      if (department) toggleHead(department, personId, false);
      return;
    }
    const team = chart.teams.find((row) => row.id === targetId);
    if (team) toggleTeamRole(team, kind === "lead" ? "leadIds" : "memberIds", personId, false);
  }

  function moveTeam(teamId: string, departmentId: string) {
    const team = chart.teams.find((row) => row.id === teamId);
    if (!team || team.departmentId === departmentId) return;
    if (!canEditDepartment(chart, viewer, team.departmentId, users) || !canEditDepartment(chart, viewer, departmentId, users)) return;
    editTeam(team.id, (row) => ({ ...row, departmentId }), `Moved ${team.name} to another department.`);
    setDragTeamId("");
    setDropTarget("");
  }

  function clearDiagramDrag() {
    setDiagramDragItem(null);
    setDiagramDropTarget("");
  }

  function startDiagramDrag(event: ReactDragEvent<HTMLElement>, item: DiagramDragItem) {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-larsa-organization", JSON.stringify(item));
    setDiagramDragItem(item);
    setDiagramDropTarget("");
  }

  function reorderExecutive(sourceId: string, targetId: string) {
    if (!isOrgAdmin(viewer)) return;
    editExecutivePositions(reorderById(executivePositions, sourceId, targetId), "Executive positions reordered.");
  }

  function reorderDepartment(sourceId: string, targetId: string) {
    if (!isOrgAdmin(viewer)) return;
    stage({ ...chart, departments: reorderById(chart.departments, sourceId, targetId) }, "Departments reordered.");
  }

  function reorderTeam(sourceId: string, targetId: string) {
    const source = chart.teams.find((team) => team.id === sourceId);
    const target = chart.teams.find((team) => team.id === targetId);
    if (!source || !target || source.id === target.id) return;
    if (!canEditDepartment(chart, viewer, source.departmentId, users) || !canEditDepartment(chart, viewer, target.departmentId, users)) return;
    if (source.departmentId === target.departmentId) {
      stage({ ...chart, teams: reorderById(chart.teams, sourceId, targetId) }, "Teams reordered.");
      return;
    }
    const moved = { ...source, departmentId: target.departmentId };
    const next = chart.teams.filter((team) => team.id !== source.id);
    const targetIndex = next.findIndex((team) => team.id === target.id);
    next.splice(Math.max(0, targetIndex), 0, moved);
    stage({ ...chart, teams: next }, source.departmentId === target.departmentId ? "Teams reordered." : `Moved ${source.name} to ${chart.departments.find((department) => department.id === target.departmentId)?.name || "another department"}.`);
  }

  function acceptDiagramDrop(kind: DiagramDragItem["kind"], targetId: string) {
    const item = diagramDragItem;
    if (!item || item.kind !== kind) return;
    if (kind === "executive") reorderExecutive(item.id, targetId);
    if (kind === "department") reorderDepartment(item.id, targetId);
    if (kind === "team") reorderTeam(item.id, targetId);
    clearDiagramDrag();
  }

  function beginDiagramPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, .s2-diagram-node, .s2-diagram-move")) return;
    const surface = diagramScrollRef.current;
    if (!surface) return;
    diagramPanRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: surface.scrollLeft, top: surface.scrollTop };
    surface.setPointerCapture(event.pointerId);
    setDiagramPanning(true);
  }

  function moveDiagramPan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = diagramPanRef.current;
    const surface = diagramScrollRef.current;
    if (!pan || !surface || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    surface.scrollLeft = pan.left - (event.clientX - pan.x);
    surface.scrollTop = pan.top - (event.clientY - pan.y);
  }

  function endDiagramPan(event: ReactPointerEvent<HTMLDivElement>) {
    const surface = diagramScrollRef.current;
    if (diagramPanRef.current?.pointerId === event.pointerId) {
      if (surface?.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      diagramPanRef.current = null;
      setDiagramPanning(false);
    }
  }

  function changeDiagramZoom(amount: number) {
    setDiagramZoom((current) => Math.min(1.5, Math.max(.6, Math.round((current + amount) * 10) / 10)));
  }

  function resetDiagramView() {
    setDiagramZoom(1);
    diagramScrollRef.current?.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  }

  function fitDiagramView() {
    const surface = diagramScrollRef.current;
    const diagram = surface?.querySelector<HTMLElement>(".s2-diagram");
    if (!surface || !diagram) return;
    const naturalWidth = Math.max(1, diagram.getBoundingClientRect().width / diagramZoom);
    const fitted = Math.min(1, Math.max(.6, Math.floor(((surface.clientWidth - 28) / naturalWidth) * 10) / 10));
    setDiagramZoom(fitted);
    surface.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  }

  async function addDepartment() {
    const value = await dialog.prompt({ title: "New department", message: "Name the department shown in the Organization Chart.", placeholder: "Department name", confirmLabel: "Create department" });
    const name = String(value || "").trim();
    if (!name) return;
    stage({ ...chart, departments: [...chart.departments, { id: newId("dep"), name, headIds: [] }] }, "Department created.");
  }

  async function addExecutivePosition() {
    const value = await dialog.prompt({ title: "New executive position", message: "Add any company-level leadership position needed in the Organization Chart.", placeholder: "CEO, President, COO, VP…", confirmLabel: "Add position" });
    const title = String(value || "").trim();
    if (!title) return;
    editExecutivePositions([...executivePositions, { id: newId("executive"), title, personIds: [], reportsToPositionIds: [] }], "Executive position created.");
  }

  async function renameExecutivePosition(position: ExecutivePosition) {
    const value = await dialog.prompt({ title: "Rename executive position", message: "Choose the leadership title shown in the Organization Chart.", defaultValue: position.title, placeholder: "Executive position", confirmLabel: "Apply title" });
    const title = String(value || "").trim();
    if (title && title !== position.title) {
      editExecutivePositions(executivePositions.map((row) => row.id === position.id ? { ...row, title } : row), "Executive position renamed.");
    }
  }

  async function removeExecutivePosition(position: ExecutivePosition) {
    if (!(await dialog.confirm(`Remove ${position.title}? People keep their department and team assignments.`))) return;
    stage({
      ...chart,
      executivePositions: executivePositions
        .filter((row) => row.id !== position.id)
        .map((row) => ({
          ...row,
          reportsToPositionIds: (row.reportsToPositionIds || []).filter((id) => id !== position.id),
        })),
      removedExecutivePositionIds: unique([...(chart.removedExecutivePositionIds || []), position.id]),
    }, "Executive position removed.");
  }

  async function addTeam(departmentId: string) {
    const value = await dialog.prompt({ title: "New team", message: "Create a team inside this department.", placeholder: "Team name", confirmLabel: "Create team" });
    const name = String(value || "").trim();
    if (!name) return;
    stage({ ...chart, teams: [...chart.teams, { id: newId("team"), departmentId, name, leadIds: [], memberIds: [] }] }, "Team created.");
  }

  async function renameDepartment(department: Department) {
    const value = await dialog.prompt({ title: "Rename department", message: "Choose the department name shown in the Organization Chart.", defaultValue: department.name, placeholder: "Department name", confirmLabel: "Apply name" });
    const name = String(value || "").trim();
    if (name && name !== department.name) editDepartment(department.id, (row) => ({ ...row, name }), "Department renamed.");
  }

  async function renameTeam(team: Team) {
    const value = await dialog.prompt({ title: "Rename team", message: "Choose the team name shown in the Organization Chart.", defaultValue: team.name, placeholder: "Team name", confirmLabel: "Apply name" });
    const name = String(value || "").trim();
    if (name && name !== team.name) editTeam(team.id, (row) => ({ ...row, name }), "Team renamed.");
  }

  async function removeTeam(team: Team) {
    if (!(await dialog.confirm(`Remove ${team.name}? People keep their other assignments.`))) return;
    stage({ ...chart, teams: chart.teams.filter((row) => row.id !== team.id), removedTeamIds: unique([...(chart.removedTeamIds || []), team.id]) }, "Team removed.");
  }

  return (
    <div ref={structureRef} className={`structure2${dragPersonId || dragTeamId || dragDepartmentId || diagramDragItem ? " is-dragging" : ""}`}>
      <div className="s2-scroll-cue top" aria-hidden="true">Move up</div>
      <div className="s2-scroll-cue bottom" aria-hidden="true">Move down</div>
      <section className="s2-intro">
        <div>
          <span className="eyebrow"><Network size={14} /> Organization chart</span>
          <h3>Build the organization visually</h3>
          <p>Drag the same person into several teams or leadership roles. Use Matrix to audit every overlapping assignment.</p>
        </div>
        <div className="s2-view-toggle" role="tablist" aria-label="Organization chart views">
          <button type="button" role="tab" aria-selected={view === "chart"} className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}><LayoutGrid size={15} /> Build chart</button>
          <button type="button" role="tab" aria-selected={view === "diagram"} className={view === "diagram" ? "active" : ""} onClick={() => setView("diagram")}><Network size={15} /> Visual chart</button>
          <button type="button" role="tab" aria-selected={view === "matrix"} className={view === "matrix" ? "active" : ""} onClick={() => setView("matrix")}><TableProperties size={15} /> Matrix</button>
        </div>
      </section>

      <section className="s2-stats">
        <span><small>Departments</small><b>{departments.length}</b></span>
        <span><small>Teams</small><b>{visibleTeams.length}</b></span>
        <span><small>People</small><b>{active.length}</b></span>
        <span><small>Not on a team</small><b>{unassignedCount}</b></span>
        {canCreateDepartments(viewer) ? <button type="button" className="org-add" onClick={addDepartment}><Plus size={15} /> Department</button> : null}
      </section>

      <div className={`s2-savebar${draft ? " is-dirty" : ""}`} role="status">
        <span><i />{saving ? "Saving to company server" : draft ? "Unsaved organization changes" : "Organization chart is synchronized"}</span>
        <p>{draft ? "Nothing changes for other users until Save changes succeeds." : "This is the saved company organization."}</p>
        <button type="button" className="struct-discard" disabled={!draft || saving} onClick={discardChanges}><Undo2 size={14} /> Discard</button>
        <button type="button" className="struct-save" disabled={!draft || saving} onClick={commitChanges}><Save size={15} /> {saving ? "Saving…" : "Save changes"}</button>
      </div>
      {note ? <p className="s2-note">{note}</p> : null}

      {view === "chart" ? (
        <>
          <section className="s2-executive-board">
            <header>
              <div><span className="eyebrow"><Crown size={13} /> Company leadership</span><h4>Executive positions</h4><p>Place CEO, President, COO, VP, or any custom leadership position above the department structure.</p></div>
              {isOrgAdmin(viewer) ? <button type="button" className="org-add" onClick={addExecutivePosition}><Plus size={14} /> Executive position</button> : null}
            </header>
            <div className="s2-executive-grid">
              {executivePositions.map((position) => (
                <article
                  className={`s2-executive-position${diagramDropTarget === `build-executive:${position.id}` ? " is-over" : ""}`}
                  key={position.id}
                  onDragOver={(event) => { if (diagramDragItem?.kind === "executive" && isOrgAdmin(viewer)) { event.preventDefault(); setDiagramDropTarget(`build-executive:${position.id}`); } }}
                  onDrop={(event) => { event.preventDefault(); acceptDiagramDrop("executive", position.id); }}
                >
                  <header>{isOrgAdmin(viewer) ? <span className="s2-card-drag" draggable aria-label={`Move executive position ${position.title}`} title="Drag to reorder this position" onDragStart={(event) => startDiagramDrag(event, { kind: "executive", id: position.id })} onDragEnd={clearDiagramDrag}><GripVertical size={15} /></span> : null}<div><small>Executive position</small><b>{position.title}</b></div>{isOrgAdmin(viewer) ? <span className="s2-card-actions"><button type="button" aria-label={`Rename ${position.title}`} onClick={() => renameExecutivePosition(position)}><Pencil size={12} /></button><button type="button" aria-label={`Remove ${position.title}`} onClick={() => removeExecutivePosition(position)}><X size={13} /></button></span> : null}</header>
                  <DropZone kind="executive" targetId={position.id} label="Position holder" people={peopleFor(position.personIds || [])} directoryPeople={sortedActive} editable={isOrgAdmin(viewer)} activeTarget={dropTarget} draggedPersonId={dragPersonId} onTarget={setDropTarget} onAccept={acceptPerson} onRemove={(personId) => removePersonRole("executive", position.id, personId)} onOpen={setSelectedPersonId} />
                  <ExecutiveReportingEditor
                    position={position}
                    positions={executivePositions}
                    editable={isOrgAdmin(viewer)}
                    labelFor={executivePositionLabel}
                    canReportTo={canExecutiveReportTo}
                    onAddParent={addExecutiveParent}
                    onRemoveParent={removeExecutiveParent}
                    onAddChild={(managerPositionId, childPositionId) => addExecutiveParent(childPositionId, managerPositionId)}
                    onRemoveChild={(managerPositionId, childPositionId) => removeExecutiveParent(childPositionId, managerPositionId)}
                  />
                </article>
              ))}
              {!executivePositions.length ? <div className="s2-executive-empty"><Crown size={22} /><span><b>No executive positions yet</b><small>Add only the company-level positions your organization needs.</small></span>{isOrgAdmin(viewer) ? <button type="button" onClick={addExecutivePosition}><Plus size={14} /> Add position</button> : null}</div> : null}
            </div>
          </section>

          <div className="s2-workspace">
          <aside className="s2-people-palette">
            <header><div><span className="eyebrow">People</span><h4>People directory</h4><p>Click a name to review it, or drag it to assign it</p></div><span>{active.length}</span></header>
            <button type="button" className="s2-directory-toggle" aria-expanded={peopleOpen} onClick={() => setPeopleOpen((open) => !open)}><span>{peopleOpen ? "Hide names" : `Show all ${active.length} names`}</span><ChevronDown size={15} /></button>
            {peopleOpen ? <>
              <label className="s2-search"><Search size={15} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people" /></label>
              <div className="s2-palette-tools"><span className="s2-sort-label">First name</span><PeopleSortControl value={peopleSort} onChange={setPeopleSort} /><small>{filteredPeople.length} shown</small></div>
              <div className="s2-palette-list" aria-label={`People sorted ${peopleSort === "asc" ? "A to Z" : "Z to A"}`}>
              {filteredPeople.map((person) => {
                const roles = rolesFor(person.id);
                return (
                  <button
                    type="button"
                    className="s2-palette-person"
                    key={person.id}
                    draggable
                    onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-larsa-person", person.id); setDragPersonId(person.id); }}
                    onDragEnd={() => { setDragPersonId(""); setDropTarget(""); }}
                    onClick={() => setSelectedPersonId(person.id)}
                  >
                    <GripVertical size={14} className="s2-grip" />
                    <span className="s2-avatar">{initials(String(person.name || ""))}</span>
                    <span className="s2-palette-copy"><b>{person.name}</b><small>{person.role || person.department || "Employee"}</small></span>
                    <span className="s2-role-count">{roles.length}</span>
                  </button>
                );
              })}
              {!filteredPeople.length ? <p className="s2-palette-empty">No names match this search.</p> : null}
              </div>
            </> : <p className="s2-palette-collapsed">The directory is collapsed. Open it to search, sort, or drag a person.</p>}
          </aside>

          <div className="s2-canvas">
            {departments.map((department) => {
              const editable = canEditDepartment(chart, viewer, department.id, users);
              const teams = departmentTeams(department.id);
              const departmentDropKey = `department:${department.id}`;
              const departmentOrderDropKey = `build-department:${department.id}`;
              return (
                <section
                  className={`s2-department${dropTarget === departmentDropKey || dropTarget === departmentOrderDropKey ? " is-over" : ""}`}
                  key={department.id}
                  onDragOver={(event) => {
                    const movingDepartment = dragDepartmentId || event.dataTransfer.types.includes("application/x-larsa-department");
                    const movingTeam = dragTeamId || event.dataTransfer.types.includes("application/x-larsa-team");
                    if ((movingDepartment && isOrgAdmin(viewer)) || (movingTeam && editable)) event.preventDefault();
                  }}
                  onDragEnter={(event) => {
                    const movingDepartment = dragDepartmentId || event.dataTransfer.types.includes("application/x-larsa-department");
                    const movingTeam = dragTeamId || event.dataTransfer.types.includes("application/x-larsa-team");
                    if (movingDepartment && isOrgAdmin(viewer)) { event.preventDefault(); setDropTarget(departmentOrderDropKey); }
                    else if (movingTeam && editable) { event.preventDefault(); setDropTarget(departmentDropKey); }
                  }}
                  onDrop={(event) => {
                    const movedDepartmentId = event.dataTransfer.getData("application/x-larsa-department") || dragDepartmentId;
                    if (movedDepartmentId && isOrgAdmin(viewer)) {
                      event.preventDefault();
                      reorderDepartment(movedDepartmentId, department.id);
                      setDragDepartmentId("");
                      setDropTarget("");
                      return;
                    }
                    const teamId = event.dataTransfer.getData("application/x-larsa-team") || dragTeamId;
                    if (teamId && editable) { event.preventDefault(); moveTeam(teamId, department.id); }
                  }}
                >
                  <header className="s2-department-head">
                    {isOrgAdmin(viewer) ? <span className="s2-card-drag department" draggable aria-label={`Move department ${department.name}`} title="Drag this department above or below another department" onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-larsa-department", department.id); setDragDepartmentId(department.id); }} onDragEnd={() => { setDragDepartmentId(""); setDropTarget(""); }}><GripVertical size={16} /></span> : null}
                    <div className="s2-department-title"><span className="eyebrow">Department</span><h4>{department.name}</h4><p>{teams.length} {teams.length === 1 ? "team" : "teams"} · {unique(teams.flatMap(teamPeople)).length} people</p></div>
                    {editable ? <span className="s2-card-actions"><button type="button" aria-label={`Rename ${department.name}`} onClick={() => renameDepartment(department)}><Pencil size={13} /></button>{isOrgAdmin(viewer) ? null : null}<button type="button" onClick={() => addTeam(department.id)}><Plus size={13} /> Team</button></span> : null}
                  </header>
                  <DropZone kind="head" targetId={department.id} label="Department head" people={peopleFor(department.headIds || [])} directoryPeople={sortedActive} editable={isOrgAdmin(viewer)} activeTarget={dropTarget} draggedPersonId={dragPersonId} onTarget={setDropTarget} onAccept={acceptPerson} onRemove={(personId) => removePersonRole("head", department.id, personId)} onOpen={setSelectedPersonId} />
                  <div className="s2-team-grid">
                    {teams.map((team) => (
                      <article
                        className={`s2-team${dropTarget === `build-team:${team.id}` ? " is-over" : ""}`}
                        key={team.id}
                        onDragOver={(event) => { if (editable && (dragTeamId || event.dataTransfer.types.includes("application/x-larsa-team"))) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }}
                        onDragEnter={(event) => { if (editable && (dragTeamId || event.dataTransfer.types.includes("application/x-larsa-team"))) { event.preventDefault(); event.stopPropagation(); setDropTarget(`build-team:${team.id}`); } }}
                        onDrop={(event) => { const teamId = event.dataTransfer.getData("application/x-larsa-team") || dragTeamId; if (teamId && editable) { event.preventDefault(); event.stopPropagation(); reorderTeam(teamId, team.id); setDragTeamId(""); setDropTarget(""); } }}
                      >
                        <header><span className="s2-team-drag" draggable={editable} onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-larsa-team", team.id); setDragTeamId(team.id); }} onDragEnd={() => { setDragTeamId(""); setDropTarget(""); }} aria-label={`Move ${team.name}`}><GripVertical size={14} className="s2-grip" /></span><div><b>{team.name}</b><small>{teamPeople(team).length} people</small></div>{editable ? <span className="s2-card-actions"><button type="button" aria-label={`Rename ${team.name}`} onClick={() => renameTeam(team)}><Pencil size={12} /></button><button type="button" aria-label={`Remove ${team.name}`} onClick={() => removeTeam(team)}><X size={13} /></button></span> : null}</header>
                        <DropZone kind="lead" targetId={team.id} label="Team lead" people={peopleFor(team.leadIds || [])} directoryPeople={sortedActive} editable={editable} activeTarget={dropTarget} draggedPersonId={dragPersonId} onTarget={setDropTarget} onAccept={acceptPerson} onRemove={(personId) => removePersonRole("lead", team.id, personId)} onOpen={setSelectedPersonId} />
                        <DropZone kind="member" targetId={team.id} label="Members" people={peopleFor(team.memberIds || [])} directoryPeople={sortedActive} editable={editable} activeTarget={dropTarget} draggedPersonId={dragPersonId} onTarget={setDropTarget} onAccept={acceptPerson} onRemove={(personId) => removePersonRole("member", team.id, personId)} onOpen={setSelectedPersonId} />
                      </article>
                    ))}
                    {!teams.length ? <button type="button" className="s2-empty-team" disabled={!editable} onClick={() => addTeam(department.id)}><Plus size={16} /> Create the first team</button> : null}
                  </div>
                </section>
              );
            })}
            {!departments.length ? <div className="s2-blank"><Network size={28} /><h4>No departments yet</h4><p>Create a department, then drag people into its teams.</p></div> : null}
          </div>
          </div>
        </>
      ) : view === "diagram" ? (
        <section className="s2-diagram-card">
          <header>
            <div><span className="eyebrow"><Network size={13} /> Interactive visual organization chart</span><h4>Company reporting structure</h4><p>Drag the canvas to move around. Drag card handles to switch positions, reorder departments and teams, or move a team into another department.</p></div>
            <div className="s2-diagram-actions">
              <span className="s2-diagram-pan-help">Drag background to pan</span>
              <div className="s2-diagram-zoom" role="group" aria-label="Visual chart zoom controls">
                <button type="button" aria-label="Zoom out" disabled={diagramZoom <= .6} onClick={() => changeDiagramZoom(-.1)}><Minus size={14} /></button>
                <output aria-live="polite">{Math.round(diagramZoom * 100)}%</output>
                <button type="button" aria-label="Zoom in" disabled={diagramZoom >= 1.5} onClick={() => changeDiagramZoom(.1)}><Plus size={14} /></button>
                <button type="button" aria-label="Fit chart" title="Fit chart to this window" onClick={fitDiagramView}><Maximize2 size={14} /></button>
                <button type="button" onClick={resetDiagramView}>Reset view</button>
              </div>
              <button type="button" className="s2-diagram-names" aria-pressed={diagramNamesVisible} onClick={() => setDiagramNamesVisible((visible) => !visible)}>{diagramNamesVisible ? <EyeOff size={15} /> : <Eye size={15} />}{diagramNamesVisible ? "Hide employee names" : "Show employee names"}</button>
            </div>
          </header>
          <div
            ref={diagramScrollRef}
            className={`s2-diagram-scroll${diagramPanning ? " is-panning" : ""}`}
            aria-label="Interactive visual organization chart. Drag the background to pan."
            onPointerDown={beginDiagramPan}
            onPointerMove={moveDiagramPan}
            onPointerUp={endDiagramPan}
            onPointerCancel={endDiagramPan}
          >
            <div className="s2-diagram" style={{ zoom: diagramZoom }}>
              <div className="s2-diagram-tier-label">Company leadership</div>
              <div className="s2-diagram-executives">
                {executivePositions.length ? executivePositions.map((position) => {
                  const parents = executiveParents(position);
                  const children = executiveChildren(position.id);
                  return <article
                    className={`s2-diagram-node executive ${diagramDropTarget === `executive:${position.id}` ? "is-over" : ""}`}
                    key={position.id}
                    onDragOver={(event) => { if (diagramDragItem?.kind === "executive" && isOrgAdmin(viewer)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDiagramDropTarget(`executive:${position.id}`); } }}
                    onDrop={(event) => { event.preventDefault(); acceptDiagramDrop("executive", position.id); }}
                  >
                    {isOrgAdmin(viewer) ? <span className="s2-diagram-move" draggable aria-label={`Move ${position.title}`} title="Drag to reorder executive positions" onDragStart={(event) => startDiagramDrag(event, { kind: "executive", id: position.id })} onDragEnd={clearDiagramDrag}><GripVertical size={14} /></span> : null}
                    <small>Executive position</small><h5>{position.title}</h5><DiagramPeople people={peopleFor(position.personIds || [])} namesVisible={diagramNamesVisible} emptyLabel="Position open" onOpen={setSelectedPersonId} />
                    {parents.length || children.length ? <div className="s2-diagram-reporting">
                      {parents.length ? <span><b>Reports to</b>{parents.map((row) => <i key={row.id}>{row.title}</i>)}</span> : null}
                      {children.length ? <span><b>Direct reports</b>{children.map((row) => <i key={row.id}>{row.title}</i>)}</span> : null}
                    </div> : null}
                  </article>
                }) : <article className="s2-diagram-node executive"><small>Company leadership</small><h5>No executive positions</h5><span className="s2-diagram-empty">Add positions in Build chart</span></article>}
              </div>
              <div className="s2-diagram-trunk" aria-hidden="true" />
              {departments.length ? <div className="s2-diagram-departments" style={{ gridTemplateColumns: `repeat(${Math.max(departments.length, 1)}, minmax(285px, 1fr))` }}>
                {departments.map((department) => {
                  const teams = departmentTeams(department.id);
                  return <section className="s2-diagram-branch" key={department.id}>
                    <article
                      className={`s2-diagram-node department ${diagramDropTarget === `department:${department.id}` || diagramDropTarget === `team-department:${department.id}` ? "is-over" : ""}`}
                      onDragOver={(event) => {
                        const sourceTeam = diagramDragItem?.kind === "team" ? chart.teams.find((team) => team.id === diagramDragItem.id) : null;
                        const canMoveTeamHere = Boolean(sourceTeam && canEditDepartment(chart, viewer, sourceTeam.departmentId, users) && canEditDepartment(chart, viewer, department.id, users));
                        if ((diagramDragItem?.kind === "department" && isOrgAdmin(viewer)) || canMoveTeamHere) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setDiagramDropTarget(diagramDragItem?.kind === "team" ? `team-department:${department.id}` : `department:${department.id}`);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (diagramDragItem?.kind === "team") {
                          moveTeam(diagramDragItem.id, department.id);
                          clearDiagramDrag();
                        } else {
                          acceptDiagramDrop("department", department.id);
                        }
                      }}
                    >
                      {isOrgAdmin(viewer) ? <span className="s2-diagram-move" draggable aria-label={`Move ${department.name}`} title="Drag to reorder departments" onDragStart={(event) => startDiagramDrag(event, { kind: "department", id: department.id })} onDragEnd={clearDiagramDrag}><GripVertical size={14} /></span> : null}
                      <small>Department</small><h5>{department.name}</h5><span className="s2-diagram-role">Department head</span><DiagramPeople people={peopleFor(department.headIds || [])} namesVisible={diagramNamesVisible} emptyLabel="No head assigned" onOpen={setSelectedPersonId} />
                    </article>
                    <div className="s2-diagram-team-line" aria-hidden="true" />
                    <div className="s2-diagram-teams">
                      {teams.map((team) => {
                        const movable = canEditDepartment(chart, viewer, team.departmentId, users);
                        return <article
                          className={`s2-diagram-node team ${diagramDropTarget === `team:${team.id}` ? "is-over" : ""}`}
                          key={team.id}
                          onDragOver={(event) => { if (diagramDragItem?.kind === "team" && movable) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDiagramDropTarget(`team:${team.id}`); } }}
                          onDrop={(event) => { event.preventDefault(); acceptDiagramDrop("team", team.id); }}
                        >
                          {movable ? <span className="s2-diagram-move" draggable aria-label={`Move ${team.name}`} title="Drag to reorder or move this team" onDragStart={(event) => startDiagramDrag(event, { kind: "team", id: team.id })} onDragEnd={clearDiagramDrag}><GripVertical size={14} /></span> : null}
                          <small>Team</small><h5>{team.name}</h5><span className="s2-diagram-role">Team lead</span><DiagramPeople people={peopleFor(team.leadIds || [])} namesVisible={diagramNamesVisible} emptyLabel="No lead assigned" onOpen={setSelectedPersonId} /><span className="s2-diagram-role members">Members</span><DiagramPeople people={peopleFor(team.memberIds || [])} namesVisible={diagramNamesVisible} emptyLabel="No members assigned" onOpen={setSelectedPersonId} />
                        </article>;
                      })}
                      {!teams.length ? <article className="s2-diagram-node team empty"><small>Teams</small><h5>No teams yet</h5><span className="s2-diagram-empty">Create a team in Build chart</span></article> : null}
                    </div>
                  </section>;
                })}
              </div> : <div className="s2-blank"><Network size={28} /><h4>No departments to display</h4><p>Create the structure in Build chart, then return here to view it.</p></div>}
            </div>
          </div>
        </section>
      ) : (
        <section className="s2-matrix-card">
          <header><div><span className="eyebrow">Assignment matrix</span><h4>One person, every role</h4><p>Executive, department, team, and reporting assignments remain separate, so one employee can hold several positions.</p></div><div className="s2-matrix-filters"><label className="s2-search"><Search size={15} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people" /></label><PeopleSortControl value={peopleSort} onChange={setPeopleSort} /></div></header>
          <div className="s2-matrix-wrap">
            <table className="s2-matrix">
              <thead><tr><th>Employee</th><th>Executive position</th><th>Department head</th><th>Team lead</th><th>Team member</th><th>Reports to</th><th /></tr></thead>
              <tbody>{filteredPeople.map((person) => {
                const executive = executivePositions.filter((row) => (row.personIds || []).includes(person.id));
                const head = chart.departments.filter((row) => (row.headIds || []).includes(person.id));
                const leads = chart.teams.filter((row) => (row.leadIds || []).includes(person.id));
                const member = chart.teams.filter((row) => (row.memberIds || []).includes(person.id));
                const managers = reportingFor(person.id);
                return <tr key={person.id}>
                  <td><span className="s2-matrix-person"><i>{initials(String(person.name || ""))}</i><span><b>{person.name}</b><small>{person.role || "Employee"}</small></span></span></td>
                  <td>{executive.length ? executive.map((row) => <span className="s2-matrix-pill executive" key={row.id}>{row.title}</span>) : <span className="s2-empty">—</span>}</td>
                  <td>{head.length ? head.map((row) => <span className="s2-matrix-pill head" key={row.id}>{row.name}</span>) : <span className="s2-empty">—</span>}</td>
                  <td>{leads.length ? leads.map((row) => <span className="s2-matrix-pill lead" key={row.id}>{row.name}</span>) : <span className="s2-empty">—</span>}</td>
                  <td>{member.length ? member.map((row) => <span className="s2-matrix-pill" key={row.id}>{row.name}</span>) : <span className="s2-empty">—</span>}</td>
                  <td>{managers.length ? managers.map((id) => <span className="s2-matrix-pill manager" key={id}>{nameOf(id)}</span>) : <span className="s2-empty">—</span>}</td>
                  <td><button type="button" className="s2-edit-person" onClick={() => setSelectedPersonId(person.id)}><UserCog size={14} /> Edit</button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </section>
      )}

      {selectedPerson ? (
        <div className="s2-inspector-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setSelectedPersonId(""); }}>
          <aside className="s2-inspector" role="dialog" aria-modal="true" aria-label={`Assignments for ${selectedPerson.name}`}>
            <header><span className="s2-avatar large">{initials(String(selectedPerson.name || ""))}</span><div><span className="eyebrow">Assignments & reporting</span><h3>{selectedPerson.name}</h3><p>{selectedPerson.role || "Employee"}</p></div><button type="button" aria-label="Close assignments" onClick={() => setSelectedPersonId("")}><X size={18} /></button></header>
            <section><h4>Current roles</h4><div className="s2-role-list">{rolesFor(selectedPerson.id).map((role) => <span className={`s2-role ${role.tone}`} key={`${role.tone}:${role.label}`}>{role.label}</span>)}{!rolesFor(selectedPerson.id).length ? <span className="s2-empty">No structural role yet</span> : null}</div></section>
            <section><h4>Executive leadership</h4><p className="s2-section-note">Company-level positions stay separate from technical department and team assignments.</p><div className="s2-check-list">{executivePositions.map((position) => <label key={position.id}><input type="checkbox" checked={(position.personIds || []).includes(selectedPerson.id)} disabled={!isOrgAdmin(viewer)} onChange={(event) => toggleExecutive(position, selectedPerson.id, event.target.checked)} /><span><b>{position.title}</b><small>Executive position</small></span></label>)}</div>{!executivePositions.length ? <span className="s2-empty">No executive positions have been created.</span> : null}</section>
            <section><h4>Additional reporting lines</h4><p className="s2-section-note">Independent from team membership. This supports an executive who also reports technically inside another department.</p><div className="s2-manager-list">{reportingFor(selectedPerson.id).map((id) => <span className="s2-manager" key={id}>{nameOf(id)}{isOrgAdmin(viewer) ? <button type="button" aria-label={`Remove manager ${nameOf(id)}`} onClick={() => setReporting(selectedPerson.id, reportingFor(selectedPerson.id).filter((row) => row !== id))}><X size={12} /></button> : null}</span>)}</div>{isOrgAdmin(viewer) ? <select value={managerChoice} onChange={(event) => { const id = event.target.value; setManagerChoice(""); if (id) setReporting(selectedPerson.id, [...reportingFor(selectedPerson.id), id]); }}><option value="">Add another manager…</option>{sortedActive.filter((row) => row.id !== selectedPerson.id && !reportingFor(selectedPerson.id).includes(row.id)).map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}</select> : null}</section>
            <section><h4>Department leadership</h4><div className="s2-check-list">{departments.map((department) => { const editable = isOrgAdmin(viewer); return <label key={department.id}><input type="checkbox" checked={(department.headIds || []).includes(selectedPerson.id)} disabled={!editable} onChange={(event) => toggleHead(department, selectedPerson.id, event.target.checked)} /><span><b>{department.name}</b><small>Department head</small></span></label>; })}</div></section>
            <section><h4>Team assignments</h4><div className="s2-team-assignments">{visibleTeams.map((team) => { const editable = canEditDepartment(chart, viewer, team.departmentId, users); const department = chart.departments.find((row) => row.id === team.departmentId); return <div key={team.id}><span><b>{team.name}</b><small>{department?.name || "Department"}</small></span><label><input type="checkbox" checked={(team.memberIds || []).includes(selectedPerson.id)} disabled={!editable} onChange={(event) => toggleTeamRole(team, "memberIds", selectedPerson.id, event.target.checked)} /> Member</label><label><input type="checkbox" checked={(team.leadIds || []).includes(selectedPerson.id)} disabled={!editable} onChange={(event) => toggleTeamRole(team, "leadIds", selectedPerson.id, event.target.checked)} /> Lead</label></div>; })}</div></section>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
