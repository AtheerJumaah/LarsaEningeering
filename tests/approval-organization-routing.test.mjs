import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_APPROVAL_FLOW_TYPES,
  UNIFIED_APPROVAL_FLOW_TYPE,
  canActForApprovalHolder,
  defaultApprovalChain,
  ensureDefaultApprovalFlows,
  nextUncoveredApprovalStep,
} from "../lib/approval-flow.ts";
import { departmentMemberships } from "../lib/org-membership.mjs";

const users = [
  { id: "member", name: "Member", enabled: true },
  { id: "lead", name: "Team Lead", enabled: true },
  { id: "head-a", name: "Department Head A", enabled: true },
  { id: "head-b", name: "Department Head B", enabled: true },
  { id: "ceo", name: "CEO", enabled: true },
  { id: "coo", name: "COO", enabled: true },
  { id: "vp", name: "VP", enabled: true },
];

const org = {
  departments: [
    { id: "department-a", name: "Department A", headIds: ["head-a"] },
    { id: "department-b", name: "Department B", headIds: ["head-b"] },
  ],
  teams: [
    { id: "team-a", departmentId: "department-a", leadIds: ["lead"], memberIds: ["member"] },
  ],
  // The second line makes the employee an effective member of Department B
  // for routing without erasing their Department A team membership.
  reporting: { member: ["head-b"] },
  executivePositions: [
    { id: "position-ceo", title: "CEO", personIds: ["ceo"] },
    { id: "position-coo", title: "COO", personIds: ["coo"], reportsToPositionIds: ["position-ceo"] },
    { id: "position-vp", title: "VP", personIds: ["vp"], reportsToPositionIds: ["position-ceo"] },
  ],
};

test("team membership plus a second department reporting line builds one ordered route", () => {
  assert.deepEqual(defaultApprovalChain(users, org, "member"), ["lead", "head-a", "head-b"]);
});

test("department display comes from every chart role instead of the stale single profile field", () => {
  const staleMember = { ...users[0], department: "Unassigned" };
  assert.deepEqual(
    departmentMemberships(org, staleMember).map((department) => department.name),
    ["Department A", "Department B"],
  );
  assert.deepEqual(
    departmentMemberships(org, users[1]).map((department) => department.name),
    ["Department A"],
  );
  assert.deepEqual(
    departmentMemberships(org, users[2]).map((department) => department.name),
    ["Department A"],
  );
});

test("saved default flows refresh when chart membership changes but manual routes do not", () => {
  const seeded = ensureDefaultApprovalFlows(users, org, {}, {});
  const movedOrg = {
    ...org,
    teams: [{ id: "team-b", departmentId: "department-b", leadIds: [], memberIds: ["member"] }],
    reporting: {},
  };
  const refreshed = ensureDefaultApprovalFlows(users, movedOrg, seeded.flowConfig, seeded.flowConfigMeta);
  assert.deepEqual(refreshed.flowConfig.member.Leave, ["head-b"]);
  assert.deepEqual(refreshed.flowConfig.member[UNIFIED_APPROVAL_FLOW_TYPE], ["head-b"]);

  const manual = ensureDefaultApprovalFlows(
    users,
    movedOrg,
    { ...seeded.flowConfig, member: { ...seeded.flowConfig.member, Leave: ["vp"] } },
    { ...seeded.flowConfigMeta, member: { ...seeded.flowConfigMeta.member, Leave: { mode: "manual" } } },
  );
  assert.deepEqual(manual.flowConfig.member.Leave, ["vp"]);
  assert.deepEqual(manual.flowConfig.member[UNIFIED_APPROVAL_FLOW_TYPE], ["vp"]);
  LEGACY_APPROVAL_FLOW_TYPES.forEach((type) => assert.deepEqual(manual.flowConfig.member[type], ["vp"]));
});

test("a department head defaults to CEO approval", () => {
  assert.deepEqual(defaultApprovalChain(users, org, "head-a"), ["ceo"]);
  assert.deepEqual(defaultApprovalChain(users, org, "head-b"), ["ceo"]);
});

test("department heads and company executives can act for lower organizational holders", () => {
  assert.equal(canActForApprovalHolder(users, org, "ceo", "ceo"), true);
  assert.equal(canActForApprovalHolder(users, org, "coo", "ceo"), true);
  assert.equal(canActForApprovalHolder(users, org, "vp", "ceo"), false);
  assert.equal(canActForApprovalHolder(users, org, "head-a", "lead"), true);
  assert.equal(canActForApprovalHolder(users, org, "head-b", "lead"), false);
  assert.equal(canActForApprovalHolder(users, org, "ceo", "head-a"), true);
  assert.equal(canActForApprovalHolder(users, org, "coo", "head-a"), true);
});

test("higher authority settles covered steps without asking the same CEO or head again", () => {
  const route = ["lead", "head-a", "ceo"];
  assert.equal(nextUncoveredApprovalStep(users, org, route, 0, "lead"), 1);
  assert.equal(nextUncoveredApprovalStep(users, org, route, 0, "head-a"), 2);
  assert.equal(nextUncoveredApprovalStep(users, org, route, 0, "ceo"), null);
  assert.equal(nextUncoveredApprovalStep(users, org, route, 0, "coo"), null);
  assert.equal(nextUncoveredApprovalStep(users, org, route, 0, "vp", true), null);
});

test("manual cross-department steps remain until a person who covers them acts", () => {
  assert.equal(nextUncoveredApprovalStep(users, org, ["lead", "head-a", "head-b"], 0, "head-a"), 2);
  assert.equal(nextUncoveredApprovalStep(users, org, ["lead", "head-a", "head-b"], 0, "ceo"), null);
});

test("manual Approval Flow edits remain authoritative", () => {
  const result = ensureDefaultApprovalFlows(
    users,
    org,
    { "head-a": { Leave: ["vp"] } },
    { "head-a": { Leave: { mode: "manual" } } },
  );
  assert.deepEqual(result.flowConfig["head-a"].Leave, ["vp"]);
  assert.equal(result.flowConfigMeta["head-a"].Leave.mode, "manual");
  // A legacy manual route migrates into the one unified route and every
  // compatibility key mirrors it.
  assert.deepEqual(result.flowConfig["head-a"][UNIFIED_APPROVAL_FLOW_TYPE], ["vp"]);
  assert.deepEqual(result.flowConfig["head-a"].Schedule, ["vp"]);
});
