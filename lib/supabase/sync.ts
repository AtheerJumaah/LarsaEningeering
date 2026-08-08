/* Makes the app's three localStorage stores shared instead of per-browser,
 * without touching any of the hundreds of call sites in app/page.tsx or the
 * three engine HTML files that already read and write them. How:
 *
 *   1. On load, pull each key's row from Supabase and, if there is real data
 *      there, overwrite localStorage with it before the app renders its
 *      first screen.
 *   2. Wrap localStorage.setItem so that any write to one of these three
 *      keys (from the parent app OR from inside an engine iframe, since
 *      iframes on the same origin share the same localStorage) also pushes
 *      to Supabase, debounced so a flurry of writes becomes one network
 *      call.
 *   3. Subscribe to Postgres changes on the same table, so a change made on
 *      a colleague's browser lands here within a second or two. The caller
 *      supplies onRemoteChange, which in app/page.tsx bumps the existing
 *      `storageTick` state the app already uses to react to storage writes,
 *      and reloads the engine iframes so they pick up the new data.
 *
 * If Supabase isn't configured (no env vars), initLarsaSync does nothing and
 * the app behaves exactly as it did before this file existed: localStorage
 * only, one browser at a time. Nothing about the app breaks either way. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient, supabaseConfigured } from "./client";
import { mergeStoreText } from "./merge";

/* "larsa_enterprise_v3_new_account_20260630" is the key the accounting engine
   itself reads and writes (see STORE_KEY in public/engines/accounting.html).
   The "..._v34_clean" name below was never used by that engine, so until this
   line existed every project, revenue line, material, labour entry and expense
   in the company stayed on whichever single browser typed it in — none of it
   reached Supabase, and none of it reached a second device or the Iraq office.
   The old name is kept in the list so the empty row already in the table keeps
   round-tripping harmlessly instead of resurrecting as a conflict. */
export const SYNCED_KEYS = [
  "larsaStaffV8",
  "larsa_enterprise_v3_new_account_20260630",
  "larsa_enterprise_v3_new_account_20260630_v34_clean",
  "larsa_hr_visual_counts_v5",
] as const;
export type SyncedKey = (typeof SYNCED_KEYS)[number];

/* ---- Server clock ------------------------------------------------------
   Attendance punches must not trust the device's clock: one phone set ten
   minutes wrong records ten-minutes-wrong shifts (and, before the CAS
   write above, also broke conflict detection for everyone). The offset
   between the server's clock and this device's is measured against
   server_now() with the round trip halved out — accurate to well under a
   second, against device clocks that are wrong by minutes. Shared through
   localStorage so the engine iframes (same origin, same storage) stamp
   punches identically without any injection plumbing. */
export const CLOCK_OFFSET_STORAGE_KEY = "larsaClockOffsetMsV1";
let clockOffsetMs: number | null = null;

function storedClockOffset(): number {
  try {
    const raw = window.localStorage.getItem(CLOCK_OFFSET_STORAGE_KEY);
    const parsed = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function serverClockOffsetMs(): number {
  if (typeof window === "undefined") return 0;
  if (clockOffsetMs === null) clockOffsetMs = storedClockOffset();
  return clockOffsetMs;
}

export function serverNowMs(): number {
  return Date.now() + serverClockOffsetMs();
}

export function serverNowIso(): string {
  return new Date(serverNowMs()).toISOString();
}

async function sampleServerClock(supabase: SupabaseClient, persist: (key: string, value: string) => void) {
  const before = Date.now();
  const { data, error } = await supabase.rpc("server_now");
  if (error || !data) return;
  const after = Date.now();
  const serverMs = new Date(String(data)).getTime();
  if (!Number.isFinite(serverMs)) return;
  clockOffsetMs = Math.round(serverMs - (before + (after - before) / 2));
  try { persist(CLOCK_OFFSET_STORAGE_KEY, String(clockOffsetMs)); } catch { /* private mode / storage full */ }
}

type SyncOptions = {
  onRemoteChange?: (key: SyncedKey) => void;
  onStatusChange?: (status: "connecting" | "synced" | "offline") => void;
};

function readLocal(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function hasContent(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && Object.keys(value as object).length > 0);
}

export function initLarsaSync(options: SyncOptions = {}): () => void {
  if (typeof window === "undefined") return () => {};
  if (!supabaseConfigured()) {
    console.warn("[larsa-sync] not configured — NEXT_PUBLIC_SUPABASE_URL/ANON_KEY missing at build time. Sync is off.");
    return () => {};
  }
  const client = getSupabaseClient();
  if (!client) {
    console.warn("[larsa-sync] getSupabaseClient() returned null even though supabaseConfigured() was true. Sync is off.");
    return () => {};
  }
  console.log("[larsa-sync] starting up");
  // Re-bound to a definitely-non-null const: the functions below are
  // closures that run later, asynchronously, and TypeScript can't carry the
  // null-check above across that gap on its own.
  const supabase: SupabaseClient = client;

  let cancelled = false;
  // The last JSON text this module itself wrote, per key — lets both the
  // push side and the realtime side tell "a change from elsewhere" apart
  // from "the echo of our own write" without a real diff.
  const lastKnown = new Map<string, string>();  /* The updated_at this device last saw for each key. Without it, a browser     that has been open since yesterday cannot tell that the shared copy has     moved on, and its next write silently replaces work done elsewhere. That     is how a full set of hashed passwords and contact details reverted to a     morning-old copy. */  const lastSeenAt = new Map<string, string>();
  const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const originalSetItem = window.localStorage.setItem.bind(window.localStorage);

  async function ensureSession() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      console.log("[larsa-sync] no local session — calling signInAnonymously()");
      const { error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      console.log("[larsa-sync] signInAnonymously() succeeded");
    } else {
      console.log("[larsa-sync] reusing existing local session, user id:", data.session.user?.id);
    }
  }

  /* Publish one key through the app_state_put compare-and-swap RPC. The
     database accepts the write only if p_base_updated_at still matches the
     row's current server-side stamp; otherwise NOTHING is overwritten and
     the current row comes back for this device to merge against and retry.
     Concurrent writers therefore converge on the union of their work
     instead of the last one flattening the rest — the select-then-upsert
     this replaces had a window between the read and the write where a
     colleague's save (every 8am clock-in rush) was silently lost.

     Client clocks take no part in conflict detection any more: updated_at
     is stamped by the server's trigger and compared server-side for exact
     equality. A device with a wrong clock used to publish a stamp from the
     future and then never again notice the shared row moving — after which
     every one of its saves reverted everyone else's work. And a device
     whose bootstrap failed half-way (no lastSeenAt at all) used to treat
     that as licence to overwrite; the RPC now refuses a null base whenever
     the row exists, so "I don't know what the server holds" can never
     again mean "so replace it". */
  async function pushKey(key: SyncedKey) {
    const raw = localStorage.getItem(key);
    /* The copy this device and the server last agreed on — the base any
       merge below needs. */
    const base = lastKnown.get(key) ?? null;
    if (raw === base) return; // nothing new since our last push
    let outgoingText = raw ?? "";
    let mergeBase = base;
    /* What THIS push believes localStorage holds. If the person types while
       a request is in flight, their write has already queued its own push;
       overwriting their newer text with this one's result would lose it. */
    let localBaseline = raw;
    for (let attempt = 0; attempt < 5; attempt++) {
      let parsed: unknown = {};
      try { parsed = outgoingText ? JSON.parse(outgoingText) : {}; } catch { return; }
      const { data, error } = await supabase.rpc("app_state_put", {
        p_store_key: key,
        p_data: parsed,
        p_base_updated_at: lastSeenAt.get(key) ?? null,
      });
      if (error) throw error; // schedulePush's catch: retried on next write
      const row = (Array.isArray(data) ? data[0] : data) as
        { applied: boolean; current_data: unknown; current_updated_at: string } | undefined;
      if (!row) throw new Error("app_state_put returned no row");
      if (row.applied) {
        /* The server's copy of what we just wrote. It came back through the
           protective triggers (secret healing, the Super Admin guard), so
           it is allowed to differ from what we sent — the healed copy is
           the truthful one. Adopt it locally only if nobody typed here
           while the request was in flight. */
        const serverText = JSON.stringify(row.current_data ?? {});
        lastKnown.set(key, serverText);
        lastSeenAt.set(key, String(row.current_updated_at));
        if (localStorage.getItem(key) === localBaseline && serverText !== localBaseline) {
          originalSetItem(key, serverText);
          options.onRemoteChange?.(key);
        }
        return;
      }
      /* Refused: the row moved on (or this device has never seen it).
         Merge both copies against the base they share and go again from
         the server's current stamp. */
      console.warn("[larsa-sync] " + key + " changed elsewhere; merging both copies (attempt " + (attempt + 1) + ")");
      const remoteValue = row.current_data ?? {};
      const remoteText = JSON.stringify(remoteValue);
      lastSeenAt.set(key, String(row.current_updated_at));
      try {
        outgoingText = JSON.stringify(mergeStoreText(mergeBase, outgoingText, remoteValue));
      } catch {
        /* A merge that cannot be computed must not publish a half-state:
           keep the copy everyone else already has and let this device
           catch up. */
        lastKnown.set(key, remoteText);
        if (localStorage.getItem(key) === localBaseline) {
          originalSetItem(key, remoteText);
          options.onRemoteChange?.(key);
        }
        return;
      }
      mergeBase = remoteText;
      lastKnown.set(key, remoteText);
      if (localStorage.getItem(key) === localBaseline) {
        originalSetItem(key, outgoingText);
        localBaseline = outgoingText;
        options.onRemoteChange?.(key);
        // Next iteration publishes this merge from the fresh stamp.
      } else {
        /* Somebody typed here mid-flight. Their write already queued a push
           that will redo this merge against the newest local text;
           publishing our now-stale merge would only race it. */
        return;
      }
    }
    /* Five straight refusals means genuinely live contention — the next
       write or realtime arrival picks it up from the newest stamp. */
  }

  function schedulePush(key: SyncedKey) {
    const existing = pushTimers.get(key);
    if (existing) clearTimeout(existing);
    pushTimers.set(key, setTimeout(() => { pushKey(key).catch(() => { /* retried on next write */ }); }, 700));
  }

  // Every write to a synced key — whichever code made it — now also queues
  // a push. Anything else passes straight through untouched.
  window.localStorage.setItem = function patchedSetItem(key: string, value: string) {
    originalSetItem(key, value);
    if ((SYNCED_KEYS as readonly string[]).includes(key)) schedulePush(key as SyncedKey);
  };

  async function bootstrap() {
    options.onStatusChange?.("connecting");
    // Every browser that opens the app after this one already made changes
    // needs to actually see them, not just have them sitting in
    // localStorage unread — the initial render already happened, from
    // whatever was on this device before this pull finished. So every key
    // this device's copy was behind on is queued here and announced through
    // onRemoteChange once the catch-up is done, exactly as if it had just
    // arrived over the realtime channel.
    const caughtUpKeys: SyncedKey[] = [];
    try {
      await ensureSession();
      /* Fire-and-forget: the offset is a refinement, never a gate. */
      sampleServerClock(supabase, originalSetItem).catch(() => {});
      await Promise.all(SYNCED_KEYS.map(async (key) => {
        const { data: row, error: selectError } = await supabase
          .from("app_state")
          .select("data, updated_at")
          .eq("store_key", key)
          .maybeSingle();
        if (selectError) {
          console.error(`[larsa-sync] select failed for "${key}":`, selectError);
          throw selectError;
        }
        if (row?.updated_at) lastSeenAt.set(key, String(row.updated_at));        const remote = row?.data;
        const local = readLocal(key);
        if (hasContent(remote)) {
          const text = JSON.stringify(remote);
          const before = localStorage.getItem(key);
          originalSetItem(key, text);
          lastKnown.set(key, text);
          if (text !== before) caughtUpKeys.push(key);
          console.log(`[larsa-sync] "${key}" pulled from Supabase (${text !== before ? "changed" : "unchanged"})`);
        } else if (hasContent(local)) {
          // First device to sign in with real local data seeds the table.
          console.log(`[larsa-sync] "${key}" empty remotely — seeding from local data`);
          await pushKey(key);
        } else {
          console.log(`[larsa-sync] "${key}" empty both locally and remotely — nothing to do`);
        }
      }));
      if (cancelled) return;
      options.onStatusChange?.("synced");
      console.log("[larsa-sync] initial catch-up complete, keys updated:", caughtUpKeys);
      caughtUpKeys.forEach((key) => options.onRemoteChange?.(key));
    } catch (err) {
      console.error("[larsa-sync] bootstrap failed — sync is OFF for this session:", err);
      options.onStatusChange?.("offline");
      return;
    }

    const channel = supabase
      .channel("larsa-app-state")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "app_state" },
        (payload) => {
          const row = payload.new as { store_key?: string; data?: unknown; updated_at?: string } | null;
          if (!row?.store_key || !(SYNCED_KEYS as readonly string[]).includes(row.store_key)) return;
          applyRemote(row.store_key as SyncedKey, row.data ?? {}, row.updated_at ? String(row.updated_at) : null);
        },
      )
      .subscribe((status, err) => {
        console.log("[larsa-sync] realtime channel status:", status, err ?? "");
        /* A channel that comes back after a drop has MISSED whatever
           happened while it was down — realtime replays nothing. Re-fetch
           the authoritative rows instead of assuming silence meant
           stillness (phone sleep, network switch, websocket failure). */
        if (status === "SUBSCRIBED" && hadChannelDrop) {
          hadChannelDrop = false;
          refreshFromServer("realtime resubscribed");
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          hadChannelDrop = true;
        }
      });

    cleanupChannel = () => { supabase.removeChannel(channel); };
  }

  /* Apply a copy of the shared row that arrived from the server — via
     realtime OR via an explicit authoritative re-fetch. Merges any un-pushed
     local edit against the shared base exactly like the push path does. */
  function applyRemote(key: SyncedKey, remoteData: unknown, remoteUpdatedAt: string | null) {
    const text = JSON.stringify(remoteData ?? {});
    if (lastKnown.get(key) === text) {
      if (remoteUpdatedAt) lastSeenAt.set(key, remoteUpdatedAt);
      return; // our own write echoed back, or nothing new
    }
    /* An edit made here in the last moment may not have been pushed yet
       (writes are debounced), so this arrival is merged in rather than
       pasted over the top — the same reason pushKey merges. */
    const base = lastKnown.get(key) ?? null;
    const localText = localStorage.getItem(key);
    let nextText = text;
    if (localText && localText !== base) {
      try { nextText = JSON.stringify(mergeStoreText(base, localText, remoteData ?? {})); }
      catch { nextText = text; }
    }
    /* lastKnown tracks what the SERVER holds, not what we now hold: it is
       the base for the next merge and the echo check. Setting it to the
       merged text instead would make the push below look like a no-op and
       the merge would never leave this device. */
    lastKnown.set(key, text);
    if (remoteUpdatedAt) lastSeenAt.set(key, remoteUpdatedAt);
    originalSetItem(key, nextText);
    console.log(`[larsa-sync] remote state applied for "${key}"`);
    options.onRemoteChange?.(key);
    /* If the merge produced something the server has not got, publish it so
       the other devices converge instead of quietly diverging. */
    if (nextText !== text) schedulePush(key);
  }

  /* Authoritative revalidation: pull every shared row and apply whatever is
     newer than this device's copy. Runs when the app regains focus, when the
     network returns, and when the realtime channel re-subscribes after a
     drop — the moments a device is most likely to be silently stale. */
  let refreshing = false;
  async function refreshFromServer(reason: string) {
    if (refreshing || cancelled || !bootstrapped) return;
    refreshing = true;
    try {
      const { data: rows, error } = await supabase
        .from("app_state")
        .select("store_key, data, updated_at")
        .in("store_key", SYNCED_KEYS as readonly string[]);
      if (error || !Array.isArray(rows)) return;
      rows.forEach((row) => {
        const key = String(row.store_key || "") as SyncedKey;
        if (!(SYNCED_KEYS as readonly string[]).includes(key)) return;
        const stamp = row.updated_at ? String(row.updated_at) : null;
        if (stamp && lastSeenAt.get(key) === stamp) return; // already current
        applyRemote(key, row.data ?? {}, stamp);
      });
      console.log(`[larsa-sync] authoritative refresh complete (${reason})`);
    } catch {
      /* Offline or mid-reconnect: the next trigger tries again. */
    } finally {
      refreshing = false;
    }
  }

  let cleanupChannel: (() => void) | null = null;
  let hadChannelDrop = false;
  let bootstrapped = false;
  bootstrap().then(() => { bootstrapped = true; });
  /* Clock skew drifts (and phones change it); re-measure every ten minutes. */
  const clockTimer = setInterval(() => { sampleServerClock(supabase, originalSetItem).catch(() => {}); }, 10 * 60 * 1000);

  /* The app must revalidate its real state the moment it is looked at again
     or reconnected — nobody should ever need a refresh (hard or otherwise)
     to see the truth. */
  const onVisible = () => { if (!document.hidden) refreshFromServer("app focused"); };
  const onOnline = () => { refreshFromServer("network back"); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  /* Immediate-push hook for punch-critical writes: a clock event must not
     even wait out the write debounce. */
  pushNowHook = (key: SyncedKey) => {
    const existing = pushTimers.get(key);
    if (existing) clearTimeout(existing);
    pushKey(key).catch(() => { /* retried by the next write or refresh */ });
  };

  return () => {
    cancelled = true;
    window.localStorage.setItem = originalSetItem;
    pushTimers.forEach((timer) => clearTimeout(timer));
    clearInterval(clockTimer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    pushNowHook = null;
    cleanupChannel?.();
  };
}

/* Push a synced key RIGHT NOW, skipping the write debounce. Used by clock
   punches so persistence starts the instant the button is pressed; the
   localStorage write has already made the UI state correct either way. */
let pushNowHook: ((key: SyncedKey) => void) | null = null;
export function pushSyncedKeyNow(key: SyncedKey) {
  pushNowHook?.(key);
}
