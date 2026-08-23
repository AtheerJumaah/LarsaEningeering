import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* The durability rules added by the August repair (lib/supabase/merge.ts).
 *
 * The production failure these pin down: every browser rewrites the SAME
 * JSON document, and the legacy engine iframes save a whole in-memory copy
 * that can be hours old. The old merge read "row missing from this copy" as
 * "deliberately deleted", so stale saves kept erasing newer punches and
 * accounts — two thirds of the production clock log carried a
 * "ledger-restore" recovery mark from the resulting churn, and 99 punches
 * from a single week were missing from the shared document on the day this
 * was written.
 *
 * The new rules under test:
 *   - for `users` and `logs`, absence is NOT deletion: a row leaves only
 *     when a tombstone list (removedUserIds / removedLogIds) names it;
 *   - the tombstone lists merge as an add-only union;
 *   - protectOutgoing() applies the same rules to a push that will face no
 *     merge at all (the CAS-accepts-verbatim path);
 *   - every other collection keeps the original base-aware behaviour.
 */

const source = readFileSync(new URL("../lib/supabase/merge.ts", import.meta.url), "utf8");

const dir = mkdtempSync(join(tmpdir(), "larsa-durability-"));
const tsPath = join(dir, "merge.ts");
writeFileSync(tsPath, source);
execFileSync("npx", ["tsc", tsPath, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], {
  cwd: new URL("..", import.meta.url).pathname,
});
const { mergeStoreText, protectOutgoing, unionIds } = await import(join(dir, "merge.js"));

const doc = (users, logs, extra = {}) => ({ users, logs, ...extra });
const text = (value) => JSON.stringify(value);
const logIds = (merged) => (merged.logs || []).map((log) => log.id);
const userIds = (merged) => (merged.users || []).map((user) => user.id);

test("a stale engine write-back cannot delete punches added since it loaded", () => {
  // The engine loaded when the store held one punch...
  const base = doc([{ id: "u1", name: "A" }], [{ id: "l1", uid: "u1", status: "In", time: "2026-08-20T08:00:00Z" }]);
  // ...meanwhile two colleagues punched (the server moved on)...
  const remote = doc([{ id: "u1", name: "A" }], [
    { id: "l1", uid: "u1", status: "In", time: "2026-08-20T08:00:00Z" },
    { id: "l2", uid: "u2", status: "In", time: "2026-08-20T08:05:00Z" },
    { id: "l3", uid: "u1", status: "Out", time: "2026-08-20T16:00:00Z" },
  ]);
  // ...and the engine saves its old copy plus one edit of its own.
  const local = doc([{ id: "u1", name: "A" }], [
    { id: "l1", uid: "u1", status: "In", time: "2026-08-20T08:00:00Z" },
    { id: "l9", uid: "u3", status: "In", time: "2026-08-20T09:00:00Z" },
  ]);
  const merged = mergeStoreText(text(base), text(local), remote);
  assert.deepEqual(new Set(logIds(merged)), new Set(["l1", "l2", "l3", "l9"]),
    "every punch survives: the server's newer ones AND the engine's own addition");
});

test("the clock-out that closes a session survives a stale copy that never saw it", () => {
  const inRow = { id: "in1", uid: "u5", status: "In", time: "2026-08-21T08:00:00Z" };
  const outRow = { id: "out1", uid: "u5", status: "Out", time: "2026-08-21T16:00:00Z" };
  const base = doc([], [inRow]);
  const remote = doc([], [inRow, outRow]);
  const local = doc([], [inRow]); // stale: has no idea the person clocked out
  const merged = mergeStoreText(text(base), text(local), remote);
  assert.ok(logIds(merged).includes("out1"),
    "the person stays clocked OUT — phantom reopened sessions were the bug");
});

test("a deliberate session removal still propagates, through its tombstone", () => {
  const inRow = { id: "in2", uid: "u6", status: "In", time: "2026-08-21T08:00:00Z" };
  const outRow = { id: "out2", uid: "u6", status: "Out", time: "2026-08-21T08:01:00Z" };
  const base = doc([], [inRow, outRow]);
  const remote = doc([], [inRow, outRow]);
  // An admin used Reset on this device: rows dropped AND tombstoned.
  const local = doc([], [], { removedLogIds: ["in2", "out2"] });
  const merged = mergeStoreText(text(base), text(local), remote);
  assert.deepEqual(logIds(merged), [], "the removed session stays removed");
  assert.deepEqual(merged.removedLogIds, ["in2", "out2"], "the tombstones travel with the document");
});

test("a stale device cannot resurrect a removed session it still carries", () => {
  const ghost = { id: "ghost1", uid: "u7", status: "In", time: "2026-08-01T08:00:00Z" };
  const base = undefined; // fresh device, no shared history at all
  const remote = doc([], [], { removedLogIds: ["ghost1"] });
  const local = doc([], [ghost]); // its old copy still holds the removed row
  const merged = mergeStoreText(base ? text(base) : null, text(local), remote);
  assert.deepEqual(logIds(merged), [], "the tombstone outranks the stale copy");
});

test("tombstone lists merge as an add-only union — a stale shorter list cannot shrink them", () => {
  const base = doc([], [], { removedLogIds: ["a"] });
  const remote = doc([], [], { removedLogIds: ["a", "b", "c"] });
  const local = doc([], [], { removedLogIds: ["a", "d"] }); // stale list + its own new removal
  const merged = mergeStoreText(text(base), text(local), remote);
  assert.deepEqual(new Set(merged.removedLogIds), new Set(["a", "b", "c", "d"]),
    "repair_005's tombstones were wiped by exactly this overwrite — never again");
});

test("accounts: absence is not deletion; a colleague added elsewhere survives a stale save", () => {
  const base = doc([{ id: "u1", name: "A" }], []);
  const remote = doc([{ id: "u1", name: "A" }, { id: "u2", name: "New Colleague" }], []);
  const local = doc([{ id: "u1", name: "A" }], []); // engine copy from before the signup
  const merged = mergeStoreText(text(base), text(local), remote);
  assert.deepEqual(new Set(userIds(merged)), new Set(["u1", "u2"]),
    "the brand-new account no longer vanishes seconds after it was created");
});

test("accounts: a permanent delete propagates through removedUserIds", () => {
  const target = { id: "u9", name: "Leaving" };
  const base = doc([target], []);
  const remote = doc([target], []);
  const local = doc([], [], { removedUserIds: ["u9"] });
  const merged = mergeStoreText(text(base), text(local), remote);
  assert.deepEqual(userIds(merged), [], "the deleted account stays deleted");
});

test("non-guarded collections keep the original base-aware deletion", () => {
  const row = { id: "p1", Week: "2026-W34" };
  const base = { performance: [row] };
  const remote = { performance: [row] };
  const local = { performance: [] }; // deliberately cleared here
  const merged = mergeStoreText(text(base), text(local), remote);
  assert.deepEqual(merged.performance, [],
    "base-aware inference is unchanged outside users/logs");
});

test("a fresher-stamped record still beats the server copy (recency unchanged)", () => {
  const old = { id: "u1", name: "Old Role", access: "Engineer", touchedAt: "2026-08-20T10:00:00Z" };
  const fresh = { id: "u1", name: "Old Role", access: "Admin", touchedAt: "2026-08-20T11:00:00Z" };
  const merged = mergeStoreText(text(doc([old], [])), text(doc([fresh], [])), doc([old], []));
  assert.equal(merged.users[0].access, "Admin", "the deliberate newer edit wins");
});

test("protectOutgoing: a verbatim-accepted push cannot drop the server's rows", () => {
  const server = doc(
    [{ id: "u1", name: "A" }, { id: "u2", name: "B" }],
    [{ id: "l1", uid: "u1", status: "In", time: "2026-08-22T08:00:00Z" }],
  );
  const outgoing = doc([{ id: "u1", name: "A" }], []); // stale copy about to be pushed
  const protectedDoc = protectOutgoing(outgoing, server);
  assert.deepEqual(new Set(userIds(protectedDoc)), new Set(["u1", "u2"]));
  assert.deepEqual(logIds(protectedDoc), ["l1"]);
});

test("protectOutgoing: tombstoned rows are dropped from the push, and the lists go out as a union", () => {
  const server = doc([], [], { removedLogIds: ["dead1"] });
  const outgoing = doc([], [{ id: "dead1", uid: "u1", status: "In", time: "2026-08-01T08:00:00Z" }], { removedLogIds: ["dead2"] });
  const protectedDoc = protectOutgoing(outgoing, server);
  assert.deepEqual(logIds(protectedDoc), [], "the resurrection dies before it is pushed");
  assert.deepEqual(new Set(protectedDoc.removedLogIds), new Set(["dead1", "dead2"]));
});

test("protectOutgoing: an OLDER stamped record is re-anchored to the server's copy", () => {
  const server = doc([{ id: "u1", access: "Admin", touchedAt: "2026-08-22T10:00:00Z" }], []);
  const outgoing = doc([{ id: "u1", access: "Engineer", touchedAt: "2026-08-20T10:00:00Z" }], []);
  const protectedDoc = protectOutgoing(outgoing, server);
  assert.equal(protectedDoc.users[0].access, "Admin", "the stale role revert never leaves this device");
});

test("protectOutgoing: a row the server already holds is never dropped for a stale tombstone", () => {
  // Restore-from-bin writes the row back while an old list entry may still
  // circulate; existence on the server outranks the stale tombstone here —
  // the database's ledger check is the final authority either way.
  const server = doc([{ id: "u3", name: "Restored" }], [], { removedUserIds: ["u3"] });
  const outgoing = doc([{ id: "u3", name: "Restored" }], [], { removedUserIds: ["u3"] });
  const protectedDoc = protectOutgoing(outgoing, server);
  assert.deepEqual(userIds(protectedDoc), ["u3"]);
});

test("unionIds keeps order and de-duplicates", () => {
  assert.deepEqual(unionIds(["a", "b"], ["b", "c", "a", "d"]), ["a", "b", "c", "d"]);
});
