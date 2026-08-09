import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Administration → Corrections: the permission-gated screen where somebody
 * granted the access reroutes a pending request's approval flow, fixes the
 * figures on a points entry, and fixes or adds clock sessions. These tests pin
 * the gates, the audit stamps, and the write discipline — plus the timesheet's
 * device-local time column, because "the times look wrong" was the complaint
 * that started this work.
 */

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const engine = readFileSync(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");

test("Corrections is its own grantable item under Administration, closed until ticked", () => {
  assert.match(page, /id: "admin-corrections",\s*\n\s*label: "Corrections",/);
  assert.match(page, /"admin-corrections": \["view", "edit", "delete"\]/);
  // Listed in the Administration group and routed to the admin channel.
  assert.match(page, /CORRECTIONS_ITEM,\s*\n\s*\{\s*\n\s*id: "platform-settings"/);
  assert.match(page, /item\.id === "admin-corrections"\s*\n\s*\|\| \["staff-people", "staff-rules", "staff-backup"\]/);
});

test("every correction handler gates on its own permission before touching anything", () => {
  // Flow edits, points fixes, and time fixes require "edit"; removal requires "delete".
  const gates = page.match(/ITEMS\.find\(\(row\) => row\.id === "admin-corrections"\)/g) || [];
  assert.ok(gates.length >= 6, `expected the gate in every handler and the screen (found ${gates.length})`);
  assert.match(page, /hasItemPermission\(actor, item, "edit"\)\) \{\s*\n\s*notify\("Your account cannot change approval flows\."\);/);
  assert.match(page, /hasItemPermission\(actor, item, "delete"\)\) \{\s*\n\s*notify\("Your account cannot remove clock records\."\);/);
});

test("rerouting a flow is history-stamped, deduped, capped, and never includes the requester", () => {
  assert.match(page, /if \(record\.status !== "Pending"\) \{ notify\("Only a pending request's flow can be changed\."\);/);
  assert.match(page, /\.filter\(\(uid\) => uid !== record\.uid\)/);
  assert.match(page, /\.filter\(\(uid, at, all\) => all\.indexOf\(uid\) === at\)/);
  assert.match(page, /\.slice\(0, 3\)/);
  assert.match(page, /action: "Flow changed", at: new Date\(\)\.toISOString\(\)/);
  // The current step survives the reroute, clamped to the new chain's length.
  assert.match(page, /Math\.min\(Math\.max\(Number\(record\.step\) \|\| 0, 0\), clean\.length - 1\)/);
});

test("a points fix is scope-checked and stamped with who corrected it", () => {
  assert.match(page, /notify\("That employee is outside your data scope\."\);\s*\n\s*return false;\s*\n\s*\}\s*\n\s*const next: PerformanceRow = \{ \.\.\.row \};/);
  assert.match(page, /next\["Corrected By"\] = actor\.name;/);
  assert.match(page, /next\["Corrected At"\] = new Date\(\)\.toISOString\(\);/);
  assert.match(page, /next\.Week = weekOfDate\(patch\.date\)/);
});

test("clock fixes stamp both punches, refuse impossible times, and append missing sessions like approved corrections", () => {
  // Future-guards compare on the server-corrected clock, the same clock the
  // punches themselves are stamped with — a device set minutes wrong must
  // neither refuse a valid fix nor accept a future one.
  assert.match(page, /notify\("Clock-out has to be after clock-in\."\); return false; \}\s*\n\s*if \(outAt !== null && outAt > serverNowMs\(\)\)/);
  assert.match(page, /const stamp = `Fixed by \$\{actor\.name\} on \$\{new Date\(\)\.toLocaleDateString\(\)\}`;/);
  assert.match(page, /const stamp = `Manual entry by \$\{actor\.name\}`;/);
  // Added pairs use position-suffixed ids so both logs never collide.
  assert.match(page, /id: `l\$\{Date\.now\(\)\}\$\{position\}`, uid, type: mode \|\| "Office", status,/);
});

test("clock fixes and removals are scope-checked and land on the exact paired session, not the first Out after the In", () => {
  const fix = page.slice(page.indexOf("const fixClockSession = useCallback"), page.indexOf("const addClockSession = useCallback"));
  assert.match(fix, /!scopedUsers\(actor, accessUsers\)\.some\(\(user\) => user\.id === uid\)/);
  assert.match(fix, /const found = findPunchSession\(logs, uid, clockIn\);/);
  // Neighbouring-session boundaries: a correction may move punches, never
  // splice two sessions into one.
  assert.match(fix, /if \(prevTime !== null && inAt <= prevTime\)/);
  assert.match(fix, /if \(outAt !== null && nextTime !== null && outAt >= nextTime\)/);
  // The fix is audited with the before and after punches.
  assert.match(fix, /logAccountEvent\(actor, "attendance\.session_corrected", uid,/);
  const remove = page.slice(page.indexOf("const removeClockSession = useCallback"), page.indexOf("const saveFormalRecord = useCallback"));
  assert.match(remove, /!scopedUsers\(actor, accessUsers\)\.some\(\(user\) => user\.id === uid\)/);
  assert.match(remove, /const found = findPunchSession\(logs, uid, clockIn\);/);
  const add = page.slice(page.indexOf("const addClockSession = useCallback"), page.indexOf("const removeClockSession = useCallback"));
  assert.match(add, /!scopedUsers\(actor, accessUsers\)\.some\(\(user\) => user\.id === uid\)/);
});

test("every correction writes the shared store, refreshes the engine, and bumps the tick", () => {
  const block = page.slice(page.indexOf("const editRequestFlow"), page.indexOf("/* Administration → Corrections"));
  const saves = block.match(/localStorage\.setItem\("larsaStaffV8", JSON\.stringify\(store\)\);\s*\n(?:\s*pushSyncedKeyNow\("larsaStaffV8"\);\s*\n)?(?:\s*\/\*[^]*?\*\/\s*\n)?\s*refreshStaffEngine\(\);\s*\n\s*setStorageTick/g) || [];
  assert.ok(saves.length >= 5, `expected the save+refresh+tick trio in all five handlers (found ${saves.length})`);
  // Attendance-record corrections must not even wait out the sync debounce:
  // a fixed or removed session has to reach the server before the tab can
  // close, exactly like a punch.
  const fix = page.slice(page.indexOf("const fixClockSession = useCallback"), page.indexOf("const addClockSession = useCallback"));
  const remove = page.slice(page.indexOf("const removeClockSession = useCallback"), page.indexOf("const saveFormalRecord = useCallback"));
  assert.match(fix, /pushSyncedKeyNow\("larsaStaffV8"\);/);
  assert.match(remove, /pushSyncedKeyNow\("larsaStaffV8"\);/);
});

test("the Timesheet shows every punch in the viewer's own local time, ahead of the reference zones", () => {
  // The always-on Local column — timeFmt23 with no zone renders device-local.
  assert.ok(engine.includes("<th>Your Local Time<\\/th>"), "local column header missing");
  assert.ok(engine.includes("<td><b>${esc23(timeFmt23(s.In))}<\\/b><br>→ ${esc23(timeFmt23(s.Out))}<\\/td>"), "local cell missing");
  assert.ok(engine.includes("const colspan=5+(mosul?1:0)+(texas?1:0);"), "colspan must count the local column");
  // And the CSV export carries the same local columns.
  assert.ok(engine.includes("'Clock In (Local)','Clock Out (Local)'"), "local CSV headers missing");
  assert.ok(engine.includes("timeFmt23(s.In),timeFmt23(s.Out),timeFmt23(s.In,TZ_MOSUL)"), "local CSV values missing");
});
