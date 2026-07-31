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
 * Access follows the structure rather than being maintained separately, so
 * moving somebody between teams moves their manager's view of them with them.
 * On top of that a specific team or department can be granted to somebody by
 * hand -- a coordinator who needs sight of a team they are not on, say --
 * which is what teamGrants and departmentGrants on the staff record are for.
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

/* Only the staff fields this module cares about. */
export type OrgUser = {
  id: string;
  name?: string;
  access?: string;
  department?: string;
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

export function readOrg(): OrgChart {
  const blob = readBlob();
  const org = blob ? (blob.org as OrgChart | undefined) : undefined;
  if (!org || typeof org !== "object") return EMPTY_ORG;
  return {
    departments: Array.isArray(org.departments) ? org.departments : [],
    teams: Array.isArray(org.teams) ? org.teams : [],
  };
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

/* Super Admin sees and edits everything; this is the one blanket exception. */
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

/* Every team this person may look into, from any route: they run the company,
   they head the department it sits in, they lead it, or it was granted to them
   by hand. Being merely a member is not on that list -- sitting on a team does
   not entitle you to your colleagues' timesheets. */
export function teamsVisibleTo(org: OrgChart, user: OrgUser | null | undefined): Team[] {
  if (!user) return [];
  if (isOrgAdmin(user)) return org.teams;

  const departmentIds = new Set(departmentsHeadedBy(org, user.id).map((row) => row.id));
  (user.departmentGrants || []).forEach((id) => departmentIds.add(id));

  const teamIds = new Set(teamsLedBy(org, user.id).map((row) => row.id));
  (user.teamGrants || []).forEach((id) => teamIds.add(id));

  return org.teams.filter((team) => teamIds.has(team.id) || departmentIds.has(team.departmentId));
}

/* The people behind those teams, which is what every report in the portal is
   scoped to. A manager always appears in their own list so the totals they see
   include themselves. */
export function staffIdsVisibleTo(org: OrgChart, user: OrgUser | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!user) return ids;
  ids.add(user.id);
  teamsVisibleTo(org, user).forEach((team) => {
    (team.memberIds || []).forEach((id) => ids.add(id));
    (team.leadIds || []).forEach((id) => ids.add(id));
  });
  return ids;
}

/* Whether the portal is worth showing this person at all. */
export function canSeeOrgPortal(org: OrgChart, user: OrgUser | null | undefined): boolean {
  if (!user) return false;
  if (isOrgAdmin(user)) return true;
  return teamsVisibleTo(org, user).length > 0;
}

/* Super Admin edits the whole chart. A department head edits only inside the
   departments they actually head -- they can shape their own teams without
   being able to invent a department or reach into somebody else's. */
export function canEditDepartment(org: OrgChart, user: OrgUser | null | undefined, departmentId: string): boolean {
  if (isOrgAdmin(user)) return true;
  if (!user) return false;
  return departmentsHeadedBy(org, user.id).some((row) => row.id === departmentId);
}

export function canCreateDepartments(user: OrgUser | null | undefined): boolean {
  return isOrgAdmin(user);
}

export function departmentById(org: OrgChart, id: string): Department | null {
  return org.departments.find((row) => row.id === id) || null;
}

export function teamById(org: OrgChart, id: string): Team | null {
  return org.teams.find((row) => row.id === id) || null;
}

/* Everyone this person answers to: the leads of every team they sit on, plus
   the heads of those teams' departments. More than one is normal. */
export function managersOf(org: OrgChart, userId: string): string[] {
  const ids = new Set<string>();
  teamsContaining(org, userId).forEach((team) => {
    (team.leadIds || []).forEach((id) => { if (id !== userId) ids.add(id); });
    const department = departmentById(org, team.departmentId);
    if (department) (department.headIds || []).forEach((id) => { if (id !== userId) ids.add(id); });
  });
  return [...ids];
}

/* The roles a person holds, for showing next to their name. Somebody can
   easily hold several. */
export function rolesOf(org: OrgChart, user: OrgUser): string[] {
  const roles: string[] = [];
  if (isOrgAdmin(user)) roles.push("Super Admin");
  departmentsHeadedBy(org, user.id).forEach((row) => roles.push("Head of " + row.name));
  teamsLedBy(org, user.id).forEach((row) => roles.push("Lead of " + row.name));
  const memberships = teamsContaining(org, user.id);
  if (!roles.length && memberships.length) roles.push(memberships.map((row) => row.name).join(", "));
  return roles;
}
