"use client";

/* The client's whole view of the notification centre. Every call goes through
 * a SECURITY DEFINER RPC that filters by the actor, because the notify_* tables
 * have no client grants at all — there is no `.from("notify_messages")` in this
 * file, and there deliberately cannot be one.
 *
 * Without Supabase configured every function here degrades to a no-op that
 * returns an empty result, exactly like lib/supabase/sync.ts. The caller in
 * page.tsx keeps a local mirror for that case, so the bell still works on a
 * deployment with no backend at all — it just stops being shared between
 * devices, which is the honest consequence of having nowhere to share it. */
import { getSupabaseClient, supabaseConfigured } from "./client";

export type NotifyRow = {
  id: string;
  event: string;
  category: string;
  title: string;
  body: string;
  itemId: string | null;
  actorName: string;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
  meta?: Record<string, unknown>;
};

/* `reachable` is the difference between "you have no notifications" and "I
   could not ask". They look identical on screen and only one of them is the
   user's fault, so the bell needs to be able to tell them apart. */
export type NotifyFeed = { items: NotifyRow[]; total: number; offset: number; limit: number; reachable: boolean };
export type NotifyCounts = { unread: number; all: number; archived: number; byCategory: Record<string, number> };
export type NotifyCategory = {
  id: string; label: string; description: string;
  sensitive: boolean; push: boolean; mail: boolean;
};
export type NotifyDevice = {
  id: string; label: string; platform: string | null;
  enabled: boolean; lastSeen: string; createdAt: string;
};
export type NotifySettings = {
  quietFrom: number | null; quietTo: number | null;
  badge: boolean; sound: boolean; tz: string;
};
export type NotifySetup = {
  categories: NotifyCategory[];
  settings: NotifySettings;
  devices: NotifyDevice[];
};

export type NotifyActor = { id: string; name?: string };

export const EMPTY_COUNTS: NotifyCounts = { unread: 0, all: 0, archived: 0, byCategory: {} };
export const EMPTY_FEED: NotifyFeed = { items: [], total: 0, offset: 0, limit: 20, reachable: true };

export function notifyConfigured(): boolean {
  return supabaseConfigured();
}

/* Every RPC is wrapped so a flaky connection degrades rather than throws — a
   notification centre that explodes on a dropped packet is worse than one
   showing what it last knew. `reached` reports whether the answer actually
   came from the server, so a caller that needs to distinguish empty from
   unreachable can. The ceiling matters: supabase-js will happily leave a
   request hanging on a dead network, and a spinner that never resolves is the
   single most convincing way an app has of looking broken. Six seconds is
   long enough for a slow connection and short enough that nobody concludes
   the bell is dead before it answers. */
async function callRaw<T>(fn: string, args: Record<string, unknown>, fallback: T): Promise<{ data: T; reached: boolean }> {
  if (!supabaseConfigured()) return { data: fallback, reached: false };
  const client = getSupabaseClient();
  if (!client) return { data: fallback, reached: false };
  try {
    const answered = await Promise.race([
      client.rpc(fn, args),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("notify: timed out")), 6000)),
    ]);
    const { data, error } = answered as { data: unknown; error: unknown };
    if (error) return { data: fallback, reached: false };
    return { data: (data ?? fallback) as T, reached: true };
  } catch {
    return { data: fallback, reached: false };
  }
}

async function call<T>(fn: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  return (await callRaw(fn, args, fallback)).data;
}

/* ---------------------------------------------------------------- reading */

export async function fetchCounts(actor: NotifyActor): Promise<NotifyCounts> {
  const data = await call<Partial<NotifyCounts>>("notify_counts", { actor }, EMPTY_COUNTS);
  return {
    unread: Number(data?.unread) || 0,
    all: Number(data?.all) || 0,
    archived: Number(data?.archived) || 0,
    byCategory: (data?.byCategory as Record<string, number>) || {},
  };
}

export async function fetchFeed(actor: NotifyActor, options: {
  scope?: "all" | "unread" | "archived";
  search?: string; category?: string; limit?: number; offset?: number;
} = {}): Promise<NotifyFeed> {
  const { data, reached } = await callRaw<{ items?: NotifyRow[]; total?: number; offset?: number; limit?: number }>(
    "notify_feed",
    {
      actor,
      p_scope: options.scope || "all",
      p_search: options.search?.trim() || null,
      p_category: options.category || null,
      p_limit: options.limit ?? 20,
      p_offset: options.offset ?? 0,
    },
    EMPTY_FEED,
  );
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: Number(data?.total) || 0,
    offset: Number(data?.offset) || 0,
    limit: Number(data?.limit) || 20,
    reachable: reached,
  };
}

/* ---------------------------------------------------------------- writing */

/* The one way a notification comes into existence. Rows are sent in a single
 * call rather than one call per recipient: an announcement to forty people
 * should be one round trip, and should be all-or-nothing rather than
 * twenty-three delivered and a network error. */
export async function raiseNotifications(actor: NotifyActor, rows: {
  userUid: string; event: string; title: string; body?: string;
  itemId?: string; dedupeKey?: string; meta?: Record<string, unknown>;
}[]): Promise<{ created: number; deduped: number }> {
  if (!rows.length) return { created: 0, deduped: 0 };
  const result = await call<{ created?: number; deduped?: number }>(
    "notify_raise", { actor, p_rows: rows }, { created: 0, deduped: 0 },
  );
  /* No client-side nudge to the sender. notify_raise dispatches server-side
     over pg_net, with a one-minute cron sweep behind it, so delivery does not
     depend on this browser at all.
     It used to. That was wrong on its face — the entire point of a push is to
     reach somebody whose app is CLOSED, so making the app responsible for
     triggering its own delivery is a contradiction. It was also silently
     broken: the call was blocked by CORS before it left the page, and the
     failure was swallowed, so nothing was ever sent until something outside
     the browser happened to run the sender. */
  return { created: Number(result?.created) || 0, deduped: Number(result?.deduped) || 0 };
}

/* Kept for the Settings "Send a test" path and as a manual kick, but nothing
   in the normal flow needs it any more. */
export function drainPush(): Promise<void> {
  if (!supabaseConfigured()) return Promise.resolve();
  const client = getSupabaseClient();
  if (!client) return Promise.resolve();
  return client.functions.invoke("send-push", { body: { limit: 50 } })
    .then(() => undefined)
    .catch(() => undefined);
}

export async function markNotifications(
  actor: NotifyActor, ids: string[], action: "read" | "unread" | "archive" | "unarchive",
): Promise<number> {
  if (!ids.length) return 0;
  const data = await call<{ changed?: number }>("notify_mark", { actor, p_ids: ids, p_action: action }, { changed: 0 });
  return Number(data?.changed) || 0;
}

export async function markAllRead(actor: NotifyActor): Promise<number> {
  const data = await call<{ changed?: number }>("notify_mark_all_read", { actor }, { changed: 0 });
  return Number(data?.changed) || 0;
}

/* ------------------------------------------------- preferences and devices */

const FALLBACK_SETUP: NotifySetup = {
  categories: [],
  settings: { quietFrom: null, quietTo: null, badge: true, sound: true, tz: "Asia/Baghdad" },
  devices: [],
};

export async function fetchSetup(actor: NotifyActor): Promise<NotifySetup> {
  const data = await call<Partial<NotifySetup>>("notify_setup", { actor }, FALLBACK_SETUP);
  return {
    categories: Array.isArray(data?.categories) ? data.categories : [],
    settings: { ...FALLBACK_SETUP.settings, ...(data?.settings || {}) },
    devices: Array.isArray(data?.devices) ? data.devices : [],
  };
}

export async function setCategoryPref(
  actor: NotifyActor, category: string, push: boolean, mail: boolean,
): Promise<boolean> {
  const data = await call<{ ok?: boolean }>(
    "notify_set_pref", { actor, p_category: category, p_push: push, p_mail: mail }, { ok: false },
  );
  return Boolean(data?.ok);
}

export async function setNotifySettings(actor: NotifyActor, patch: Partial<NotifySettings>): Promise<boolean> {
  const data = await call<{ ok?: boolean }>("notify_set_settings", { actor, p_patch: patch }, { ok: false });
  return Boolean(data?.ok);
}

export async function updateDevice(
  actor: NotifyActor, id: string, patch: { enabled?: boolean; label?: string },
): Promise<boolean> {
  const data = await call<{ ok?: boolean }>("notify_device_update", {
    actor, p_id: id,
    p_enabled: patch.enabled ?? null,
    p_label: patch.label ?? null,
  }, { ok: false });
  return Boolean(data?.ok);
}

export async function removeDevice(actor: NotifyActor, id: string): Promise<boolean> {
  const data = await call<{ ok?: boolean }>("notify_remove_device", { actor, p_id: id }, { ok: false });
  return Boolean(data?.ok);
}

/* ------------------------------------------------------------------ import */

export async function importLegacy(actor: NotifyActor, items: unknown[]): Promise<number> {
  if (!items.length) return 0;
  const data = await call<{ imported?: number }>(
    "notify_import_legacy", { actor, p_items: items }, { imported: 0 },
  );
  return Number(data?.imported) || 0;
}

/* ---------------------------------------------------------------- realtime */

/* A live "something changed for you" signal, so reading a notification on a
 * phone empties the badge on the laptop within a second instead of at the next
 * page load. The broadcast carries no content — the callback's job is to go
 * and re-read through the RPCs, which re-check the actor. Returns an
 * unsubscribe function; call it on sign-out. */
export function watchNotifications(actor: NotifyActor, onChange: () => void): () => void {
  if (!supabaseConfigured() || !actor?.id) return () => {};
  const client = getSupabaseClient();
  if (!client) return () => {};
  try {
    const channel = client
      .channel(`notify:${actor.id}`)
      .on("broadcast", { event: "changed" }, () => onChange())
      .subscribe();
    return () => { try { client.removeChannel(channel); } catch { /* already gone */ } };
  } catch {
    return () => {};
  }
}
