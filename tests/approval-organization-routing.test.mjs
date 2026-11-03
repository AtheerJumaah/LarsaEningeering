import test from "node:test";
import assert from "node:assert/strict";
import {
  canActForApprovalHolder,
  defaultApprovalChain,
  ensureDefaultApprovalFlows,
} from "../lib/approval-flow.ts";

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

test("a department head defaults to CEO approval", () => {
  assert.deepEqual(defaultApprovalChain(users, org, "head-a"), ["ceo"]);
  assert.deepEqual(defaultApprovalChain(users, org, "head-b"), ["ceo"]);
});

test("COO can act for a CEO-held step but unrelated executives cannot", () => {
  assert.equal(canActForApprovalHolder(users, org, "ceo", "ceo"), true);
  assert.equal(canActForApprovalHolder(users, org, "coo", "ceo"), true);
  assert.equal(canActForApprovalHolder(users, org, "vp", "ceo"), false);
  assert.equal(canActForApprovalHolder(users, org, "coo", "head-a"), false);
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
  // Unedited request types still receive the CEO default.
  assert.deepEqual(result.flowConfig["head-a"].Schedule, ["ceo"]);
});
