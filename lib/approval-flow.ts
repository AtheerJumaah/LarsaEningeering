/* Shared approval-routing rules.
 *
 * The organisation chart is the source of the default route.  This module is
 * deliberately pure: the app shell, the structure editor, and the embedded
 * staff engine can all use the same rule without each inventing a slightly
 * different manager lookup or touching browser storage themselves.
 */

import { departmentMembershipIds } from "./org-membership.mjs";

export type ApprovalFlowConfig = Record<string, Record<string, string[]>>;
export type ApprovalFlowMeta = Record<string, Record<string, {
  mode: "default" | "manual";
  touchedAt?: string;
}>>;

export type ApprovalFlowUser = {
  id: string;
  name?: string;
  manager?: string;
  department?: string;
  enabled?: boolean;
  offboarded?: boolean;
  access?: string;
  role?: string;
};

export type ApprovalFlowOrg = {
  departments?: Array<{ id: string; name?: string; headIds?: string[] }>;
  teams?: Array<{
    id: string;
    departmentId?: string;
    leadIds?: string[];
    memberIds?: string[];
  }>;
  executivePositions?: Array<{
    id: string;
    title?: string;
    personIds?: string[];
    reportsToPositionIds?: string[];
  }>;
  reporting?: Record<string, string[]>;
};

/** One standing route governs every request raised by an employee. The
 * legacy keys remain mirrored in storage so older clients and requests keep
 * working while every current screen reads the one organizational route. */
export const UNIFIED_APPROVAL_FLOW_TYPE = "All Requests" as const;
export const LEGACY_APPROVAL_FLOW_TYPES = [
  "Leave",
  "Schedule",
  "Points",
  "Missed Clock",
  "Missed Break",
  "Extra Hours",
  "Hours Review",
] as const;
export const APPROVAL_FLOW_TYPES = [UNIFIED_APPROVAL_FLOW_TYPE] as const;

function sameId(value: unknown, user: ApprovalFlowUser): boolean {
  const needle = String(value || "").trim().toLowerCase();
  return Boolean(needle && (needle === user.id.toLowerCase() || needle === String(user.name || "").trim().toLowerCase()));
}

function active(users: ApprovalFlowUser[], id: string | undefined, employeeId: string): boolean {
  if (!id || id === employeeId) return false;
  const row = users.find((user) => user.id === id);
  return Boolean(row && row.enabled !== false && row.offboarded !== true);
}

function pushUnique(target: string[], candidate: string | undefined, users: ApprovalFlowUser[], employeeId: string) {
  if (!candidate || !active(users, candidate, employeeId) || target.includes(candidate)) return;
  target.push(candidate);
}

function executiveHolders(org: ApprovalFlowOrg | null | undefined, pattern: RegExp): string[] {
  const positions = Array.isArray(org?.executivePositions) ? org!.executivePositions! : [];
  return positions
    .filter((position) => pattern.test(String(position.title || "")))
    .flatMap((position) => Array.isArray(position.personIds) ? position.personIds : [])
    .filter(Boolean);
}

const CEO_TITLE = /\b(ceo|chief executive officer)\b/i;
const CEO_FALLBACK_TITLE = /\b(president|managing director)\b/i;
const COO_TITLE = /\b(coo|chief operating officer)\b/i;

function ceoHolders(org: ApprovalFlowOrg | null | undefined): string[] {
  const primary = executiveHolders(org, CEO_TITLE);
  return primary.length ? primary : executiveHolders(org, CEO_FALLBACK_TITLE);
}

/** Higher organizational authority may settle a lower-held approval step.
 * Department heads may act for a team leader in their own department, while
 * CEO and COO are company-wide alternates. */
export function canActForApprovalHolder(
  users: ApprovalFlowUser[],
  org: ApprovalFlowOrg | null | undefined,
  actorId: string | undefined,
  holderId: string | undefined,
): boolean {
  if (!actorId || !holderId) return false;
  if (actorId === holderId) return true;
  if (!active(users, actorId, holderId)) return false;
  const executiveAlternates = new Set([
    ...ceoHolders(org),
    ...executiveHolders(org, COO_TITLE),
  ]);
  if (executiveAlternates.has(actorId)) return true;

  const departments = Array.isArray(org?.departments) ? org!.departments! : [];
  const teams = Array.isArray(org?.teams) ? org!.teams! : [];
  return teams.some((team) =>
    (team.leadIds || []).includes(holderId)
    && departments.some((department) =>
      department.id === team.departmentId && (department.headIds || []).includes(actorId),
    ),
  );
}

/**
 * Build the default route for one employee.
 *
 * Team lead is the first step and the department head is the second step. If
 * the employee has no team lead, the department head is the only step. A
 * named direct manager is a safe fallback when the chart has not been set up
 * yet (or when a person is not on a team); it is never added after a complete
 * team-lead → department-head route. Department heads route to the CEO. COO
 * can act for that CEO step without becoming another sequential step.
 */
export function defaultApprovalChain(
  users: ApprovalFlowUser[],
  org: ApprovalFlowOrg | null | undefined,
  employeeId: string,
): string[] {
  const employee = users.find((user) => user.id === employeeId);
  if (!employee || employee.enabled === false || employee.offboarded === true) return [];

  const departments = Array.isArray(org?.departments) ? org!.departments! : [];
  const teams = Array.isArray(org?.teams) ? org!.teams! : [];
  const employeeTeams = teams.filter((team) =>
    (team.memberIds || []).includes(employeeId) || (team.leadIds || []).includes(employeeId),
  );

  const configuredManagers = Array.isArray(org?.reporting?.[employeeId])
    ? org!.reporting![employeeId]
    : [];
  /* Membership, display, and routing share the same many-to-many rule. */
  const departmentIds = departmentMembershipIds(org, employee);

  /* A department head never approves their own request. Company leadership
     is the next default layer: CEO is recorded in the flow, while COO is an
     authorized alternate at decision time. */
  const isDepartmentHead = departments.some((department) => (department.headIds || []).includes(employeeId));
  if (isDepartmentHead) {
    const executiveRoute: string[] = [];
    const ceoIds = ceoHolders(org);
    const fallbackCooIds = ceoIds.length ? [] : executiveHolders(org, COO_TITLE);
    [...ceoIds, ...fallbackCooIds].forEach((id) => pushUnique(executiveRoute, id, users, employeeId));
    if (executiveRoute.length) return executiveRoute.slice(0, 3);
  }

  const leaders: string[] = [];
  employeeTeams.forEach((team) => {
    (team.leadIds || []).forEach((id) => pushUnique(leaders, id, users, employeeId));
  });

  const heads: string[] = [];
  departments.filter((department) => departmentIds.has(department.id)).forEach((department) => {
    (department.headIds || []).forEach((id) => pushUnique(heads, id, users, employeeId));
  });

  const route: string[] = [];
  leaders.forEach((id) => pushUnique(route, id, users, employeeId));
  heads.forEach((id) => pushUnique(route, id, users, employeeId));
  if (route.length) return route.slice(0, 3);

  configuredManagers.forEach((id) => pushUnique(route, id, users, employeeId));
  if (!route.length) {
    const namedManager = users.find((user) => sameId(employee.manager, user));
    if (namedManager) pushUnique(route, namedManager.id, users, employeeId);
  }
  return route.slice(0, 3);
}

/**
 * Seed or refresh defaults without touching explicit Approval Flow edits.
 * Existing flowConfig entries with no metadata are treated as manual for
 * backwards compatibility: they may have been written by an older editor.
 */
export function ensureDefaultApprovalFlows(
  users: ApprovalFlowUser[],
  org: ApprovalFlowOrg | null | undefined,
  inputConfig: ApprovalFlowConfig | null | undefined,
  inputMeta: ApprovalFlowMeta | null | undefined,
): { flowConfig: ApprovalFlowConfig; flowConfigMeta: ApprovalFlowMeta; changed: boolean } {
  const beforeConfig = JSON.stringify(inputConfig || {});
  const beforeMeta = JSON.stringify(inputMeta || {});
  const flowConfig: ApprovalFlowConfig = JSON.parse(JSON.stringify(inputConfig || {}));
  const flowConfigMeta: ApprovalFlowMeta = JSON.parse(JSON.stringify(inputMeta || {}));

  users.filter((user) => user.enabled !== false && user.offboarded !== true).forEach((employee) => {
    const own = flowConfig[employee.id] || {};
    const meta = flowConfigMeta[employee.id] || {};
    const nextOwn = { ...own };
    const nextMeta = { ...meta };
    const unifiedExisting = Array.isArray(own[UNIFIED_APPROVAL_FLOW_TYPE])
      ? own[UNIFIED_APPROVAL_FLOW_TYPE].filter(Boolean)
      : [];
    const unifiedMeta = nextMeta[UNIFIED_APPROVAL_FLOW_TYPE];
    const legacyManualType = LEGACY_APPROVAL_FLOW_TYPES.find((type) =>
      nextMeta[type]?.mode === "manual" || (Array.isArray(own[type]) && own[type].length > 0 && !nextMeta[type]),
    );
    const migratedLegacy = legacyManualType && Array.isArray(own[legacyManualType])
      ? own[legacyManualType].filter(Boolean)
      : [];
    const mode: "default" | "manual" = unifiedMeta?.mode === "manual" || legacyManualType
      ? "manual"
      : "default";
    const route = mode === "manual"
      ? (unifiedMeta?.mode === "manual" ? unifiedExisting : migratedLegacy)
      : defaultApprovalChain(users, org, employee.id);
    const touchedAt = unifiedMeta?.touchedAt
      || (legacyManualType ? nextMeta[legacyManualType]?.touchedAt : undefined);

    if (route.length) nextOwn[UNIFIED_APPROVAL_FLOW_TYPE] = route;
    else delete nextOwn[UNIFIED_APPROVAL_FLOW_TYPE];
    nextMeta[UNIFIED_APPROVAL_FLOW_TYPE] = { mode, ...(touchedAt ? { touchedAt } : {}) };

    LEGACY_APPROVAL_FLOW_TYPES.forEach((type) => {
      if (route.length) nextOwn[type] = route;
      else delete nextOwn[type];
      nextMeta[type] = { mode, ...(touchedAt ? { touchedAt } : {}) };
    });
    delete nextOwn.Performance;
    delete nextMeta.Performance;
    if (Object.keys(nextOwn).length) flowConfig[employee.id] = nextOwn;
    else delete flowConfig[employee.id];
    if (Object.keys(nextMeta).length) flowConfigMeta[employee.id] = nextMeta;
  });

  const changed = beforeConfig !== JSON.stringify(flowConfig) || beforeMeta !== JSON.stringify(flowConfigMeta);
  return { flowConfig, flowConfigMeta, changed };
}

