"use client";

/* Engineering Management.
 *
 * Open to everybody, because the first question most people have is simply
 * "which department and team am I on, and who do I report to" -- that is the
 * top card and it needs no permission at all. The half below it, where the
 * structure is shaped, only renders for people who are actually responsible
 * for somebody.
 *
 * People are added from a dropdown and shown as removable chips rather than a
 * wall of checkboxes: with twenty-six staff a checkbox grid is a wall of text
 * that hides who is actually on the team, which is the one thing the screen
 * exists to show.
 */

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  assignableTo,
  canCreateDepartments,
  canEditDepartment,
  departmentsContaining,
  effectiveOrg,
  isOrgAdmin,
  isResponsibleForOthers,
  managersOf,
  newId,
  rolesOf,
  teamsContaining,
  teamsVisibleTo,
  writeOrg,
} from "../lib/org";
import type { Department, OrgChart, OrgUser, Team } from "../lib/org";

export function OrgStructure({
  viewer,
  users,
  onSaved,
}: {
  viewer: OrgUser | null;
  users: OrgUser[];
  onSaved?: () => void;
}) {
  const [saved, setSaved] = useState<OrgChart | null>(null);
  const [note, setNote] = useState("");

  /* The saved chart once anything has been edited this session, otherwise the
     one derived from the staff list. */
  const chart = useMemo(() => saved || effectiveOrg(users), [saved, users]);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((row) => map.set(row.id, String(row.name || "")));
    return (id: string) => map.get(id) || "Unknown";
  }, [users]);

  const manages = isResponsibleForOthers(chart, viewer, users);
  const myDepartments = viewer ? departmentsContaining(chart, viewer.id) : [];
  const myTeams = viewer ? teamsContaining(chart, viewer.id) : [];
  const myManagers = viewer ? managersOf(chart, viewer.id, users) : [];
  const myRoles = viewer ? rolesOf(chart, viewer) : [];
  const managedTeams = teamsVisibleTo(chart, viewer);

  function save(next: OrgChart, message: string) {
    setSaved(next);
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
    save({ ...chart, departments: [...chart.departments, { id: newId("dep"), name: name.trim(), headIds: [] }] }, "Department added.");
  }

  function addTeam(departmentId: string) {
    const name = window.prompt("Team name");
    if (!name || !name.trim()) return;
    save(
      { ...chart, teams: [...chart.teams, { id: newId("team"), departmentId, name: name.trim(), leadIds: [], memberIds: [] }] },
      "Team added.",
    );
  }

  function setHeads(department: Department, headIds: string[]) {
    save(
      { ...chart, departments: chart.departments.map((row) => (row.id === department.id ? { ...row, headIds } : row)) },
      "Saved.",
    );
  }

  function setTeamField(team: Team, field: "leadIds" | "memberIds", ids: string[]) {
    save({ ...chart, teams: chart.teams.map((row) => (row.id === team.id ? { ...row, [field]: ids } : row)) }, "Saved.");
  }

  function removeTeam(team: Team) {
    if (!window.confirm("Remove " + team.name + "?")) return;
    save({ ...chart, teams: chart.teams.filter((row) => row.id !== team.id) }, "Team removed.");
  }

  function removeDepartment(department: Department) {
    if (!window.confirm("Remove " + department.name + " and its teams?")) return;
    save(
      {
        departments: chart.departments.filter((row) => row.id !== department.id),
        teams: chart.teams.filter((row) => row.departmentId !== department.id),
      },
      "Department removed.",
    );
  }

  function Chips({ ids, onRemove, empty }: { ids: string[]; onRemove?: (id: string) => void; empty: string }) {
    if (!ids.length) return <span className="org-none">{empty}</span>;
    return (
      <span className="org-chiprow">
        {ids.map((id) => (
          <span className="org-name" key={id}>
            {nameOf(id)}
            {onRemove ? (
              <button type="button" aria-label={"Remove " + nameOf(id)} onClick={() => onRemove(id)}>
                <X size={13} />
              </button>
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
      <select
        className="org-select"
        value=""
        onChange={(event) => {
          if (event.target.value) onAdd(event.target.value);
        }}
      >
        <option value="">{label}</option>
        {options.map((row) => (
          <option key={row.id} value={row.id}>{row.name}</option>
        ))}
      </select>
    );
  }

  return (
    <div className="org-portal">
      <section className="org-card org-me">
        <span className="org-eyebrow">Your place</span>
        <div className="org-me-grid">
          <div>
            <span className="org-label">Department</span>
            <Chips ids={myDepartments.map((row) => row.id)} empty="Not assigned" />
          </div>
          <div>
            <span className="org-label">Teams</span>
            {myTeams.length ? (
              <span className="org-chiprow">
                {myTeams.map((team) => <span className="org-name" key={team.id}>{team.name}</span>)}
              </span>
            ) : (
              <span className="org-none">Not assigned</span>
            )}
          </div>
          <div>
            <span className="org-label">Reports to</span>
            <Chips ids={myManagers} empty="Not set" />
          </div>
          {myRoles.length ? (
            <div>
              <span className="org-label">Role</span>
              <span className="org-chiprow">
                {myRoles.map((role) => <span className="org-name" key={role}>{role}</span>)}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {note ? <p className="org-note">{note}</p> : null}

      {manages ? (
        <>
          <div className="org-headline">
            <h2>Structure</h2>
            {canCreateDepartments(viewer) ? (
              <button type="button" className="org-add" onClick={addDepartment}>
                <Plus size={15} /> Department
              </button>
            ) : null}
          </div>

          {chart.departments.length === 0 ? <p className="org-none">No departments yet.</p> : null}

          {chart.departments.map((department) => {
            const editable = canEditDepartment(chart, viewer, department.id);
            const teams = chart.teams.filter((row) => row.departmentId === department.id);
            const mine = managedTeams.some((team) => team.departmentId === department.id);
            if (!editable && !mine) return null;
            const pool = assignableTo(chart, viewer, users, department.id);

            return (
              <section className="org-card" key={department.id}>
                <div className="org-headline">
                  <div>
                    <span className="org-eyebrow">Department</span>
                    <h3>{department.name}</h3>
                  </div>
                  {editable ? (
                    <div className="org-actions">
                      <button type="button" className="btn small" onClick={() => addTeam(department.id)}><Plus size={14} /> Team</button>
                      {isOrgAdmin(viewer) ? (
                        <button type="button" className="btn small" onClick={() => removeDepartment(department)}>Remove</button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="org-field">
                  <span className="org-label">Heads</span>
                  <Chips
                    ids={department.headIds || []}
                    empty="No head"
                    onRemove={isOrgAdmin(viewer) ? (id) => setHeads(department, (department.headIds || []).filter((row) => row !== id)) : undefined}
                  />
                  {isOrgAdmin(viewer) ? (
                    <AddPerson
                      pool={users.filter((row) => row.enabled !== false)}
                      chosen={department.headIds || []}
                      label="Add head"
                      onAdd={(id) => setHeads(department, [...(department.headIds || []), id])}
                    />
                  ) : null}
                </div>

                {teams.map((team) => (
                  <div className="org-team" key={team.id}>
                    <div className="org-headline">
                      <h4>{team.name}</h4>
                      {editable ? (
                        <button type="button" className="btn small" onClick={() => removeTeam(team)}>Remove</button>
                      ) : null}
                    </div>

                    <div className="org-field">
                      <span className="org-label">Lead</span>
                      <Chips
                        ids={team.leadIds || []}
                        empty="No lead"
                        onRemove={editable ? (id) => setTeamField(team, "leadIds", (team.leadIds || []).filter((row) => row !== id)) : undefined}
                      />
                      {editable ? (
                        <AddPerson
                          pool={pool}
                          chosen={team.leadIds || []}
                          label="Add lead"
                          onAdd={(id) => setTeamField(team, "leadIds", [...(team.leadIds || []), id])}
                        />
                      ) : null}
                    </div>

                    <div className="org-field">
                      <span className="org-label">Members</span>
                      <Chips
                        ids={team.memberIds || []}
                        empty="Nobody yet"
                        onRemove={editable ? (id) => setTeamField(team, "memberIds", (team.memberIds || []).filter((row) => row !== id)) : undefined}
                      />
                      {editable ? (
                        <AddPerson
                          pool={pool}
                          chosen={team.memberIds || []}
                          label="Add member"
                          onAdd={(id) => setTeamField(team, "memberIds", [...(team.memberIds || []), id])}
                        />
                      ) : null}
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
