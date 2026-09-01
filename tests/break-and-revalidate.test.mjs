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
  assert.match(page, /const punchBreak = useCallback\(async \(note = "", intent\?: "Break Start" \| "Break End"\) => \{/);
  assert.match(breakBody, /if \(!clockConfirmedRef\.current\) \{/);
  assert.match(breakBody, /await whenClockConfirmed\(\);/);
});

test("a break press that contradicts the record writes nothing", () => {
  assert.match(breakBody, /const offering: "Break Start" \| "Break End" = ending \? "Break End" : "Break Start";/);
  assert.match(breakBody, /if \(intent && intent !== offering && !breakInsisting\) \{/);
  assert.match(breakBody, /nothing was changed\. This screen was out of date and has been refreshed\./);
  const refuseAt = breakBody.indexOf("if (intent && intent !== offering && !breakInsisting)");
  assert.ok(refuseAt > 0 && refuseAt < breakBody.indexOf("store.logs.push("),
    "the refusal must run before anything is appended");
});

test("'am I on shift?' is answered by the ledger, not the cached copy", () => {
  // The removed-record list travels with the question — see the ledger test.
  assert.match(breakBody, /const confirmed = await confirmClockState\(user\.id, store\.removedLogIds \|\| \[\]\);/);
  assert.match(breakBody, /confirmed\.reached && confirmed\.status && serverAt >= localAt/);
  // Ending a break is never gated on that — nobody may get stuck on a break.
  const gateAt = breakBody.indexOf("const confirmed = await confirmClockState");
  const notEndingAt = breakBody.indexOf("if (!ending) {");
  assert.ok(notEndingAt > 0 && notEndingAt < gateAt, "the shift check must sit inside the !ending branch");
});

test("the break buttons carry what they display and cannot be double-fired", () => {
  assert.match(page, /punchBreak: \(note\?: string, intent\?: "Break Start" \| "Break End"\) => Promise<boolean>;/);
  assert.match(page, /if \(await punchBreak\(note, "Break End"\)\) setNote\(""\);/);
  assert.match(page, /if \(await punchBreak\(note, "Break Start"\)\) setNote\(""\);/);
  const guards = page.match(/disabled=\{!clockReady \|\| breaking\}/g) || [];
  assert.equal(guards.length, 2, "both break buttons must be gated");
  assert.match(page, /const \[breaking, setBreaking\] = useState\(false\);/);
});

test("the engine re-reads before it decides a break, and hands it over", () => {
  // Both helpers now re-read the store instead of trusting the panel snapshot.
  assert.match(engine, /function v30OnBreak\(uid\)\{\s*\n\s*if\(typeof freshState==='function'\)freshState\(\);/);
  assert.match(engine, /function v30ClockedIn\(uid\)\{\s*\n\s*if\(typeof freshState==='function'\)freshState\(\);/);
  // The decision is re-checked when the modal closes, not when it opened.
  assert.match(engine, /var offering = active \? 'Break End' : 'Break Start';/);
  assert.match(engine, /var stillActive = !!v30OnBreak\(currentUser\.id\);/);
  assert.match(engine, /if\(\(stillActive\?'Break End':'Break Start'\) !== offering\)\{/);
  // And the write is handed to the app's guarded writer.
  assert.match(engine, /typeof p\.__larsaBreak==='function'\)return p\.__larsaBreak/);
  assert.match(engine, /if\(hand\)\{try\{hand\(offering, note\|\|''\);return\}/);
  assert.match(page, /holder\.__larsaBreak = \(intent, note\) => \{ void punchBreak\(note \|\| "", intent\); \};/);
});

test("a tab left open revalidates on a timer, not only on an edge", () => {
  assert.match(sync, /const revalidateTimer = setInterval\(\(\) => \{\s*\n\s*if \(!document\.hidden\) refreshFromServer\("periodic revalidate"\);\s*\n\s*\}, 3 \* 60 \* 1000\);/);
  assert.match(sync, /clearInterval\(revalidateTimer\);/);
  // The existing edges stay — the timer is an addition, not a replacement.
  assert.match(sync, /document\.addEventListener\("visibilitychange", onVisible\);/);
  assert.match(sync, /window\.addEventListener\("online", onOnline\);/);
});

test("a refresh that finds nothing changed does not pull the 840 KB blob", () => {
  // Stamps first: a few dozen bytes, no `data` column.
  assert.match(sync, /\.select\("store_key, updated_at"\)/);
  assert.match(sync, /if \(!stale\.length\) \{/);
  assert.match(sync, /console\.log\(`\[larsa-sync\] refresh: already current \(\$\{reason\}\)`\);/);
  // Then `data` for the changed keys only.
  assert.match(sync, /\.in\("store_key", stale\.map\(\(\{ key \}\) => key\)\)/);
  // A row with no stamp cannot be proven current, so it is still fetched.
  assert.match(sync, /&& \(!stamp \|\| lastSeenAt\.get\(key\) !== stamp\)\)/);
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
