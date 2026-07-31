"use client";

/* Engineering Management: the screen where the company's shape is built, and
 * where a manager looks at the people that shape puts under them.
 *
 * Deliberately two separate jobs on two tabs. Building the structure is an
 * occasional administrative act; looking at your team is a daily one, and
 * mixing them would put edit controls in front of people who only want to
 * read. Structure is only rendered for those allowed to change it.
 */

import { useMemo, useState } from "react";
import { Building2, Plus, Trash2, Users } from "lucide-react";
import {
  canCreateDepartments,
  canEditDepartment,
  departmentById,
  isOrgAdmin,
  managersOf,
  newId,
  readOrg,
  rolesOf,
  teamsVisibleTo,
  writeOrg,
} from "../lib/org";
import type { Department, OrgChart, Team } from "../lib/org";

type Person = {
  id: string;
  name: string;
  access?: string;
  role?: string;
  department?: string;
  enabled?: boolean;
  teamGrants?: string[];
  departmentGrants?: string[];
};

export function OrgStructure({
  viewer,
  users,
  onSaved,
}: {
  viewer: Person | null;
  users: Person[];
  onSaved?: () => void;
}) {
  const [chart, setChart] = useState<OrgChart>(() => readOrg());
  const [tab, setTab] = useState<"teams" | "structure">("teams");
  const [openDepartment, setOpenDepartment] = useState<string>("");
  const [note, setNote] = useState("");

  const staff = useMemo(
    () => users.filter((row) => row.enabled !== false).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [users],
  );
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((row) => map.set(row.id, row.name));
    return (id: string) => map.get(id) || "Unknown";
  }, [users]);

  const mayBuild = Boolean(viewer && (isOrgAdmin(viewer) || chart.departments.some((row) => canEditDepartment(chart, viewer, row.id))));
  const myTeams = useMemo(() => teamsVisibleTo(chart, viewer), [chart, viewer]);

  function save(next: OrgChart, message: string) {
    setChart(next);
    if (writeOrg(next)) {
      setNote(message);
      if (onSaved) onSaved();
    } else {
      setNote("Could not save. Reload and try again.");
    }
  }

  function addDepartment() {
    const name = window.prompt("Department name");
    if (!name || !name.trim()) return;
    const department: Department = { id: newId("dep"), name: name.trim(), headIds: [] };
    save({ ...chart, departments: [...chart.departments, department] }, "Department added.");
    setOpenDepartment(department.id);
  }

  function addTeam(departmentId: string) {
    const name = window.prompt("Team name");
    if (!name || !name.trim()) return;
    const team: Team = { id: newId("team"), departmentId, name: name.trim(), leadIds: [], memberIds: [] };
    save({ ...chart, teams: [...chart.teams, team] }, "Team added.");
  }

  function renameDepartment(department: Department) {
    const name = window.prompt("Department name", department.name);
    if (!name || !name.trim()) return;
    save(
      { ...chart, departments: chart.departments.map((row) => (row.id === department.id ? { ...row, name: name.trim() } : row)) },
      "Renamed.",
    );
  }

  function renameTeam(team: Team) {
    const name = window.prompt("Team name", team.name);
    if (!name || !name.trim()) return;
    save({ ...chart, teams: chart.teams.map((row) => (row.id === team.id ? { ...row, name: name.trim() } : row)) }, "Renamed.");
  }

  function removeDepartment(department: Department) {
    const teams = chart.teams.filter((row) => row.departmentId === department.id);
    const warning = teams.length
      ? "Remove " + department.name + " and its " + teams.length + " team(s)?"
      : "Remove " + department.name + "?";
    if (!window.confirm(warning)) return;
    save(
      {
        departments: chart.departments.filter((row) => row.id !== department.id),
        teams: chart.teams.filter((row) => row.departmentId !== department.id),
      },
      "Department removed.",
    );
  }

  function removeTeam(team: Team) {
    if (!window.confirm("Remove " + team.name + "?")) return;
    save({ ...chart, teams: chart.teams.filter((row) => row.id !== team.id) }, "Team removed.");
  }

  function toggleHead(department: Department, personId: string) {
    const heads = department.headIds || [];
    const next = heads.indexOf(personId) >= 0 ? heads.filter((id) => id !== personId) : [...heads, personId];
    save(
      { ...chart, departments: chart.departments.map((row) => (row.id === department.id ? { ...row, headIds: next } : row)) },
      "Heads updated.",
    );
  }

  function toggleTeamMember(team: Team, personId: string, field: "leadIds" | "memberIds") {
    const current = team[field] || [];
    const next = current.indexOf(personId) >= 0 ? current.filter((id) => id !== personId) : [...current, personId];
    save({ ...chart, teams: chart.teams.map((row) => (row.id === team.id ? { ...row, [field]: next } : row)) }, "Team updated.");
  }

  const teamsTab = (
    <>
      {myTeams.length === 0 ? (
        <p className="org-empty">No teams assigned to you yet.</p>
      ) : (
        <div className="org-grid">
          {myTeams.map((team) => {
            const department = departmentById(chart, team.departmentId);
            const people = [...new Set([...(team.leadIds || []), ...(team.memberIds || [])])];
            return (
              <section className="org-card" key={team.id}>
                <header>
                  <span className="org-eyebrow">{department ? department.name : "No department"}</span>
                  <h3>{team.name}</h3>
                  <small>{people.length} people</small>
                </header>
                <ul className="org-people">
                  {people.map((personId) => (
                    <li key={personId}>
                      <span>
                        <b>{nameOf(personId)}</b>
                        <small>{(team.leadIds || []).indexOf(personId) >= 0 ? "Team lead" : "Member"}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );

  const structureTab = (
    <>
      {canCreateDepartments(viewer) ? (
        <button type="button" className="org-add" onClick={addDepartment}>
          <Plus size={15} /> Department
        </button>
      ) : null}

      {chart.departments.length === 0 ? (
        <p className="org-empty">No departments yet.</p>
      ) : null}

      {chart.departments.map((department) => {
        const editable = canEditDepartment(chart, viewer, department.id);
        const teams = chart.teams.filter((row) => row.departmentId === department.id);
        const open = openDepartment === department.id;
        return (
          <section className="org-card org-department" key={department.id}>
            <header>
              <span className="org-eyebrow"><Building2 size={14} /> Department</span>
              <h3>{department.name}</h3>
              <small>{(department.headIds || []).map(nameOf).join(", ") || "No head"}</small>
              <div className="org-actions">
                <button type="button" className="btn small" onClick={() => setOpenDepartment(open ? "" : department.id)}>
                  {open ? "Close" : "Manage"}
                </button>
                {editable ? (
                  <button type="button" className="btn small" onClick={() => addTeam(department.id)}>
                    <Plus size={14} /> Team
                  </button>
                ) : null}
                {isOrgAdmin(viewer) ? (
                  <>
                    <button type="button" className="btn small" onClick={() => renameDepartment(department)}>Rename</button>
                    <button type="button" className="btn small" onClick={() => removeDepartment(department)}><Trash2 size={14} /></button>
                  </>
                ) : null}
              </div>
            </header>

            {open && isOrgAdmin(viewer) ? (
              <div className="org-picker">
                <span className="org-picker-title">Heads</span>
                <div className="org-chips">
                  {staff.map((person) => (
                    <label key={person.id} className={(department.headIds || []).indexOf(person.id) >= 0 ? "org-chip on" : "org-chip"}>
                      <input
                        type="checkbox"
                        checked={(department.headIds || []).indexOf(person.id) >= 0}
                        onChange={() => toggleHead(department, person.id)}
                      />
                      {person.name}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            {teams.length === 0 ? <p className="org-empty">No teams yet.</p> : null}

            {teams.map((team) => (
              <div className="org-team" key={team.id}>
                <div className="org-team-head">
                  <span>
                    <b><Users size={14} /> {team.name}</b>
                    <small>
                      {(team.leadIds || []).length ? "Lead: " + (team.leadIds || []).map(nameOf).join(", ") : "No lead"}
                      {" - "}
                      {(team.memberIds || []).length} members
                    </small>
                  </span>
                  {editable ? (
                    <span className="org-actions">
                      <button type="button" className="btn small" onClick={() => renameTeam(team)}>Rename</button>
                      <button type="button" className="btn small" onClick={() => removeTeam(team)}><Trash2 size={14} /></button>
                    </span>
                  ) : null}
                </div>

                {open && editable ? (
                  <div className="org-picker">
                    <span className="org-picker-title">Leads</span>
                    <div className="org-chips">
                      {staff.map((person) => (
                        <label key={person.id} className={(team.leadIds || []).indexOf(person.id) >= 0 ? "org-chip on" : "org-chip"}>
                          <input
                            type="checkbox"
                            checked={(team.leadIds || []).indexOf(person.id) >= 0}
                            onChange={() => toggleTeamMember(team, person.id, "leadIds")}
                          />
                          {person.name}
                        </label>
                      ))}
                    </div>
                    <span className="org-picker-title">Members</span>
                    <div className="org-chips">
                      {staff.map((person) => (
                        <label key={person.id} className={(team.memberIds || []).indexOf(person.id) >= 0 ? "org-chip on" : "org-chip"}>
                          <input
                            type="checkbox"
                            checked={(team.memberIds || []).indexOf(person.id) >= 0}
                            onChange={() => toggleTeamMember(team, person.id, "memberIds")}
                          />
                          {person.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        );
      })}
    </>
  );

  return (
    <div className="org-portal">
      <div className="org-tabs" role="tablist">
        <button type="button" role="tab" className={tab === "teams" ? "active" : ""} onClick={() => setTab("teams")}>
          My teams
        </button>
        {mayBuild ? (
          <button type="button" role="tab" className={tab === "structure" ? "active" : ""} onClick={() => setTab("structure")}>
            Structure
          </button>
        ) : null}
      </div>

      {note ? <p className="org-note">{note}</p> : null}

      {viewer && rolesOf(chart, viewer).length ? (
        <p className="org-roles">{rolesOf(chart, viewer).join(" - ")}</p>
      ) : null}

      {viewer && managersOf(chart, viewer.id).length ? (
        <p className="org-roles">Reports to {managersOf(chart, viewer.id).map(nameOf).join(", ")}</p>
      ) : null}

      {tab === "teams" ? teamsTab : structureTab}
    </div>
  );
}
