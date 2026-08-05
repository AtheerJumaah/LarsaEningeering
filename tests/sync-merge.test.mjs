import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* The shared-document merge (lib/supabase/merge.ts).
 *
 * Two bugs sent people to us and both were the same wound: every browser
 * rewrites the SAME JSON document, and the sync layer used to settle a
 * collision by replacing one copy with the other. A brand-new account
 * disappeared seconds after signup ("no account found for that email"), and
 * the trusted-device stamp kept vanishing so PIN sign-in demanded an emailed
 * code every time despite the weekly policy.
 *
 * These are real behaviour tests, not string matches: the module is compiled
 * and executed, and the first two cases replay exactly what people reported.
 */

const source = readFileSync(new URL("../lib/supabase/merge.ts", import.meta.url), "utf8");

/* Compiled once with the project's own TypeScript, so the test exercises the
   shipped file rather than a hand-copied approximation of it. */
const dir = mkdtempSync(join(tmpdir(), "larsa-merge-"));
const tsPath = join(dir, "merge.ts");
writeFileSync(tsPath, source);
execFileSync("npx", ["tsc", tsPath, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "pipe",
});
const { mergeValues, mergeStoreText, deepEqual } = await import(join(dir, "merge.js"));

const user = (id, extra = {}) => ({ id, name: id.toUpperCase(), enabled: true, ...extra });

test("a just-created account survives a collision with another device's write", () => {
  /* Exactly the reported bug. Somebody signs up here while a colleague's
     browser pushes a clock punch. The colleague's copy has no idea the new
     account exists; before this merge it replaced ours and the person was
     told "no account found for that email address". */
  const base = { users: [user("u1"), user("u2")], logs: [] };
  const local = { users: [user("u1"), user("u2"), user("u9", { email: "new@larsaeng.com" })], logs: [] };
  const remote = { users: [user("u1"), user("u2")], logs: [{ id: "l1", uid: "u1", status: "In" }] };

  const merged = mergeValues(base, local, remote);
  const ids = merged.users.map((row) => row.id);
  assert.deepEqual(ids.sort(), ["u1", "u2", "u9"], "the new account must survive");
  assert.equal(merged.users.find((row) => row.id === "u9").email, "new@larsaeng.com");
  assert.equal(merged.logs.length, 1, "and the colleague's punch must survive too");
});

test("a verified-device stamp is not wiped by an unrelated change elsewhere", () => {
  /* The second reported bug. Verifying a PIN sign-in writes lastVerified onto
     the person's device record; another browser saving anything at all used
     to revert it, so the next PIN sign-in asked for a code again. */
  const stamped = "2026-08-05T10:00:00.000Z";
  const base = { users: [user("u1", { devices: [{ id: "d1", label: "Phone", lastVerified: null }] })] };
  const local = { users: [user("u1", { devices: [{ id: "d1", label: "Phone", lastVerified: stamped }] })] };
  const remote = { users: [user("u1", { devices: [{ id: "d1", label: "Phone", lastVerified: null }] })], logs: [{ id: "l7" }] };

  const merged = mergeValues(base, local, remote);
  assert.equal(merged.users[0].devices[0].lastVerified, stamped, "the stamp must survive");
  assert.equal(merged.logs.length, 1);
});

test("a side that changed nothing never overrides the side that did", () => {
  const base = { a: 1, b: 2 };
  assert.deepEqual(mergeValues(base, { a: 1, b: 2 }, { a: 1, b: 99 }), { a: 1, b: 99 });
  assert.deepEqual(mergeValues(base, { a: 5, b: 2 }, { a: 1, b: 2 }), { a: 5, b: 2 });
});

test("edits to different fields of the same record both survive", () => {
  const base = { users: [user("u1", { phone: "", department: "" })] };
  const local = { users: [user("u1", { phone: "0770", department: "" })] };
  const remote = { users: [user("u1", { phone: "", department: "Structural" })] };
  const merged = mergeValues(base, local, remote);
  assert.equal(merged.users[0].phone, "0770");
  assert.equal(merged.users[0].department, "Structural");
});

test("a deliberate removal is honoured and does not come back", () => {
  // Removing a clock session here must not be resurrected by the server copy.
  const base = { logs: [{ id: "l1" }, { id: "l2" }] };
  const local = { logs: [{ id: "l1" }] };
  const remote = { logs: [{ id: "l1" }, { id: "l2" }], users: [user("u3")] };
  const merged = mergeValues(base, local, remote);
  assert.deepEqual(merged.logs.map((row) => row.id), ["l1"], "l2 must stay deleted");
  assert.equal(merged.users.length, 1, "the other device's addition still arrives");
});

test("a removal made elsewhere is respected here too", () => {
  const base = { logs: [{ id: "l1" }, { id: "l2" }] };
  const local = { logs: [{ id: "l1" }, { id: "l2" }], theme: "dark" };
  const remote = { logs: [{ id: "l1" }] };
  const merged = mergeValues(base, local, remote);
  assert.deepEqual(merged.logs.map((row) => row.id), ["l1"]);
  assert.equal(merged.theme, "dark");
});

test("additions from both sides are all kept", () => {
  const base = { approvals: [] };
  const local = { approvals: [{ id: "r1", uid: "u1" }] };
  const remote = { approvals: [{ id: "r2", uid: "u2" }] };
  const merged = mergeValues(base, local, remote);
  assert.deepEqual(merged.approvals.map((row) => row.id).sort(), ["r1", "r2"]);
});

test("when both sides change the very same field, this device's edit stands", () => {
  const base = { users: [user("u1", { role: "Engineer" })] };
  const local = { users: [user("u1", { role: "Team Leader" })] };
  const remote = { users: [user("u1", { role: "Manager" })] };
  assert.equal(mergeValues(base, local, remote).users[0].role, "Team Leader");
});

test("no shared history means nothing is thrown away", () => {
  // base undefined: a device that has never synced this key before.
  const merged = mergeValues(undefined, { users: [user("u9")] }, { users: [user("u1")] });
  assert.deepEqual(merged.users.map((row) => row.id).sort(), ["u1", "u9"]);
});

test("clearing a list on one side is not undone by the other side's unrelated edit", () => {
  const base = { notifications: [{ id: "n1" }, { id: "n2" }], theme: "light" };
  const local = { notifications: [], theme: "light" };
  const remote = { notifications: [{ id: "n1" }, { id: "n2" }], theme: "dark" };
  const merged = mergeValues(base, local, remote);
  assert.deepEqual(merged.notifications, []);
  assert.equal(merged.theme, "dark");
});

test("nested objects merge per field rather than wholesale", () => {
  const base = { flowConfig: { u1: { Leave: ["u2"] } } };
  const local = { flowConfig: { u1: { Leave: ["u3"] } } };
  const remote = { flowConfig: { u1: { Leave: ["u2"] }, u5: { Leave: ["u1"] } } };
  const merged = mergeValues(base, local, remote);
  assert.deepEqual(merged.flowConfig.u1.Leave, ["u3"], "our change to u1 stands");
  assert.deepEqual(merged.flowConfig.u5.Leave, ["u1"], "their new entry arrives");
});

test("deepEqual compares structure, not key order", () => {
  assert.ok(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!deepEqual([1, 2], [2, 1]));
});

test("unparseable local text falls back to the copy everyone else agrees on", () => {
  const remote = { users: [user("u1")] };
  assert.deepEqual(mergeStoreText("{}", "not json", remote), remote);
  assert.deepEqual(mergeStoreText(null, null, remote), remote);
});

test("mergeStoreText applies the same rules through the text boundary", () => {
  const merged = mergeStoreText(
    JSON.stringify({ users: [user("u1")] }),
    JSON.stringify({ users: [user("u1"), user("u9")] }),
    { users: [user("u1")], logs: [{ id: "l1" }] },
  );
  assert.deepEqual(merged.users.map((row) => row.id).sort(), ["u1", "u9"]);
  assert.equal(merged.logs.length, 1);
});
