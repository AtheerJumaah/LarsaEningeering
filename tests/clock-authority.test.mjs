/* Attendance transitions are serialized by Postgres; the browser never
 * chooses a transition from an old localStorage snapshot. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const page = await read("app/page.tsx");
const punchClient = await read("lib/attendance-punch.ts");
const sql = await read("supabase/migrations/repair_014_attendance_chronology_audit.sql");
const punch = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchBreak = useCallback"));
assert.ok(punch.length > 500, "punchClock could not be isolated");

test("explicit presses preserve displayed intent while intent-free calls confirm server state", () => {
  assert.match(page, /import \{ recordAttendancePunch, type AttendancePunchInput \} from "\.\.\/lib\/attendance-punch";/);
  assert.match(punch, /let decided: AttendancePunchInput\["status"\];/);
  assert.match(punch, /if \(intent === undefined\) \{[\s\S]*await confirmClockState\(user\.id, initialStore\?\.removedLogIds \|\| \[\]\)/);
  assert.match(punch, /if \(!confirmed\.reached \|\| !confirmed\.status\) \{[\s\S]*return false;[\s\S]*decided = confirmed\.status === "In" \? "Out" : "In";/);
  assert.match(punch, /\} else \{\s*decided = intent;\s*\}/);
  assert.match(punch, /status: decided,/);
  assert.match(punch, /await recordAttendancePunch\(event\)/);
});

test("a same-state retry is idempotent and concurrent devices serialize by employee", () => {
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_uid, 0\)\)/);
  assert.match(sql, /where e\.client_event_id = p_client_event_id/);
  assert.match(sql, /where e\.uid=p_uid/);
  assert.match(sql, /if v_current\.status=p_status then/);
  assert.match(sql, /return query select 'already'::text/);
  assert.match(punchClient, /p_client_event_id: input\.client_event_id/);
});

test("an ambiguous timeout keeps the same event queued for retry", () => {
  assert.match(punch, /const queueKey = attendancePunchQueueKey\(user\.id\);/);
  assert.match(punch, /writeAttendanceQueue\(queueKey, pending\)/);
  assert.match(punch, /if \(result\.outcome === "unavailable"/);
  assert.match(punch, /pending\.splice\(0, pending\.length, \.\.\.remaining\);/);
  assert.match(punchClient, /setTimeout\(\(\) => \{[\s\S]*controller\.abort\(\)[\s\S]*resolve\(\{ outcome: "unavailable" \}\)/);
});

test("the server response repairs local active flags and persists the record", () => {
  assert.match(punch, /const eventId = result\.eventId \|\| event\.client_event_id;/);
  assert.match(punch, /if \(latestShift\?\.status === "In"\) latestShift\.active = true;/);
  assert.match(punch, /pushSyncedKeyNow\("larsaStaffV8"\);/);
  assert.match(punch, /result\.workMode/);
});

test("clock-in/out is gated until sync is confirmed, and the iframe uses the same writer", () => {
  const button = page.slice(page.indexOf('className={`clock-punch'), page.indexOf('</button>', page.indexOf('className={`clock-punch')));
  assert.match(button, /disabled=\{!punchAvailable \|\| punching \|\| Boolean\(pendingStatus\)\}/);
  assert.doesNotMatch(button, /clockReady/);
  assert.match(page, /void punchClockGuarded\(mode, note \|\| "", intent\);/);
});

test("an open shift highlights the authoritative work mode on every device", () => {
  assert.match(page, /import \{ resolveClockDisplay \} from "\.\.\/lib\/attendance-display\.mjs";/);
  assert.match(page, /const displayClock = resolveClockDisplay\(\{ open, latest: latestPunch, pending: pendingPunch \}\);/);
  assert.match(page, /const actionMode = displayClock\.mode \|\| mode;/);
  assert.match(page, /const displayMode = clockedIn \? actionMode : mode;/);
  const modes = page.slice(page.indexOf('<div className="clock-modes"'), page.indexOf('</div>', page.indexOf('<div className="clock-modes"')));
  assert.match(modes, /displayMode === item\.id/);
  assert.doesNotMatch(modes, /className=\{`mode-\$\{item\.tone\}\$\{mode === item\.id/);
});

test("a newer queued action keeps the banner, timer, and button in one pending state", () => {
  assert.match(page, /const pendingStatus = displayClock\.pendingIsNewer \? pendingPunch\?\.status : undefined;/);
  assert.match(page, /pendingStatus\s*\n\s*\? `Clock \$\{pendingStatus === "In" \? "in" : "out"\} pending synchronization`/);
  assert.match(page, /open && !pendingStatus \? "Time on shift" : "Current time"/);
  assert.match(page, /disabled=\{!punchAvailable \|\| punching \|\| Boolean\(pendingStatus\)\}/);
});


test("recent sessions explain when suspicious or unclosed hours are excluded", () => {
  const heading = page.indexOf("<h3>Your recent sessions</h3>");
  const start = page.lastIndexOf('<section className="report-panel">', heading);
  const recent = page.slice(start, page.indexOf("</section>", heading));
    assert.ok(recent.includes("<th>Hours / status</th>"));
  assert.match(recent, /session\.stale \|\| session\.unclosed/);
  assert.match(recent, /Needs correction · not counted/);
  assert.match(recent, /session\.long/);
  assert.match(recent, /Needs review · not counted/);
});
