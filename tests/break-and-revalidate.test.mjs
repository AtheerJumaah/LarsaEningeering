/* Larsa Control — the three gaps the clock-authority fix left open.
 *
 * That fix made a CLOCK punch decide from the shared ledger and refuse
 * anything that contradicts it. Three neighbours of it were still deciding
 * from a device's cached copy, which is the same defect wearing a different
 * hat:
 *
 *   1. `punchBreak` was a pure toggle off the cache, carried no intent, and
 *      its buttons were live before the app had heard from the server. A tap
 *      on a stale morning screen wrote a break nobody took — and "Start
 *      Break" checked "are you clocked in?" against that same stale copy.
 *   2. The engine's `v30ToggleBreak` read its in-memory snapshot (not even a
 *      fresh localStorage read), decided BEFORE opening the note modal, and
 *      then wrote whatever it had decided however long the person spent
 *      typing. It also appended locally, bypassing the guarded writer.
 *   3. Nothing re-pulled on a timer. Focus and reconnect are EDGES; a browser
 *      left open all day whose websocket dies without reporting
 *      CHANNEL_ERROR / TIMED_OUT / CLOSED produces neither, and realtime
 *      silence is indistinguishable from nothing having happened. That is a
 *      screen showing yesterday's status all day with no path back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const sync = await readFile(new URL("../lib/supabase/sync.ts", import.meta.url), "utf8");
const raw = await readFile(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");
const tpl = raw.split("\n").find((line) => line.startsWith('"<!DOCTYPE html>'));
assert.ok(tpl, "the engine bundler template line could not be found");
const engine = JSON.parse(tpl);

const breakBody = page.slice(
  page.indexOf("const punchBreak = useCallback"),
  page.indexOf("holder.__larsaBreak ="),
);
assert.ok(breakBody.length > 500, "punchBreak could not be isolated");

test("a break waits for the same confirmation a clock punch waits for", () => {
  assert.match(page, /const punchBreak = useCallback\(async \(note = "", intent\?: "Break Start" \| "Break End", queueOnly = false\) => \{/);
  assert.match(breakBody, /return punchClock\("Break", note, intent, false, undefined, queueOnly\);/);
});

test("a break press that contradicts the record writes nothing", () => {
  assert.match(breakBody, /if \(!intent\) \{ notify\("Select Start Break or End Break explicitly\."\); return false; \}/);
  assert.doesNotMatch(breakBody, /store\.logs\.push\(/,
    "breaks must be committed by the authoritative writer, not appended locally");
});

test("'am I on shift?' is decided by the authoritative writer", () => {
  assert.match(breakBody, /return punchClock\("Break", note, intent, false, undefined, queueOnly\);/);
  assert.doesNotMatch(breakBody, /store\.logs\.push\(/);
});

test("the break buttons carry what they display and cannot be double-fired", () => {
  assert.match(page, /punchBreak: \(note\?: string, intent\?: "Break Start" \| "Break End"\) => Promise<boolean>;/);
  assert.match(page, /if \(await punchBreakGuarded\(note, "Break End"\)\) setNote\(""\);/);
  assert.match(page, /if \(await punchBreakGuarded\(note, "Break Start"\)\) setNote\(""\);/);
  const guards = page.match(/disabled=\{!clockReady \|\| !punchAvailable \|\| breaking\}/g) || [];
  assert.equal(guards.length, 2, "both break buttons must be gated");
  assert.match(page, /const \[breaking, setBreaking\] = useState\(false\);/);
});

test("the engine re-reads before it decides a break, and hands it over", () => {
  // The packed source still re-reads before a deliberate break decision.
  // The unpacker transforms only the decorative injection path; it must not
  // add another full-store parse when the parent has already refreshed the
  // engine state for a clock repaint.
  assert.match(engine, /function v30OnBreak\(uid\)\{\s*\n\s*if\(typeof freshState==='function'\)freshState\(\);/);
  assert.match(engine, /function v30ClockedIn\(uid\)\{\s*\n\s*if\(typeof freshState==='function'\)freshState\(\);/);
  assert.match(raw, /\.replace\(\/function v30OtherStatus/);
  assert.doesNotMatch(raw, /\.replace\(\/function v30Inject/,
    "v30Inject must not parse the full staff blob on every repaint");
  assert.match(engine, /var offering=.*?['"]Break End['"].*?['"]Break Start['"];/);
  assert.match(engine, /typeof p\.__larsaBreak==='function'\)\{p\.__larsaBreak\(offering,note\|\|'',currentUser\.id\);return;\}/);
  assert.match(page, /holder\.__larsaBreak = \(intent, note, uid\) => \{/);
  assert.match(page, /void punchBreakGuarded\(note \|\| "", intent\);/);
});

test("a tab left open revalidates on a timer, not only on an edge", () => {
  assert.match(sync, /const revalidateTimer = setInterval\(\(\) => \{\s*\n\s*if \(!document\.hidden\) refreshFromServer\("periodic revalidate", NON_ATTENDANCE_KEYS\);\s*\n\s*\}, 3_000\);/);
  assert.match(sync, /const attendanceRevalidateTimer = setInterval\(\(\) => \{\s*\n\s*if \(!document\.hidden\) refreshFromServer\("attendance periodic revalidate", \["larsaStaffV8"\]\);\s*\n\s*\}, 5_000\);/);
  assert.match(sync, /attendance-only probe runs\s+every five seconds/);
  assert.match(sync, /async function refreshFromServer\(reason: string, requestedKeys: readonly SyncedKey\[\] = SYNCED_KEYS\)/);
  assert.match(sync, /\.in\("store_key", keys as readonly string\[\]\)/);
  assert.match(sync, /clearInterval\(revalidateTimer\);/);
  assert.match(sync, /clearInterval\(attendanceRevalidateTimer\);/);
  // The existing edges stay — the timer is an addition, not a replacement.
  assert.match(sync, /document\.addEventListener\("visibilitychange", onVisible\);/);
  assert.match(sync, /window\.addEventListener\("online", onOnline\);/);
});

test("a healthy attendance probe does not start another full ledger reconcile", () => {
  /* The watchdog reports `synced` on every successful stamp check. Re-running
     the ledger/account recovery reads from that callback made the renderer
     fall behind after a few seconds and froze the visible shift timer. */
  assert.match(page, /const alreadyHealthy = attendanceConnectionRef\.current === "online"\s*\n\s*&& authoritativeStateReadyRef\.current;/);
  assert.match(page, /setAuthoritativeState\(true\);\s*\n\s*if \(alreadyHealthy\) return;/);
});

test("transient attendance probe failures do not flap the shell offline", () => {
  /* A single missed one-second probe must not launch a full recovery on the
     next success. The sync layer waits for three consecutive watchdog misses
     before reporting offline, then resets the run on any successful stamp. */
  assert.match(sync, /let attendanceProbeFailures = 0;/);
  assert.match(sync, /const attendanceProbe = reason === "attendance periodic revalidate";/);
  assert.match(sync, /if \(!attendanceProbe \|\| attendanceProbeFailures >= 3\) reportStatus\("offline"\);/);
  assert.match(sync, /attendanceProbeFailures = 0;\s*\n\s*reportStatus\("synced"\);/);
});

test("durable recovery is single-flight and never shares the punch critical path", () => {
  assert.match(page, /durableRecoveryInFlightRef = useRef\(false\)/);
  assert.match(page, /startedAt - lastDurableRecoveryAtRef\.current < 30_000/);
  assert.match(page, /if \(punchLock\.current\) \{\s*\n\s*window\.setTimeout\(startRecoveryWhenQuiet, 1500\);/);
  assert.match(page, /Promise\.allSettled\(\[attendanceRecovery, accountRecovery\]\)/);
});

test("the visible shift timer has a foreground heartbeat and catches up after tab throttling", () => {
  const clock = page.slice(page.indexOf("const [now, setNow]"), page.indexOf("const open = summary.openClock"));
  assert.match(clock, /const update = \(\) => setNow\(new Date\(serverNowMs\(\)\)\);/);
  assert.match(clock, /const timer = window\.setInterval\(update, 1000\);/);
  assert.match(clock, /document\.addEventListener\("visibilitychange", onVisibility\);/);
  assert.match(clock, /window\.clearInterval\(timer\);/);
});

test("legacy Clock-page decoration cannot rebuild the page every four seconds", () => {
  // The legacy manager-card poll was the other synchronous path that could
  // starve the renderer after a punch. The unpacker disables only that poll;
  // it does not remove the clock controls or the durable writer.
  assert.match(raw, /source\.includes\("v30Inject"\)/);
  assert.match(raw, /if \(delay === 4000\)/);
  assert.match(raw, /source\.includes\("v30Inject"\) \|\| source\.includes\("v31Relabel"\)/);
  assert.match(raw, /Re-parsing the full staff blob here made each punch pay/);
});

test("the clock paints a committed punch from a bounded local overlay", () => {
  assert.match(raw, /larsaAttendanceOverlayV1/);
  assert.match(raw, /function applyAttendanceOverlay\(\)/);
  assert.match(raw, /function freshState\(\).*?applyAttendanceOverlay\(\);return state/s);
  assert.match(page, /if\(typeof freshState===\"function\"\)freshState\(\);/);
});

test("a refresh that finds nothing changed does not pull the 840 KB blob", () => {
  // Stamps first: a few dozen bytes, no `data` column.
  assert.match(sync, /\.select\("store_key, updated_at"\)/);
  assert.match(sync, /if \(!stale\.length\) \{/);
  assert.doesNotMatch(sync, /console\.log\(`\[larsa-sync\] refresh: already current \(\$\{reason\}\)`\);/);
  // Then `data` for the changed keys only.
  assert.match(sync, /\.in\("store_key", stale\.map\(\(\{ key \}\) => key\)\)/);
  // A row with no stamp cannot be proven current, so it is still fetched.
  assert.match(sync, /&& \(!stamp \|\| lastSeenAt\.get\(key\) !== stamp\)\)/);
});

test("an already-current attendance tick confirms the server without fetching the blob", () => {
  const noChange = sync.slice(sync.indexOf("if (!stale.length) {"), sync.indexOf("const { data: rows", sync.indexOf("if (!stale.length) {")));
  assert.match(noChange, /reportStatus\("synced"\)/);
  assert.match(sync, /let appliedRows = 0;/);
  assert.match(sync, /options\.onStatusChange\?\.\(status\);/);
  assert.match(sync, /const NON_ATTENDANCE_KEYS = SYNCED_KEYS\.filter/);
  assert.match(sync, /refreshFromServer\("network back", \["larsaStaffV8"\]\)/);
});

test("sign-out pauses shared-state writes without disabling refresh", () => {
  assert.match(sync, /let syncWritesPaused = false;/);
  assert.match(sync, /export function setLarsaSyncWritesPaused\(paused: boolean\)/);
  assert.match(sync, /if \(cancelled \|\| syncWritesPaused\) return;/);
  assert.match(sync, /!syncWritesPaused && this === window\.localStorage/);
  assert.match(page, /setLarsaSyncWritesPaused\(false\);\s*\n\s*setLarsaSyncSessionActive\(true\);\s*\n[\s\S]*?refreshSharedStateNow\(\);/);
  assert.match(page, /const signOut = useCallback\(\(\) => \{\s*\n\s*setLarsaSyncWritesPaused\(true\);/);
});

test("rapid logout and login never evaluates a stale iframe synchronously", () => {
  const signIn = page.slice(page.indexOf("const completeSignIn = useCallback"), page.indexOf("const startAccessPreview"));
  assert.ok(signIn.length > 500, "completeSignIn could not be isolated");
  assert.match(signIn, /setLarsaSyncSessionActive\(true\);/);
  assert.match(signIn, /refreshSharedStateNow\(\);/);
  assert.doesNotMatch(signIn, /Object\.keys\(refs\).*applySessionToFrame/,
    "sign-in must not run a large cross-frame eval into stale documents");
  assert.match(signIn, /freshly mounted[\s\S]*prepareFrame/);
  const signOut = page.slice(page.indexOf("const signOut = useCallback"), page.indexOf("\/\* A browser can keep two tabs"));
  assert.match(signOut, /Object\.values\(frameBootTimers\.current\)/);
  assert.match(signOut, /Object\.keys\(remoteRefreshTimers\.current\)/);
});

test("clocking SOMEBODY ELSE is held to the same rule", () => {
  /* An admin clocking another person read a stale panel, captured the
     direction BEFORE the note modal, then wrote it however long the modal
     stayed open — onto someone else's payroll record. It also stamped the raw
     device clock (not the server-corrected one) and used a bare `l+Date.now()`
     id, so two admins acting in the same millisecond collided into one row. */
  assert.match(engine, /function v30OtherStatus\(uid\)\{\s*\n\s*if\(typeof freshState==='function'\)freshState\(\);/);
  assert.match(engine, /var offering = willClockIn \? 'In' : 'Out';/);
  assert.match(engine, /var nowStatus = v30OtherStatus\(uid\);/);
  assert.match(engine, /if\(\(nowStatus==='Out'\?'In':'Out'\) !== offering\)\{/);
  assert.match(engine, /is already clocked '\+\(nowStatus==='In'\?'in':'out'\)\+' - nothing was changed\./);
  // Corrected clock and a collision-proof id, like every other punch site.
  assert.match(engine, /var nowIso=new Date\(Date\.now\(\)\+\(parseInt\(localStorage\.getItem\('larsaClockOffsetMsV1'\),10\)\|\|0\)\)\.toISOString\(\);/);
  assert.match(engine, /state\.logs\.push\(\{id:'l'\+uid\+Date\.now\(\)\+Math\.random\(\),uid,type,status:offering,time:nowIso,active:offering==='In'/);
  // No bare-timestamp id survives on the self-service or clock-other paths.
  assert.doesNotMatch(engine, /state\.logs\.push\(\{id:'l'\+Date\.now\(\),uid,type,status:willClockIn/);
});
