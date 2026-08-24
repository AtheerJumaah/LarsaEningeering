/* Larsa Control — a stale device can never erase the approval chains.
 *
 * The approval chains were wiped for the whole company twice. Both times the
 * shape was identical: one device held a copy of the store from a window in
 * which the chains were absent, wrote its whole state back, and the merge read
 * every employee key that copy lacked as a deliberate deletion.
 *
 * `users` and `logs` were already protected against exactly this — absence is
 * not evidence, a row leaves only when a tombstone names it. But those are
 * id-keyed ARRAYS, and the guard was written for arrays. `flowConfig` and
 * `schedule` are per-person OBJECTS (`{ [employeeId]: … }`), so they fell
 * through to the plain-object rule, where "missing here, present in my base"
 * means delete. They are records about people just as much as `users` is.
 *
 * Deliberate edits are untouched, because a real edit happens INSIDE a
 * person's entry: the Approval Flow screen rewrites `flowConfig[employeeId]`,
 * so clearing one chain is a change to a key both sides hold and merges
 * normally. Only the disappearance of a whole person is refused — and no
 * screen in the app does that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(new URL("../lib/supabase/merge.ts", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "larsa-flowconfig-"));
const tsPath = join(dir, "merge.ts");
writeFileSync(tsPath, source);
execFileSync("npx", ["tsc", tsPath, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], {
  cwd: new URL("..", import.meta.url).pathname,
});
const { mergeStoreText, protectOutgoing } = await import(join(dir, "merge.js"));

const text = (value) => JSON.stringify(value);
const chains = (flowConfig) => ({ users: [], logs: [], flowConfig });

test("a device that never saw the chains cannot delete them", () => {
  /* The exact production incident: the server holds everyone's chains; one
     device still holds the copy from the window when only u8 had one, and
     saves its whole state back. */
  const server = chains({ u2: { Leave: ["u1"] }, u3: { Leave: ["u1"] }, u8: { Leave: ["u6"] } });
  const staleDevice = chains({ u8: { Leave: ["u6"] } });
  const merged = mergeStoreText(text(server), text(staleDevice), server);
  assert.deepEqual(Object.keys(merged.flowConfig).sort(), ["u2", "u3", "u8"],
    "no employee's chain may vanish because one device lacked it");
});

test("the same protection covers the roster map", () => {
  const server = { users: [], logs: [], schedule: { u2: { Monday: [] }, u3: { Monday: [] } } };
  const staleDevice = { users: [], logs: [], schedule: { u2: { Monday: [] } } };
  const merged = mergeStoreText(text(server), text(staleDevice), server);
  assert.deepEqual(Object.keys(merged.schedule).sort(), ["u2", "u3"]);
});

test("a genuine edit to somebody's chain still lands", () => {
  // Clearing one type on u2, made deliberately on this device.
  const base = chains({ u2: { Leave: ["u1"], Schedule: ["u1"] }, u3: { Leave: ["u1"] } });
  const local = chains({ u2: { Leave: ["u1"] }, u3: { Leave: ["u1"] } });
  const merged = mergeStoreText(text(base), text(local), base);
  assert.deepEqual(merged.flowConfig.u2, { Leave: ["u1"] }, "the cleared type must stay cleared");
  assert.ok(merged.flowConfig.u3, "and nobody else is affected");
});

test("a newly configured chain from another device still arrives", () => {
  const base = chains({ u2: { Leave: ["u1"] } });
  const server = chains({ u2: { Leave: ["u1"] }, u9: { Points: ["u1"] } });
  const local = chains({ u2: { Leave: ["u1"] } });
  const merged = mergeStoreText(text(base), text(local), server);
  assert.deepEqual(merged.flowConfig.u9, { Points: ["u1"] });
});

test("the verbatim push path is protected too", () => {
  /* When the CAS accepts a push as-is there is no merge to apply the rule, so
     protectOutgoing has to carry the server's entries forward itself. */
  const server = chains({ u2: { Leave: ["u1"] }, u3: { Leave: ["u1"] }, u8: { Leave: ["u6"] } });
  const stalePush = chains({ u8: { Leave: ["u6"] } });
  const guarded = protectOutgoing(stalePush, server);
  assert.deepEqual(Object.keys(guarded.flowConfig).sort(), ["u2", "u3", "u8"]);
  // A deliberate edit to an entry both sides hold still wins on this path.
  const edited = protectOutgoing(chains({ u2: { Leave: ["u9"] } }), server);
  assert.deepEqual(edited.flowConfig.u2, { Leave: ["u9"] });
  assert.ok(edited.flowConfig.u3, "and the untouched entries survive");
});

test("the rule is declared where the other durability rules live", async () => {
  assert.match(source, /export const ADD_ONLY_MAPS = new Set\(\["flowConfig", "schedule"\]\);/);
  assert.match(source, /\|\| \(key !== undefined && ADD_ONLY_MAPS\.has\(key\)\)\) out\[childKey\] = remote\[childKey\];/);
});
