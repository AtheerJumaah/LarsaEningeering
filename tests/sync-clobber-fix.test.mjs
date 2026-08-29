import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The owner reported three symptoms on the live site: staff accounts
 * vanishing, people unable to sign in again, and inaccurate clock times.
 * All three trace to the same two roots:
 *
 *   1. app_state writes were select-then-upsert with client-clock
 *      timestamps — concurrent saves raced (every 8am clock-in rush), a
 *      wrong phone clock defeated stale detection outright, and a device
 *      whose bootstrap failed pushed with no staleness check at all. Any
 *      of those flattened the shared staff document, which is where the
 *      accounts and their passwords live: the platform_backups history
 *      shows the append-only clock log SHRINKING (80 → 78 rows) between
 *      the 2026-08-05 and 2026-08-06 snapshots, which only a
 *      whole-document revert can do.
 *   2. Attendance punches were stamped with the DEVICE clock, so a wrong
 *      phone clock became a wrong attendance record. The Timeclock Live
 *      page also fabricated "last seen" stamps with Math.random() every
 *      15s and saved the whole store each time — invented data plus a
 *      write storm feeding the races in (1).
 *
 * The server side of the fix lives in
 * supabase/migrations/20260806_sync_001_app_state_server_time.sql and is
 * behaviourally tested in tests/app-state-cas-sql.test.sql. This file pins
 * the client half.
 */

test("sync.ts publishes through the app_state_put CAS RPC, not a raw upsert", async () => {
  const sync = await read("lib/supabase/sync.ts");
  assert.match(sync, /supabase\.rpc\("app_state_put", \{\s*\n\s*p_store_key: key,\s*\n\s*p_data: parsed,\s*\n\s*p_base_updated_at: lastSeenAt\.get\(key\) \?\? null,\s*\n\s*\}\)/);
  // The racy select-then-upsert path must be gone entirely.
  assert.ok(!/\.upsert\(/.test(sync), "sync.ts must not contain any raw upsert to app_state");
  // And the client's clock must no longer stamp the shared row.
  assert.ok(!/updated_at: stamp/.test(sync), "sync.ts must not send a client-generated updated_at");
});

test("sync.ts retries a refused write by merging against the returned row", async () => {
  const sync = await read("lib/supabase/sync.ts");
  const pushKey = sync.slice(sync.indexOf("async function pushKey"), sync.indexOf("function schedulePush"));
  assert.match(pushKey, /if \(row\.applied\) \{/);
  assert.match(pushKey, /mergeStoreText\(mergeBase, outgoingText, remoteValue\)/);
  // The refusal handler must record the server stamp it was refused at, so
  // the retry uses it as the new base.
  assert.match(pushKey, /lastSeenAt\.set\(key, String\(row\.current_updated_at\)\);/);
  // A mid-flight local edit must never be overwritten by this push's result.
  assert.match(pushKey, /localStorage\.getItem\(key\) === localBaseline/);
});

test("sync.ts records the server stamp carried by realtime arrivals", async () => {
  const sync = await read("lib/supabase/sync.ts");
  assert.match(sync, /store_key\?: string; data\?: unknown; updated_at\?: string/);
  assert.match(sync, /if \(remoteUpdatedAt\) lastSeenAt\.set\(key, remoteUpdatedAt\);/);
});

test("sync.ts measures device clock skew against server_now() and shares it via localStorage", async () => {
  const sync = await read("lib/supabase/sync.ts");
  assert.match(sync, /CLOCK_OFFSET_STORAGE_KEY = "larsaClockOffsetMsV1"/);
  assert.match(sync, /supabase\.rpc\("server_now"\)/);
  // Round-trip latency is halved out of the measurement.
  assert.match(sync, /serverMs - \(before \+ \(after - before\) \/ 2\)/);
  assert.match(sync, /export function serverNowIso\(\)/);
  assert.match(sync, /export function serverNowMs\(\)/);
});

test("punchClock and punchBreak stamp with the server-corrected clock, not the device's", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /import \{ initLarsaSync, serverNowIso, serverNowMs, pushSyncedKeyNow(?:, [A-Za-z0-9_, ]+)? \} from "\.\.\/lib\/supabase\/sync";/);
  const punchClock = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const punchBreak = useCallback"));
  const punchBreak = page.slice(page.indexOf("const punchBreak = useCallback"), page.indexOf("const trimSession = useCallback"));
  assert.match(punchClock, /const now = serverNowIso\(\);/);
  assert.match(punchBreak, /const now = serverNowIso\(\);/);
  // The 1.2s double-tap guard compares a server-stamped log time, so it must
  // use the server clock too or a skewed device could suppress punches.
  assert.match(punchClock, /serverNowMs\(\) - new Date\(latest\.time\)\.getTime\(\) < 1200/);
  assert.ok(!/const now = new Date\(\)\.toISOString\(\);/.test(punchClock), "punchClock must not stamp with the device clock");
  assert.ok(!/const now = new Date\(\)\.toISOString\(\);/.test(punchBreak), "punchBreak must not stamp with the device clock");
});

test("punch log ids carry uid + entropy so same-millisecond punches on two devices cannot merge into one record", async () => {
  const page = await read("app/page.tsx");
  const clockSection = page.slice(page.indexOf("const punchClock = useCallback"), page.indexOf("const trimSession = useCallback"));
  const plain = clockSection.match(/id: `l\$\{Date\.now\(\)\}`/g) || [];
  assert.equal(plain.length, 0, "self-punch ids must not be bare timestamps");
  assert.match(clockSection, /id: `l\$\{user\.id\}\$\{Date\.now\(\)\}\$\{Math\.random\(\)\}`/);
});

test("the Timeclock engine stamps punches with the shared server-clock offset", async () => {
  const engine = await read("public/engines/timeclock.html");
  const corrected = "new Date(Date.now()+(parseInt(localStorage.getItem('larsaClockOffsetMsV1'),10)||0)).toISOString()";
  const punchSite = "state.logs.push({id:'l'+currentUser.id+Date.now()+Math.random(),uid:currentUser.id,type,status,time:" + corrected;
  /* `offering` is the break direction the button displayed, re-checked against
     a fresh read when the note modal closes — it replaced an `active?…:…`
     captured before the modal opened, which could write the opposite of what
     was asked for if anything moved while the person typed. What this test
     pins is unchanged: the corrected clock and the entropy id. */
  const breakSite = "state.logs.push({id:'l'+currentUser.id+Date.now()+Math.random(),uid:currentUser.id,type:'Break',status:offering,time:" + corrected;
  assert.ok(engine.includes(punchSite), "engine self-punch must use the corrected clock and entropy id");
  assert.ok(engine.includes(breakSite), "engine break punch must use the corrected clock and entropy id");
});

test("the Timeclock Live page no longer fabricates presence or rewrites the shared store on a timer", async () => {
  const engine = await read("public/engines/timeclock.html");
  assert.ok(!engine.includes("Math.random()>.72"), "the random lastSeen fabrication must be gone");
  assert.ok(engine.includes("setInterval(()=>{if(!currentUser||activePage!=='live')return;renderLive()},15000);"),
    "the display tick must survive — only the invented data and the save go");
});

test("the migration pins server authority: stamp trigger + CAS + server_now, security invoker, search_path pinned", async () => {
  const sql = await read("supabase/migrations/20260806_sync_001_app_state_server_time.sql");
  assert.match(sql, /new\.updated_at := clock_timestamp\(\);/);
  assert.match(sql, /create trigger zz_app_state_server_stamp_trg\s*\n\s*before insert or update on public\.app_state/);
  assert.match(sql, /create or replace function public\.app_state_put\(/);
  // The whole point is that RLS and the protective triggers keep applying:
  // this function must never be SECURITY DEFINER.
  assert.ok(!/security definer/i.test(sql), "app_state_put must stay SECURITY INVOKER");
  const pins = sql.match(/set search_path = public, pg_temp/g) || [];
  assert.ok(pins.length >= 3, "every function in the migration pins its search_path");
  assert.match(sql, /grant execute on function public\.app_state_put\(text, jsonb, timestamptz\) to anon, authenticated, service_role;/);
  assert.match(sql, /create or replace function public\.server_now\(\)/);
});

test("the SQL behavioural tests are wired into the local throwaway-Postgres runner, and sync migrations are applied by it", async () => {
  const runner = await read("tests/run-sql-tests.sh");
  assert.match(runner, /app-state-cas-sql\.test\.sql/);
  assert.match(runner, /2026\*_sync_\*\.sql/);
});

test("the service worker cache version is bumped so every device sheds the old engine promptly", async () => {
  const sw = await read("public/sw.js");
  /* What matters is that the name keeps MOVING — the activate handler evicts
     every cache whose name does not match, so a version that never changes is
     how a shipped fix keeps serving the old broken file. Pinning the exact
     number here just meant this test failed on every release for the wrong
     reason, so it asserts the shape and a floor instead: v45 was the version
     current when the durable-ledger repair shipped, and it may only go up. */
  const found = sw.match(/const CACHE_NAME = "larsa-control-v(\d+)";/);
  assert.ok(found, "sw.js must declare a versioned CACHE_NAME");
  assert.ok(Number(found[1]) >= 45, `cache version must not go backwards (found v${found[1]})`);
});
