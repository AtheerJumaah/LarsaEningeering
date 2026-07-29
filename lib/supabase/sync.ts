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

export const SYNCED_KEYS = [
  "larsaStaffV8",
  "larsa_enterprise_v3_new_account_20260630_v34_clean",
  "larsa_hr_visual_counts_v5",
] as const;
export type SyncedKey = (typeof SYNCED_KEYS)[number];

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
  const lastKnown = new Map<string, string>();
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

  async function pushKey(key: SyncedKey) {
    const raw = localStorage.getItem(key);
    if (raw === lastKnown.get(key)) return; // nothing new since our last push
    lastKnown.set(key, raw ?? "");
    let parsed: unknown = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { return; }
    await supabase
      .from("app_state")
      .upsert({ store_key: key, data: parsed, updated_at: new Date().toISOString() }, { onConflict: "store_key" });
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
      await Promise.all(SYNCED_KEYS.map(async (key) => {
        const { data: row, error: selectError } = await supabase
          .from("app_state")
          .select("data")
          .eq("store_key", key)
          .maybeSingle();
        if (selectError) {
          console.error(`[larsa-sync] select failed for "${key}":`, selectError);
          throw selectError;
        }
        const remote = row?.data;
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
          const row = payload.new as { store_key?: string; data?: unknown } | null;
          if (!row?.store_key || !(SYNCED_KEYS as readonly string[]).includes(row.store_key)) return;
          const text = JSON.stringify(row.data ?? {});
          if (lastKnown.get(row.store_key) === text) return; // our own write, echoed back
          lastKnown.set(row.store_key, text);
          originalSetItem(row.store_key, text);
          console.log(`[larsa-sync] realtime change received for "${row.store_key}"`);
          options.onRemoteChange?.(row.store_key as SyncedKey);
        },
      )
      .subscribe((status, err) => {
        console.log("[larsa-sync] realtime channel status:", status, err ?? "");
      });

    cleanupChannel = () => { supabase.removeChannel(channel); };
  }

  let cleanupChannel: (() => void) | null = null;
  bootstrap();

  return () => {
    cancelled = true;
    window.localStorage.setItem = originalSetItem;
    pushTimers.forEach((timer) => clearTimeout(timer));
    cleanupChannel?.();
  };
}
