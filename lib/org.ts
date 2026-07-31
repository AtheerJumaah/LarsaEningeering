"use client";

/* The company's shape -- departments, teams, and who answers to whom -- plus
 * the rules that turn that shape into what a person is allowed to look at.
 *
 * Two things this deliberately does NOT assume, because the company does not
 * work that way: that a person belongs to one team, and that a person has one
 * boss. Somebody can sit on the structural team and the sales team, lead one
 * of them, and head a department at the same time. Every relationship here is
 * therefore a list, never a single field.
 *
 * The chart does not start empty. Every staff record already carries a
 * department, and several carry a role that says plainly who leads ("Structural
 * Team Leader", "Architectural Team Leader"), so the first view is built from
 * what is already known rather than asking one person to type the whole company
 * in by hand. That derived chart is only a starting point -- the moment anybody
 * edits it, the edited version is stored and used from then on.
 *
 * Stored inside the same larsaStaffV8 blob as the staff list, so it syncs
 * through Supabase to everyone without any new plumbing.
 */

const STORE_KEY = "larsaStaffV8";

export type Department = {
  id: string;
  name: string;
  /* More than one, because a department can be jointly run. */
  headIds: string[];
};

export type Team = {
  id: string;
  departmentId: string;
  name: string;
  leadIds: string[];
  memberIds: string[];
};

export type OrgChart = {
  departments: Department[];
  teams: Team[];
};

export type OrgUser = {
  id: string;
  name?: string;
  access?: string;
  role?: string;
  department?: string;
  manager?: string;
  enabled?: boolean;
  teamGrants?: string[];
  departmentGrants?: string[];
};

export const EMPTY_ORG: OrgChart = { departments: [], teams: [] };

function readBlob(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readStoredOrg(): OrgChart | null {
  const blob = readBlob();
  const org = blob ? (blob.org as OrgChart | undefined) : undefined;
  if (!org || typeof org !== "object" || !Array.isArray(org.departments)) return null;
  return { departments: org.departments, teams: Array.isArray(org.teams) ? org.teams : [] };
}

export function writeOrg(next: OrgChart): boolean {
  const blob = readBlob();
  if (!blob) return false;
  blob.org = next;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(blob));
    return true;
  } catch {
    return false;
  }
}

export function newId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const noise = Math.floor(Math.random() * 46656).toString(36);
  return prefix + "_" + stamp + noise;
}

function looksLikeLeader(role: string | undefined): boolean {
  const text = String(role || "").toLowerCase();
  return (
    text.indexOf("team lead") >= 0 ||
    text.indexOf("head") >= 0 ||
    text.indexOf("manager") >= 0 ||
    text.indexOf("ceo") >= 0
  );
}

/* The chart implied by the staff list on its own: one department per distinct
   department name, everybody filed under theirs, and anyone whose job title
   says they lead put forward as head. Ids are derived from the name so the
   same chart comes out on every device until somebody saves a real one. */
export function buildFallbackOrg(users: OrgUser[]): OrgChart {
  const byName = new Map<string, OrgUser[]>();
  users.forEach((user) => {
    if (user.enabled === false) return;
    const name = String(user.department || "").trim();
    if (!name) return;
    const list = byName.get(name) || [];
    list.push(user);
    byName.set(name, list);
  });

  const departments: Department[] = [];
  const teams: Team[] = [];
  [...byName.keys()].sort().forEach((name) => {
    const members = byName.get(name) || [];
    const id = "dep_auto_" + name.toLowerCase().split(" ").join("_");
    departments.push({ id, name, headIds: members.filter((row) => looksLikeLeader(row.role)).map((row) => row.id) });
    teams.push({
      id: "team_auto_" + name.toLowerCase().split(" ").join("_"),
      departmentId: id,
      name: name,
      leadIds: members.filter((row) => looksLikeLeader(row.role)).map((row) => row.id),
      memberIds: members.map((row) => row.id),
    });
  });
  return { departments, teams };
}

/* What the app should actually use: a saved chart if there is one, otherwise
   the one implied by the staff list. */
export function effectiveOrg(users: OrgUser[]): OrgChart {
  const stored = readStoredOrg();
  if (stored && stored.departments.length) return stored;
  return buildFallbackOrg(users);
}

export function isOrgAdmin(user: OrgUser | null | undefined): boolean {
  return Boolean(user && user.access === "Super Admin");
}

export function departmentsHeadedBy(org: OrgChart, userId: string): Department[] {
  return org.departments.filter((row) => Array.isArray(row.headIds) && row.headIds.indexOf(userId) >= 0);
}

export function teamsLedBy(org: OrgChart, userId: string): Team[] {
  return org.teams.filter((row) => Array.isArray(row.leadIds) && row.leadIds.indexOf(userId) >= 0);
}

export function teamsContaining(org: OrgChart, userId: string): Team[] {
  return org.teams.filter((row) => Array.isArray(row.memberIds) && row.memberIds.indexOf(userId) >= 0);
}

export function departmentsContaining(org: OrgChart, userId: string): Department[] {
  const ids = new Set(teamsContaining(org, userId).map((team) => team.departmentId));
  return org.departments.filter((row) => ids.has(row.id));
}

/* Anyone named as somebody's manager on their staff record. Kept separate from
   the chart so that filling in "manager" on a person is enough to give their
   manager a team to work with, without anybody drawing the chart first. */
export function directReportsOf(users: OrgUser[], manager: OrgUser | null | undefined): OrgUser[] {
  if (!manager) return [];
  const id = manager.id;
  const name = String(manager.name || "").trim().toLowerCase();
  return users.filter((row) => {
    if (row.id === id) return false;
    const value = String(row.manager || "").trim().toLowerCase();
    if (!value) return false;
    return value === id.toLowerCase() || value === name;
  });
}

/* Every team this person may look into: they run the company, they head the
   department it sits in, they lead it, or it was granted to them by hand.
   Being merely a member is not on that list -- sitting on a team does not
   entitle you to your colleagues' timesheets. */
export function teamsVisibleTo(org: OrgChart, user: OrgUser | null | undefined): Team[] {
  if (!user) return [];
  if (isOrgAdmin(user)) return org.teams;

  const departmentIds = new Set(departmentsHeadedBy(org, user.id).map((row) => row.id));
  (user.departmentGrants || []).forEach((id) => departmentIds.add(id));

  const teamIds = new Set(teamsLedBy(org, user.id).map((row) => row.id));
  (user.teamGrants || []).forEach((id) => teamIds.add(id));

  return org.teams.filter((team) => teamIds.has(team.id) || departmentIds.has(team.departmentId));
}

export function staffIdsVisibleTo(org: OrgChart, user: OrgUser | null | undefined, users: OrgUser[]): Set<string> {
  const ids = new Set<string>();
  if (!user) return ids;
  ids.add(user.id);
  teamsVisibleTo(org, user).forEach((team) => {
    (team.memberIds || []).forEach((id) => ids.add(id));
    (team.leadIds || []).forEach((id) => ids.add(id));
  });
  directReportsOf(users, user).forEach((row) => ids.add(row.id));
  return ids;
}

/* The portal is open to everybody: an ordinary engineer opens it to see which
   department and teams they are part of and who they report to. What differs
   is how much of it they can see and change, not whether they get in. */
export function canSeeOrgPortal(): boolean {
  return true;
}

/* Whether this person is responsible for anybody, and so gets the management
   half of the portal. */
export function isResponsibleForOthers(org: OrgChart, user: OrgUser | null | undefined, users: OrgUser[]): boolean {
  if (!user) return false;
  if (isOrgAdmin(user)) return true;
  if (departmentsHeadedBy(org, user.id).length) return true;
  if (teamsLedBy(org, user.id).length) return true;
  if ((user.teamGrants || []).length || (user.departmentGrants || []).length) return true;
  return directReportsOf(users, user).length > 0;
}

/* Super Admin shapes the whole chart. A department head shapes their own
   department, so forming a team does not have to go through one person. */
export function canEditDepartment(
  org: OrgChart,
  user: OrgUser | null | undefined,
  departmentId: string,
  users: OrgUser[] = [],
): boolean {
  if (isOrgAdmin(user)) return true;
  if (!user) return false;
  if (departmentsHeadedBy(org, user.id).some((row) => row.id === departmentId)) return true;
  const directIds = new Set(directReportsOf(users, user).map((row) => row.id));
  return org.teams.some((team) => team.departmentId === departmentId
    && [...(team.memberIds || []), ...(team.leadIds || [])].some((id) => directIds.has(id)));
}

export function canCreateDepartments(user: OrgUser | null | undefined): boolean {
  return isOrgAdmin(user);
}

/* Who a given person is allowed to put on a team. Super Admin may pick anyone;
   a head picks from their department plus anyone reporting to them. */
export function assignableTo(org: OrgChart, user: OrgUser | null | undefined, users: OrgUser[], departmentId: string): OrgUser[] {
  const active = users.filter((row) => row.enabled !== false);
  if (isOrgAdmin(user)) return active;
  if (!user) return [];
  const allowed = new Set<string>();
  directReportsOf(active, user).forEach((row) => allowed.add(row.id));
  org.teams
    .filter((team) => team.departmentId === departmentId)
    .forEach((team) => {
      (team.memberIds || []).forEach((id) => allowed.add(id));
      (team.leadIds || []).forEach((id) => allowed.add(id));
    });
  return active.filter((row) => allowed.has(row.id));
}

export function departmentById(org: OrgChart, id: string): Department | null {
  return org.departments.find((row) => row.id === id) || null;
}

export function teamById(org: OrgChart, id: string): Team | null {
  return org.teams.find((row) => row.id === id) || null;
}

/* Everyone this person answers to: the leads of every team they sit on, the
   heads of those teams' departments, and whoever is named on their record. */
export function managersOf(org: OrgChart, userId: string, users: OrgUser[]): string[] {
  const ids = new Set<string>();
  teamsContaining(org, userId).forEach((team) => {
    (team.leadIds || []).forEach((id) => { if (id !== userId) ids.add(id); });
    const department = departmentById(org, team.departmentId);
    if (department) (department.headIds || []).forEach((id) => { if (id !== userId) ids.add(id); });
  });
  const self = users.find((row) => row.id === userId);
  const named = String(self && self.manager ? self.manager : "").trim().toLowerCase();
  if (named) {
    const match = users.find((row) => row.id.toLowerCase() === named || String(row.name || "").trim().toLowerCase() === named);
    if (match && match.id !== userId) ids.add(match.id);
  }
  return [...ids];
}

export function rolesOf(org: OrgChart, user: OrgUser): string[] {
  const roles: string[] = [];
  if (isOrgAdmin(user)) roles.push("Super Admin");
  departmentsHeadedBy(org, user.id).forEach((row) => roles.push("Head of " + row.name));
  teamsLedBy(org, user.id).forEach((row) => roles.push("Lead of " + row.name));
  return roles;
}
