import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the approved Organization Chart replaces both Structure entries", async () => {
  const [page, structure2] = await Promise.all([read("app/page.tsx"), read("app/OrgStructure2.tsx")]);
  assert.match(page, /id: "org-chart", label: "Organization Chart", description: "Visual team builder and assignment matrix"/);
  assert.doesNotMatch(page, /id: "org-chart-2"/);
  assert.doesNotMatch(page, /<OrgStructure\b/);
  assert.match(page, /tab === "organization" && <OrgStructure2/);
  assert.match(structure2, /effectiveOrg\(users\)/);
  assert.match(structure2, /writeOrg\(draft\)/);
  assert.match(structure2, /pushSyncedKeyNow\("larsaStaffV8"\)/);
});

test("Organization Chart supports overlapping roles, drag assignment, matrix review, and explicit saving", async () => {
  const structure2 = await read("app/OrgStructure2.tsx");
  assert.match(structure2, /Drag the same person into several teams or leadership roles/);
  assert.match(structure2, /kind="head"/);
  assert.match(structure2, /kind="lead"/);
  assert.match(structure2, /kind="member"/);
  assert.match(structure2, /kind="executive"/);
  assert.match(structure2, /Executive positions/);
  assert.match(structure2, /addExecutivePosition/);
  assert.match(structure2, /function PeopleSortControl/);
  assert.match(structure2, /function PeoplePicker/);
  assert.match(structure2, /Choose person/);
  assert.match(structure2, /Search all people/);
  assert.match(structure2, />A–Z<\/button>/);
  assert.match(structure2, />Z–A<\/button>/);
  assert.match(structure2, /aria-expanded=\{peopleOpen\}/);
  assert.match(structure2, /closest<HTMLElement>\("\.native"\)/);
  assert.match(structure2, /requestAnimationFrame\(scrollAtEdge\)/);
  assert.match(structure2, /surface\.scrollTop \+= speed/);
  assert.match(structure2, /Assignment matrix/);
  assert.match(structure2, /Additional reporting lines/);
  assert.match(structure2, /Save changes/);
  assert.match(structure2, /disabled=\{!draft \|\| saving\}/);
});

test("Organization Chart persists executive positions without breaking older saved charts", async () => {
  const org = await read("lib/org.ts");
  assert.match(org, /export type ExecutivePosition/);
  assert.match(org, /executivePositions\?: ExecutivePosition\[\]/);
  assert.match(org, /Array\.isArray\(org\.executivePositions\)/);
  assert.match(org, /\.\.\.\(executivePositions \? \{ executivePositions \} : \{\}\)/);
});
