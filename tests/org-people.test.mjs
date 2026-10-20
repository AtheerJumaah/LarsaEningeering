import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* A team or department can reference a staff id that no longer resolves to a
 * real person -- someone removed, or leftover seed data. The old behaviour
 * invented a placeholder person called "Unknown" to fill that gap, which is
 * exactly backwards: nobody is named "Unknown", the field should just read
 * empty until somebody deliberately assigns a real person to it. These tests
 * pin that every place in the app that turns a staff id into a display name
 * treats an unresolved id as absent rather than as a person to fabricate.
 */

test("Org Structure never fabricates a placeholder person named Unknown", async () => {
  const structure = await read("app/OrgStructure.tsx");

  // nameOf resolves only real, non-empty names; anything else is "" so a
  // caller can tell "known" apart from "not known" without a magic string.
  assert.match(
    structure,
    /const nameOf = useMemo\(\(\) => \{\s*\n\s*const map = new Map<string, string>\(\);\s*\n\s*users\.forEach\(\(row\) => \{\s*\n\s*const name = String\(row\.name \|\| ""\)\.trim\(\);\s*\n\s*if \(name\) map\.set\(row\.id, name\);\s*\n\s*\}\);\s*\n\s*return \(id: string\) => map\.get\(id\) \|\| "";/,
  );
  assert.match(structure, /function isKnown\(id: string\): boolean \{\s*\n\s*return Boolean\(nameOf\(id\)\);\s*\n\s*\}/);

  // membersOf feeds headcounts, unassigned counts, and team-size badges --
  // all of it derived through this one function, so filtering here is enough
  // to keep every downstream number honest about who is actually assigned.
  assert.match(
    structure,
    /function membersOf\(team: Team\): string\[\] \{\s*\n\s*return \[\.\.\.new Set\(\(team\.leadIds \|\| \[\]\)\.concat\(team\.memberIds \|\| \[\]\)\)\]\.filter\(isKnown\);/,
  );

  // Chips renders heads, leads and members alike; filtering ids there before
  // both the emptiness check and the chip list is what makes "No head" /
  // "No lead" / "Nobody yet" show up instead of a fake person.
  assert.match(structure, /function Chips\(\{ ids, onRemove, empty, onReorder \}/);
  assert.match(structure, /const visible = ids\.filter\(isKnown\);\s*\n\s*if \(!visible\.length\) return <span className="struct-empty">\{empty\}<\/span>;/);
  assert.match(structure, /\{visible\.map\(\(id\) => \(/);

  assert.ok(!/\|\|\s*"Unknown"/.test(structure), "OrgStructure must not fall back to a literal \"Unknown\" anywhere");
});

test("the Engineering Management dashboard applies the same rule to heads, leads and managers", async () => {
  const hier = await read("app/HierarchyDashboard.tsx");

  assert.match(
    hier,
    /const nameOf = useMemo\(\(\) => \{\s*\n\s*const map = new Map<string, string>\(\);\s*\n\s*users\.forEach\(\(row\) => \{\s*\n\s*const name = String\(row\.name \|\| ""\)\.trim\(\);\s*\n\s*if \(name\) map\.set\(row\.id, name\);\s*\n\s*\}\);\s*\n\s*return \(id: string\) => map\.get\(id\) \|\| "";/,
  );
  assert.match(hier, /function isKnown\(id: string\): boolean \{\s*\n\s*return Boolean\(nameOf\(id\)\);\s*\n\s*\}/);

  // A department's headIds, a viewer's team leads, and a viewer's managers
  // are all read straight off the stored chart -- each is filtered before
  // it is ever handed to nameOf for display.
  assert.match(hier, /const heads = \(department\.headIds \|\| \[\]\)\.filter\(isKnown\);/);
  assert.match(hier, /\(id\) => id !== viewer\.id && isKnown\(id\),/);
  assert.match(hier, /const myManagers = viewer \? managersOf\(org, viewer\.id, users\)\.filter\(isKnown\) : \[\];/);

  assert.ok(!/\|\|\s*"Unknown"/.test(hier), "HierarchyDashboard must not fall back to a literal \"Unknown\" anywhere");
  assert.ok(!/nameOf\(id\) !== "Unknown"/.test(hier), "the old string-comparison workaround for filtering heads must be gone");
});

test("structure dropdowns are not nested inside draggable cards", async () => {
  const structure = await read("app/OrgStructure.tsx");

  // Native select menus close when a draggable ancestor captures the pointer
  // as a drag. Reordering is deliberately initiated only from the grip handle
  // so Add head/lead/member menus remain open and selectable.
  assert.match(structure, /className=\{"struct-dep"[\s\S]*?onDragOver=/);
  assert.doesNotMatch(structure, /className=\{"struct-dep"[\s\S]*?key=\{department\.id\}\s*draggable/);
  assert.doesNotMatch(structure, /className=\{"struct-team"[\s\S]*?key=\{team\.id\}\s*draggable/);
  assert.match(structure, /className="hier-drag"[\s\S]*?role="button"[\s\S]*?draggable/);
  assert.match(structure, /className="struct-picker"/);
  assert.doesNotMatch(structure, /closeWhenPointerLeaves|pointermove/);
  assert.match(structure, /document\.addEventListener\("pointerdown", closeOutside\)/);
  assert.match(structure, /role="listbox"/);
  assert.match(structure, /onClick=\{\(\) => \{ onAdd\(row\.id\); setOpen\(false\); setQuery\(""\); \}\}/);
  assert.match(structure, /className="struct-select-search"/);
  assert.match(structure, /No matching people/);
});

test("every current and future department uses the same searchable assignment picker", async () => {
  const structure = await read("app/OrgStructure.tsx");

  // AddPerson is one stable component, while departments and teams are data
  // loops. That combination means a newly-created department/team cannot
  // accidentally fall back to a different, fragile control.
  assert.equal((structure.match(/function AddPerson\(/g) || []).length, 1);
  assert.equal((structure.match(/<AddPerson\b/g) || []).length, 3);
  assert.match(structure, /\{departments\.map\(\(department\) => \{/);
  assert.match(structure, /\{teams\.map\(\(team\) => \(/);
  assert.match(structure, /label="Add head"/);
  assert.match(structure, /label="Add lead"/);
  assert.match(structure, /label="Add member"/);
  assert.match(structure, /className="struct-select-search"/);
});

test("authorized structure editors can rename departments and teams without replacing the chart", async () => {
  const structure = await read("app/OrgStructure.tsx");

  // Renaming is a small update to the existing chart. The department/team
  // ids and all assignments remain untouched, so timesheet permissions and
  // saved relationships continue to point at the same records.
  assert.match(structure, /async function renameDepartment\(department: Department\)/);
  assert.match(structure, /defaultValue: department\.name/);
  assert.match(structure, /departments: chart\.departments\.map\(\(row\) => \(row\.id === department\.id \? \{ \.\.\.row, name \} : row\)\)/);
  assert.match(structure, /async function renameTeam\(team: Team\)/);
  assert.match(structure, /defaultValue: team\.name/);
  assert.match(structure, /teams: chart\.teams\.map\(\(row\) => \(row\.id === team\.id \? \{ \.\.\.row, name \} : row\)\)/);
  assert.match(structure, /title="Rename department"/);
  assert.match(structure, /title="Rename team"/);
  assert.match(structure, /className="struct-x struct-edit"/);
  assert.match(structure, /canEditDepartment\(chart, viewer, department\.id, users\)/);
});

test("Corrections and Performance History leave a missing name empty instead of inventing one", async () => {
  const page = await read("app/page.tsx");

  // Performance History's employee-name lookup, used both for search and
  // for the table cell that renders it.
  assert.match(page, /const nameFor = \(uid: string\) => users\.find\(\(user\) => user\.id === uid\)\?\.name \|\| "";/);

  // The weekly points review queue: Engineer already sits next to Department,
  // which has always fallen back to "" -- Engineer now matches it instead of
  // being the one field that invents a name.
  assert.match(page, /<td><b>\{row\.Engineer \|\| ""\}<\/b><small>\{row\.Department \|\| ""\}<\/small><\/td>/);
});
