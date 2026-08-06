import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The owner asked for every user to be able to trim their OWN recorded
 * hours. The trim path is one-way by construction — a clock-out may only
 * move EARLIER — so self-service can close a forgotten clock-out or hand
 * back over-counted minutes but can never manufacture time; adding hours
 * still goes through the correction request and its approval. Managers
 * (staff-clock "manage") keep the team-wide panel including removal;
 * self-service is scoped to the person's own sessions and gets no removal.
 */

test("trimSession admits a manager for anyone, and every clock user for themselves only", async () => {
  const page = await read("app/page.tsx");
  const body = page.slice(page.indexOf("const trimSession = useCallback"), page.indexOf("Removes a session outright"));
  assert.match(body, /const managesClock = Boolean\(actor && clockItem && hasItemPermission\(actor, clockItem, "manage"\)\);/);
  // Self-trim is scoped by uid equality BEFORE any grant helps.
  assert.match(body, /const trimsOwnRecord = Boolean\(actor && clockItem && uid === actor\.id && hasItemPermission\(actor, clockItem, "edit"\)\);/);
  assert.match(body, /if \(!actor \|\| !clockItem \|\| \(!managesClock && !trimsOwnRecord\)\) \{/);
  // The one-way rule that makes self-service safe must survive intact.
  assert.match(body, /You can only bring a clock-out earlier, not later\./);
  assert.match(body, /if \(nextOut > Date\.now\(\)\) \{/);
});

test("session removal stays a manager's tool — self-service gets the one-way trim alone", async () => {
  const page = await read("app/page.tsx");
  const reset = page.slice(page.indexOf("Removes a session outright"), page.indexOf("Removes a session outright") + 900);
  assert.match(reset, /hasItemPermission\(actor, clockItem, "manage"\)/);
  assert.ok(!/trimsOwnRecord|uid === actor\.id/.test(reset), "resetSession must not gain a self-service door");
  // And the Reset button renders only for managers.
  assert.match(page, /\{mayAdjustHours && \(\s*\n\s*<button type="button" className="danger"/);
});

test("the quick-clock panel opens for everyone with clock access, listing exactly their own sessions", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /const maySelfTrim = Boolean\(!mayAdjustHours && user && \(\(\) => \{\s*\n\s*const item = ITEMS\.find\(\(row\) => row\.id === "staff-clock"\);\s*\n\s*return item \? hasItemPermission\(user, item, "edit"\) : false;/);
  assert.match(page, /const trimRows = mayAdjustHours \? recentAll : recentMine;/);
  assert.match(page, /const recentMine = \[\.\.\.sessions\]\s*\n\s*\.filter\(\(session\) => session\.uid === user\?\.id\)/);
  assert.match(page, /\{\(mayAdjustHours \|\| maySelfTrim\) && !showCorrection && \(/);
  assert.match(page, /\{\(mayAdjustHours \|\| maySelfTrim\) && showTrim && !showCorrection && \(/);
  // The self-service copy promises exactly what the code enforces.
  assert.match(page, /only ever shorter/);
});
