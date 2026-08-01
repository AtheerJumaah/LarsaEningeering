"use client";

/* The Engineering Management dashboard: the reporting line drawn as a tree.
 *
 * This is not project management and it stores nothing. Every figure on this
 * screen is read from records the app already keeps -- the org chart, the
 * clock sessions, the submitted performance rows, the weekly point targets and
 * the shift schedule. There is no form here, and nothing to fill in.
 *
 * Why a tree and not a table: a flat list of names and points answers "how is
 * everyone doing" but not "who does this person answer to", which is the
 * question the structure exists to record. Departments collapse so a manager
 * with six of them can look at one, and the branch containing the viewer opens
 * on arrival because that is almost always what they came to see.
 *
 * Scope is not decided here. The caller passes only the people this viewer is
 * allowed to see, and a branch with nobody visible in it is not drawn at all,
 * so a team leader gets their own team and an engineer gets only their place
 * in the company.
 */

import { useMemo, useState } from "react";
import { Building2, ChevronDown, ChevronRight, GripVertical, Users } from "lucide-react";
import {
  departmentsHeadedBy,
  effectiveOrg,
  isOrgAdmin,
  managersOf,
  teamsContaining,
  teamsLedBy,
  teamsVisibleTo, writeOrg,
} from "../lib/org";
import type { OrgUser, Team } from "../lib/org";
import { formatHours } from "../lib/teamMetrics";

type Summary = {
  user: { id: string; name: string; role?: string; access?: string };
  hours: number;
  approved: number;
  submitted: number;
  target: number;
};

type Session = { uid: string; mode: string; open: boolean };

/* Indexed by Date.getDay(), so Sunday must stay first. */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* A shift code of OFF or standby means nobody is expected in, so their absence
   is not an absence. Counting a scheduled day off as "absent" would make every
   weekend look like a staffing crisis. */
const NOT_EXPECTED = ["OFF", "STB"];

const TONE_LABEL: Record<string, string> = {
  office: "In the office",
  online: "Online",
  site: "On site",
  other: "Clocked in",
  off: "Not clocked in",
};

function Bars({ approved, target, present, people }: { approved: number; target: number; present: number; people: number }) {  const done = target ? Math.round((approved / target) * 100) : null;  const inNow = people ? Math.round((present / people) * 100) : null;  if (done === null && inNow === null) return null;  const tone = done === null ? "low" : done >= 100 ? "good" : done >= 60 ? "warn" : "low";  return (    <span className="hier-bars" aria-hidden="true">      {done === null ? null : (        <span className="hier-barline">          <small>Quota</small>          <span className="hier-bar"><i className={"hier-bar-" + tone} style={{ width: Math.min(100, Math.max(0, done)) + "%" }} /></span>          <b>{done}%</b>        </span>      )}      {inNow === null ? null : (        <span className="hier-barline">          <small>In now</small>          <span className="hier-bar"><i className="hier-bar-present" style={{ width: Math.min(100, Math.max(0, inNow)) + "%" }} /></span>          <b>{present}/{people}</b>        </span>      )}    </span>  );}function percent(approved: number, target: number): number | null {
  if (!target) return null;
  return Math.round((approved / target) * 100);
}

/* Today\u2019s shift codes come from the same synced blob the schedule screen   writes, so the dashboard never needs its own copy or its own prop. */function readSchedule(): Record<string, Record<string, { code?: string }[]>> {  try {    const raw = localStorage.getItem("larsaStaffV8");    const parsed = raw ? JSON.parse(raw) : null;    const schedule = parsed && typeof parsed === "object" ? parsed.schedule : null;    return schedule && typeof schedule === "object" ? schedule : {};  } catch {    return {};  }}function membersOf(team: Team): string[] {
  return [...new Set((team.leadIds || []).concat(team.memberIds || []))];
}

export function HierarchyDashboard({
  viewer,
  users,
  summaries,
  sessions,

  toneOf,
  periodLabel, from, to, onPeriod, onFrom, onTo,
}: {
  viewer: OrgUser | null;
  users: OrgUser[];
  summaries: Summary[];
  sessions: Session[];

  toneOf: (value: unknown) => string;
  periodLabel: string; from: string; to: string; onPeriod: (period: "today" | "week" | "month" | "sixMonths" | "year") => void; onFrom: (value: string) => void; onTo: (value: string) => void;
}) {
  const [orderTick, setOrderTick] = useState(0);  const org = useMemo(() => effectiveOrg(users), [users, orderTick]);
  const byId = useMemo(() => {
    const map = new Map<string, Summary>();
    summaries.forEach((row) => map.set(row.user.id, row));
    return map;
  }, [summaries]);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((row) => map.set(row.id, String(row.name || "")));
    return (id: string) => map.get(id) || "Unknown";
  }, [users]);

  const roleOf = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((row) => map.set(row.id, String(row.role || "")));
    return (id: string) => map.get(id) || "";
  }, [users]);

  /* Presence is "right now", not "during the reporting period", so it reads the
     unfiltered session list: an open session is someone who is currently in. */
  const presenceOf = useMemo(() => {
    const open = new Map<string, Session>();
    sessions.forEach((row) => {
      if (row && row.open && row.uid) open.set(row.uid, row);
    });
    return (id: string) => {
      const session = open.get(id);
      const tone = session ? String(toneOf(session.mode) || "other") : "off";
      return { tone, label: TONE_LABEL[tone] || TONE_LABEL.other, present: Boolean(session) };
    };
  }, [sessions, toneOf]);

  const expectedToday = useMemo(() => {
    const today = WEEKDAYS[new Date().getDay()];
    const schedule = readSchedule() as Record<
      string,
      Record<string, { code?: string }[]>
    >;
    return (id: string) => {
      const day = schedule[id] ? schedule[id][today] : undefined;
      const code = (day || []).map((entry) => String(entry.code || "").toUpperCase()).find(Boolean) || "OFF";
      return NOT_EXPECTED.indexOf(code) < 0;
    };
  }, []);

  /* Membership of a team is what puts somebody in a branch. A team with nobody
     visible in it is not drawn, which is how scope shapes the tree. */
  const visibleTeams = useMemo(() => {
    const all = teamsVisibleTo(org, viewer);
    return all.filter((team) => membersOf(team).some((id) => byId.has(id)));
  }, [org, viewer, byId]);

  const departments = useMemo(() => {
    const wanted = new Set(visibleTeams.map((team) => team.departmentId));
    if (isOrgAdmin(viewer)) org.departments.forEach((row) => wanted.add(row.id));
    departmentsHeadedBy(org, viewer ? viewer.id : "").forEach((row) => wanted.add(row.id));
    return org.departments
      .filter((row) => wanted.has(row.id))
      .map((row) => ({ department: row, teams: visibleTeams.filter((team) => team.departmentId === row.id) }))
      .filter((row) => row.teams.length);
  }, [org, viewer, visibleTeams]);

  const placed = useMemo(() => {
    const ids = new Set<string>();
    visibleTeams.forEach((team) => membersOf(team).forEach((id) => ids.add(id)));
    return ids;
  }, [visibleTeams]);

  const unplaced = useMemo(
    () => summaries.filter((row) => !placed.has(row.user.id)).map((row) => row.user.id),
    [summaries, placed],
  );

  const [openDepartments, setOpenDepartments] = useState<Record<string, boolean>>({});
  const [openTeams, setOpenTeams] = useState<Record<string, boolean>>({});  const [dragId, setDragId] = useState(""); const [dragTeam, setDragTeam] = useState(""); const [overTeam, setOverTeam] = useState("");  const [overId, setOverId] = useState("");  /* Departments are drawn in the order they are stored, so reordering is just     moving one entry in that array and saving the chart back. */  function moveTeam(fromId: string, toId: string) {    if (!fromId || !toId || fromId === toId) return;    const list = org.teams.slice();    const from = list.findIndex((row) => row.id === fromId);    const to = list.findIndex((row) => row.id === toId);    if (from < 0 || to < 0) return;    if (list[from].departmentId !== list[to].departmentId) { setDragTeam(""); setOverTeam(""); return; }    const [moved] = list.splice(from, 1);    list.splice(to, 0, moved);    if (writeOrg({ departments: org.departments, teams: list })) setOrderTick((value) => value + 1);    setDragTeam("");    setOverTeam("");  }  function moveDepartment(fromId: string, toId: string) {    if (!fromId || !toId || fromId === toId) return;    const list = org.departments.slice();    const from = list.findIndex((row) => row.id === fromId);    const to = list.findIndex((row) => row.id === toId);    if (from < 0 || to < 0) return;    const [moved] = list.splice(from, 1);    list.splice(to, 0, moved);    if (writeOrg({ departments: list, teams: org.teams })) setOrderTick((value) => value + 1);    setDragId("");    setOverId("");  }

  const myTeams = viewer ? teamsContaining(org, viewer.id).concat(teamsLedBy(org, viewer.id)) : [];
  const myTeamIds = new Set(myTeams.map((team) => team.id));
  const myDepartmentIds = new Set(myTeams.map((team) => team.departmentId));

  function departmentOpen(id: string) {
    if (id in openDepartments) return openDepartments[id];
    return myDepartmentIds.has(id) || departments.length === 1;
  }
  function teamOpen(id: string) {
    if (id in openTeams) return openTeams[id];
    return myTeamIds.has(id) || visibleTeams.length <= 2;
  }

  function rollup(ids: string[]) {
    let approved = 0;
    let target = 0;
    let hours = 0;
    let present = 0;
    let absent = 0;
    let counted = 0;
    ids.forEach((id) => {
      const row = byId.get(id);
      if (!row) return;
      counted += 1;
      approved += row.approved;
      target += row.target;
      hours += row.hours;
      if (presenceOf(id).present) present += 1;
      else if (expectedToday(id)) absent += 1;
    });
    return { approved, target, hours, present, absent, people: counted };
  }

  const myDepartmentNames = org.departments
    .filter((row) => myDepartmentIds.has(row.id))
    .map((row) => row.name);
  const myLeads = viewer
    ? [...new Set(teamsContaining(org, viewer.id).flatMap((team) => team.leadIds || []))].filter(
        (id) => id !== viewer.id,
      )
    : [];
  const myManagers = viewer ? managersOf(org, viewer.id, users) : [];

  const company = rollup(summaries.map((row) => row.user.id));

  function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
    return (
      <span className={tone ? "hier-stat hier-stat-" + tone : "hier-stat"}>
        <small>{label}</small>
        <b>{value}</b>
      </span>
    );
  }

  function quotaText(approved: number, target: number) {
    const value = percent(approved, target);
    return value === null ? "\u2014" : value + "%";
  }

  function quotaTone(approved: number, target: number) {
    const value = percent(approved, target);
    if (value === null) return undefined;
    if (value >= 100) return "good";
    if (value >= 60) return "warn";
    return "low";
  }

  function PersonRow({ id, lead }: { id: string; lead: boolean }) {
    const row = byId.get(id);
    if (!row) return null;
    const presence = presenceOf(id);
    const value = percent(row.approved, row.target);
    return (
      <li className="hier-person">
        <span className="hier-person-who">
          <span className={"hier-dot hier-dot-" + presence.tone} aria-hidden="true" />
          <span>
            <b>
              {nameOf(id)}
              {lead ? <em className="hier-badge">Team Leader</em> : null}
              {viewer && id === viewer.id ? <em className="hier-badge hier-badge-you">You</em> : null}
            </b>
            <small>{[roleOf(id), presence.label].filter(Boolean).join(" \u00b7 ")}</small>
          </span>
        </span>
        <span className="hier-person-stats">
          <Stat label="Approved" value={String(row.approved)} />
          <Stat label="Quota" value={row.target ? row.approved + " / " + row.target : "\u2014"} />
          <Stat label="Done" value={quotaText(row.approved, row.target)} tone={quotaTone(row.approved, row.target)} />
          <Stat label="Hours" value={formatHours(row.hours)} />
        </span>
        {row.target ? (
          <span className="hier-bar" aria-hidden="true">
            <i
              className={"hier-bar-" + (quotaTone(row.approved, row.target) || "low")}
              style={{ width: Math.min(100, Math.max(0, value || 0)) + "%" }}
            />
          </span>
        ) : null}
      </li>
    );
  }

  function TeamBlock({ team }: { team: Team }) {
    const leads = (team.leadIds || []).filter((id) => byId.has(id));
    const members = membersOf(team).filter((id) => byId.has(id) && leads.indexOf(id) < 0);
    const totals = rollup(leads.concat(members));
    const isOpen = teamOpen(team.id);
    return (
      <div className={"hier-team" + (dragTeam === team.id ? " is-dragging" : "") + (overTeam === team.id ? " is-over" : "")} draggable onDragStart={(event) => { event.stopPropagation(); setDragTeam(team.id); }} onDragEnd={() => { setDragTeam(""); setOverTeam(""); }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); if (overTeam !== team.id) setOverTeam(team.id); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); moveTeam(dragTeam, team.id); }}>
        <button
          type="button"
          className="hier-head hier-head-team"
          aria-expanded={isOpen}
          onClick={() => setOpenTeams((current) => ({ ...current, [team.id]: !isOpen }))}
        >
          <span className="hier-head-title">
            <span className="hier-drag" title="Drag to reorder" aria-hidden="true"><GripVertical size={13} /></span>            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <span>
              <b>{team.name}</b>
              <small>
                {leads.length ? "Led by " + leads.map(nameOf).join(", ") : "No team leader set"}
                {" \u00b7 "}
                {totals.people} {totals.people === 1 ? "person" : "people"}
              </small>
            </span>
          </span>
          <span className="hier-head-stats">
            <Stat label="Approved" value={String(totals.approved)} />
            <Stat label="Done" value={quotaText(totals.approved, totals.target)} tone={quotaTone(totals.approved, totals.target)} />
            <Stat label="Hours" value={formatHours(totals.hours)} />
            <Stat label="In now" value={totals.present + " / " + totals.people} /> <Bars approved={totals.approved} target={totals.target} present={totals.present} people={totals.people} />
          </span>
        </button>
        {isOpen ? (
          <ul className="hier-people">
            {leads.map((id) => (
              <PersonRow key={id} id={id} lead />
            ))}
            {members.map((id) => (
              <PersonRow key={id} id={id} lead={false} />
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  return (
    <div className="hier">
      <div className="hier-period">        <span className="hier-period-presets">          <button type="button" onClick={() => onPeriod("today")}>Day</button>          <button type="button" onClick={() => onPeriod("week")}>Week</button>          <button type="button" onClick={() => onPeriod("month")}>Month</button>          <button type="button" onClick={() => onPeriod("sixMonths")}>6 months</button>          <button type="button" onClick={() => onPeriod("year")}>Year</button>        </span>        <span className="hier-period-range">          <label>From <input type="date" value={from} onChange={(event) => onFrom(event.target.value)} /></label>          <label>To <input type="date" value={to} onChange={(event) => onTo(event.target.value)} /></label>        </span>      </div>      <section className="org-card hier-place">
        <span className="org-eyebrow">Your place</span>
        <div className="hier-place-grid">
          <div>
            <span className="org-label">Department</span>
            <b>{myDepartmentNames.length ? myDepartmentNames.join(", ") : "Not assigned"}</b>
          </div>
          <div>
            <span className="org-label">Team leader</span>
            <b>{myLeads.length ? myLeads.map(nameOf).join(", ") : "Not set"}</b>
          </div>
          <div>
            <span className="org-label">Reports to</span>
            <b>{myManagers.length ? myManagers.map(nameOf).join(", ") : "Not set"}</b>
          </div>
        </div>
      </section>

      {departments.length ? (
        <>
          {departments.length > 1 ? (
            <section className="org-card hier-company">
              <span className="org-eyebrow">
                <Building2 size={14} /> All departments {"\u00b7"} {periodLabel}
              </span>
              <div className="hier-head-stats hier-company-stats">
                <Stat label="Departments" value={String(departments.length)} />
                <Stat label="People" value={String(company.people)} />
                <Stat label="Approved" value={String(company.approved)} />
                <Stat label="Quota" value={company.target ? company.approved + " / " + company.target : "\u2014"} />
                <Stat label="Done" value={quotaText(company.approved, company.target)} tone={quotaTone(company.approved, company.target)} />
                <Stat label="Hours" value={formatHours(company.hours)} />
                <Stat label="In now" value={String(company.present)} />
                <Stat label="Absent" value={String(company.absent)} /> <Bars approved={company.approved} target={company.target} present={company.present} people={company.people} />
              </div>
            </section>
          ) : null}

          {departments.map(({ department, teams }) => {
            const ids = [...new Set(teams.flatMap((team) => membersOf(team)))].filter((id) => byId.has(id));
            const totals = rollup(ids);
            const isOpen = departmentOpen(department.id);
            const heads = (department.headIds || []).filter((id) => byId.has(id) || nameOf(id) !== "Unknown");
            return (
              <section className={"org-card hier-department" + (dragId === department.id ? " is-dragging" : "") + (overId === department.id ? " is-over" : "")} key={department.id} draggable onDragStart={() => setDragId(department.id)} onDragEnd={() => { setDragId(""); setOverId(""); }} onDragOver={(event) => { event.preventDefault(); if (overId !== department.id) setOverId(department.id); }} onDrop={(event) => { event.preventDefault(); moveDepartment(dragId, department.id); }}>
                <button
                  type="button"
                  className="hier-head"
                  aria-expanded={isOpen}
                  onClick={() => setOpenDepartments((current) => ({ ...current, [department.id]: !isOpen }))}
                >
                  <span className="hier-head-title">
                    <span className="hier-drag" title="Drag to reorder" aria-hidden="true"><GripVertical size={15} /></span>                    {isOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                    <span>
                      <b>{department.name}</b>
                      <small>
                        {heads.length ? "Head: " + heads.map(nameOf).join(", ") : "No head set"}
                        {" \u00b7 "}
                        {teams.length} {teams.length === 1 ? "team" : "teams"}
                        {" \u00b7 "}
                        {totals.people} people
                      </small>
                    </span>
                  </span>
                  <span className="hier-head-stats">
                    <Stat label="Quota" value={totals.target ? totals.approved + " / " + totals.target : "\u2014"} />
                    <Stat label="Approved" value={String(totals.approved)} />
                    <Stat label="Done" value={quotaText(totals.approved, totals.target)} tone={quotaTone(totals.approved, totals.target)} />
                    <Stat label="Hours" value={formatHours(totals.hours)} />
                    <Stat label="Present" value={String(totals.present)} tone="good" />
                    <Stat label="Absent" value={String(totals.absent)} tone={totals.absent ? "low" : undefined} /> <Bars approved={totals.approved} target={totals.target} present={totals.present} people={totals.people} />
                  </span>
                </button>
                {isOpen ? (
                  <div className="hier-teams">
                    {teams.map((team) => (
                      <TeamBlock key={team.id} team={team} />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}

          {unplaced.length ? (
            <section className="org-card hier-department">
              <span className="org-eyebrow">
                <Users size={14} /> Not on a team yet
              </span>
              <ul className="hier-people">
                {unplaced.map((id) => (
                  <PersonRow key={id} id={id} lead={false} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : (
        <p className="org-none">Your reports appear here once you lead a team or head a department.</p>
      )}
    </div>
  );
}
