/* Larsa Control — a partial copy of the document can never delete a whole
 * collection.
 *
 * On 2026-09-07 the shared staff document lost `approvals` (every leave and
 * schedule request), `performance` (every points row) and `flowConfig` (every
 * approval chain) in one write. The device that wrote it had had its local
 * store emptied by a transport fault and then only partly rebuilt by the
 * engine's ensure() passes — so its document had users, logs, history and
 * settings, but none of those three keys. The merge read each missing key as
 * "present in my base, gone locally: deleted", and the CAS path had no merge
 * at all and accepted the copy verbatim.
 *
 * The guards that existed knew about `users`, `logs` and the per-person maps
 * — each added after the incident that taught it. This is the general rule
 * they were all instances of: nothing in the app deletes a whole top-level
 * key (edits happen INSIDE `approvals`, `performance`, `flowConfig`…), so a
 * document that lacks one entirely is a partial copy, never an edit, and the
 * other side's collection is carried forward. On both paths a push can land.
 *
 * Nothing about deliberate edits changes: a key present on both sides merges
 * exactly as before, and an emptied list is still an edit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(new URL("../lib/supabase/merge.ts", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "larsa-wholekey-"));
const tsPath = join(dir, "merge.ts");
writeFileSync(tsPath, source);
execFileSync("npx", ["tsc", tsPath, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], {
  cwd: new URL("..", import.meta.url).pathname,
});
const { mergeStoreText, protectOutgoing } = await import(join(dir, "merge.js"));

const text = (value) => JSON.stringify(value);

/* The shared document as it stood before the incident. */
const full = {
  users: [{ id: "u1", name: "A" }, { id: "u2", name: "B" }],
  logs: [{ id: "l1", uid: "u1", status: "In", time: "2026-09-07T08:00:00Z" }],
  approvals: [{ id: "r1", uid: "u2", type: "Leave", status: "Pending", date: "2026-09-10" }],
  performance: [{ id: "p1", uid: "u1", week: "2026-W36", points: 40 }],
  flowConfig: { u2: { Leave: ["u1"] } },
  history: [],
  theme: "light",
};

/* The partial copy the wiped-then-rebuilt device actually wrote: it has the
   guarded collections (the engine put people and punches back) and its own
   settings, but no approvals, performance or flowConfig at all. */
const partial = {
  users: full.users,
  logs: full.logs,
  history: [{ id: "h1", kind: "Clock" }],
  notifications: [],
  alertSettings: { clockGraceMinutes: 15 },
  theme: "light",
};

test("merge: a whole collection missing from the local copy is carried forward", () => {
  const merged = mergeStoreText(text(full), text(partial), full);
  assert.deepEqual(merged.approvals, full.approvals, "approvals survived");
  assert.deepEqual(merged.performance, full.performance, "performance survived");
  assert.deepEqual(merged.flowConfig, full.flowConfig, "flowConfig survived");
  // The device's own additions still land.
  assert.deepEqual(merged.history, partial.history);
  assert.deepEqual(merged.notifications, []);
});

test("CAS path: protectOutgoing carries forward every server collection the copy lacks", () => {
  const out = protectOutgoing(partial, full);
  assert.deepEqual(out.approvals, full.approvals);
  assert.deepEqual(out.performance, full.performance);
  assert.deepEqual(out.flowConfig, full.flowConfig);
  // What this device has is left exactly as it has it.
  assert.deepEqual(out.history, partial.history);
  assert.deepEqual(out.alertSettings, partial.alertSettings);
});

test("a deliberate edit inside a collection still wins", () => {
  const edited = { ...full, approvals: [{ ...full.approvals[0], status: "Approved" }] };
  const merged = mergeStoreText(text(full), text(edited), full);
  assert.equal(merged.approvals[0].status, "Approved");
  const out = protectOutgoing(edited, full);
  assert.equal(out.approvals[0].status, "Approved");
});

test("an emptied list is still an edit, not a missing key", () => {
  // Clearing a collection is a change to a key both sides hold; only the
  // DISAPPEARANCE of the key is refused. (Guarded collections keep their own
  // tombstone rules; this is an unguarded one.)
  const cleared = { ...full, performance: [] };
  const merged = mergeStoreText(text(full), text(cleared), full);
  assert.deepEqual(merged.performance, []);
});

test("the rule is written at the document root, not per collection", () => {
  // Pin the shape: root-level absence never drops, and protectOutgoing has a
  // catch-all carry-forward after the named guards.
  assert.match(source, /if \(!inBase \|\| key === undefined \|\| GUARDED_COLLECTIONS\[childKey\]/);
  assert.match(source, /Object\.keys\(serverDoc\)\.forEach\(\(topKey\) => \{\s*\n\s*if \(!Object\.prototype\.hasOwnProperty\.call\(out, topKey\)\) out\[topKey\] = serverDoc\[topKey\];/);
});
