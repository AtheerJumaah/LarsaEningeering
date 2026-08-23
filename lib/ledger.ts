"use client";

/* The durable attendance ledger: the client half of the guarantee that NO
 * clock punch is ever lost again, whatever happens to accounts, caches,
 * auth sessions, or the shared staff blob.
 *
 * How it works. The staff blob (larsaStaffV8) stays the app's working state,
 * exactly as before. But every clock log that APPEARS in that blob — from
 * the quick-clock buttons, from clocking somebody else, from an approved
 * correction, even from the legacy Timeclock engine iframe — is also
 * appended to public.attendance_events, an INSERT-only Supabase table that
 * nothing and nobody can update or delete (enforced by a database trigger).
 * On boot, the app reads the recent ledger back and restores any event the
 * blob has lost. So even if a stale device replaced the blob wholesale (the
 * Aug 6–7 incident), the punches survive in the ledger and walk right back
 * into the blob on the next open.
 *
 * Loss-proofing the write itself: events queue in localStorage first and are
 * flushed with retry — a punch made offline or mid-outage is delivered when
 * the network returns. client_event_id (the log's own id, which already
 * carries uid + timestamp + entropy) makes delivery idempotent: a retry or a
 * double-flush can never create a second row for the same punch.
 *
 * Deliberate removals are the one exception to restoration: when an admin
 * uses Reset to remove a session, the removed log ids are remembered in the
 * blob (removedLogIds) and the reconciler skips them. If that list is itself
 * lost to an overwrite, the failure direction is that removed records come
 * BACK — this app loses adjustments before it ever loses attendance. */

import { getSupabaseClient, supabaseConfigured } from "./supabase/client";

export type LedgerEvent = {
  client_event_id: string;
  occurred_at: string;
  uid: string;
  normalized_email?: string | null;
  person_name?: string | null;
  status: string;
  work_mode?: string | null;
  note?: string | null;
  clocked_by?: string | null;
  source?: string;
};

type ClockLogLike = {
  id?: string;
  uid?: string;
  status?: string;
  time?: string;
  type?: string;
  note?: string;
  clockedBy?: string;
  active?: boolean;
  lastSeen?: string;
  origUid?: string;
  recovery?: string;
};

type StaffStoreLike = {
  users?: { id?: string; name?: string; email?: string }[];
  logs?: ClockLogLike[];
  removedLogIds?: string[];
};

const QUEUE_KEY = "larsaLedgerQueueV1";
const SEEN_KEY = "larsaLedgerSeenV1";
const LEDGER_STATUSES = new Set(["In", "Out", "Break Start", "Break End"]);
/* How far back boot reconciliation looks. Wide enough to cover any realistic
   stale-device window; the ledger itself keeps everything forever. */
const RECONCILE_WINDOW_MS = 45 * 24 * 3600_000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / private mode — the ledger tap will re-derive */
  }
}

function normalizeEmail(value: unknown): string | null {
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : null;
}

/* ---- Outbound: blob writes → ledger rows ------------------------------ */

let flushing = false;

export async function flushLedgerQueue(): Promise<void> {
  if (flushing || !supabaseConfigured()) return;
  const client = getSupabaseClient();
  if (!client) return;
  const queue = readJson<LedgerEvent[]>(QUEUE_KEY, []);
  if (!queue.length) return;
  flushing = true;
  try {
    /* ON CONFLICT DO NOTHING via ignoreDuplicates: a retry after a timeout
       whose insert actually landed must not fail the whole batch. */
    const { error } = await client
      .from("attendance_events")
      .upsert(queue, { onConflict: "client_event_id", ignoreDuplicates: true });
    if (!error) {
      const sent = new Set(queue.map((event) => event.client_event_id));
      const remaining = readJson<LedgerEvent[]>(QUEUE_KEY, []).filter(
        (event) => !sent.has(event.client_event_id),
      );
      writeJson(QUEUE_KEY, remaining);
    }
  } catch {
    /* kept in the queue; retried on the next write, flush timer, or reopen */
  } finally {
    flushing = false;
  }
}

function enqueue(events: LedgerEvent[]) {
  if (!events.length) return;
  const queue = readJson<LedgerEvent[]>(QUEUE_KEY, []);
  const present = new Set(queue.map((event) => event.client_event_id));
  events.forEach((event) => {
    if (!present.has(event.client_event_id)) queue.push(event);
  });
  writeJson(QUEUE_KEY, queue.slice(-2000));
  void flushLedgerQueue();
}

function eventFromLog(log: ClockLogLike, store: StaffStoreLike, source: string): LedgerEvent | null {
  if (!log?.id || !log.uid || !log.time || !log.status) return null;
  if (!LEDGER_STATUSES.has(log.status)) return null;
  const person = (store.users || []).find((user) => user.id === log.uid);
  return {
    client_event_id: String(log.id),
    occurred_at: String(log.time),
    uid: String(log.uid),
    normalized_email: normalizeEmail(person?.email),
    person_name: person?.name ? String(person.name) : null,
    status: String(log.status),
    work_mode: log.type ? String(log.type) : null,
    note: log.note ? String(log.note) : null,
    clocked_by: log.clockedBy ? String(log.clockedBy) : null,
    source,
  };
}

/* Called on EVERY write of larsaStaffV8 (installed below): any log id we have
 * not seen before — whoever wrote it — is queued for the ledger. One tap
 * covers the quick-clock, admin clock-others, approved corrections, and the
 * legacy Timeclock engine iframe, because they all funnel through the same
 * localStorage key. */
export function ledgerTapStaffWrite(rawValue: string) {
  let store: StaffStoreLike;
  try {
    store = JSON.parse(rawValue) as StaffStoreLike;
  } catch {
    return;
  }
  const logs = Array.isArray(store?.logs) ? store.logs : [];
  if (!logs.length) return;
  const seen = new Set(readJson<string[]>(SEEN_KEY, []));
  const fresh: LedgerEvent[] = [];
  logs.forEach((log) => {
    if (!log?.id || seen.has(String(log.id))) return;
    const event = eventFromLog(log, store, "live");
    if (event) {
      fresh.push(event);
      seen.add(String(log.id));
    }
  });
  if (fresh.length) {
    writeJson(SEEN_KEY, Array.from(seen).slice(-5000));
    enqueue(fresh);
  }
}

let tapInstalled = false;

/* Install the write tap + retry timers. Runs once, idempotent. The tap
 * wraps whatever setItem is CURRENT — the sync layer's own wrapper installs
 * first, so pushes to Supabase and ledger appends both keep working. */
export function initAttendanceLedger(): () => void {
  if (typeof window === "undefined" || tapInstalled) return () => {};
  tapInstalled = true;
  const previousSetItem = window.localStorage.setItem.bind(window.localStorage);
  window.localStorage.setItem = function ledgerPatchedSetItem(key: string, value: string) {
    previousSetItem(key, value);
    if (key === "larsaStaffV8") {
      try { ledgerTapStaffWrite(value); } catch { /* never break a save */ }
    }
  };
  /* Catch up on anything written before this ran (or while offline). */
  const current = localStorage.getItem("larsaStaffV8");
  if (current) { try { ledgerTapStaffWrite(current); } catch { /* as above */ } }
  const timer = window.setInterval(() => { void flushLedgerQueue(); }, 60_000);
  const onOnline = () => { void flushLedgerQueue(); };
  window.addEventListener("online", onOnline);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("online", onOnline);
  };
}

/* ---- Inbound: ledger rows → restored blob logs ------------------------ */

export type ReconcileResult = { restored: number };

/* After the shared blob has been pulled at boot, restore anything the ledger
 * holds that the blob has lost. Returns how many events were restored; the
 * caller re-saves the store (which also syncs it back up for everyone). */
export async function reconcileStoreFromLedger(): Promise<ReconcileResult> {
  if (!supabaseConfigured()) return { restored: 0 };
  const client = getSupabaseClient();
  if (!client) return { restored: 0 };
  const sinceIso = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const { data, error } = await client
    .from("attendance_events")
    .select("client_event_id, occurred_at, uid, status, work_mode, note, clocked_by, person_name")
    .gte("occurred_at", sinceIso)
    .order("occurred_at", { ascending: true })
    .limit(5000);
  if (error || !Array.isArray(data) || !data.length) return { restored: 0 };

  const raw = localStorage.getItem("larsaStaffV8");
  if (!raw) return { restored: 0 };
  let store: StaffStoreLike;
  try {
    store = JSON.parse(raw) as StaffStoreLike;
  } catch {
    return { restored: 0 };
  }
  if (!Array.isArray(store.logs)) store.logs = [];
  const present = new Set(store.logs.map((log) => String(log?.id || "")));
  const removed = new Set((store.removedLogIds || []).map(String));

  let restored = 0;
  data.forEach((row) => {
    const id = String(row.client_event_id || "");
    if (!id || present.has(id) || removed.has(id)) return;
    store.logs!.push({
      id,
      uid: String(row.uid || ""),
      type: row.work_mode ? String(row.work_mode) : "Office",
      status: String(row.status || ""),
      time: String(row.occurred_at || ""),
      active: false,
      lastSeen: String(row.occurred_at || ""),
      ...(row.note ? { note: String(row.note) } : {}),
      ...(row.clocked_by ? { clockedBy: String(row.clocked_by) } : {}),
      recovery: "ledger-restore",
    });
    present.add(id);
    restored++;
  });

  /* Recompute which sessions are open: for each uid, an In newer than any
     later Out is an open shift. This used to run only when something was
     restored, so the denormalized `active` flags drifted for everyone else —
     69 stale flags were live in production, each one somebody who looked
     clocked in long after leaving. It now self-heals on every reconcile,
     and the store is only re-written when a flag (or a restore) actually
     changed. */
  const logs = store.logs!;
  logs.sort((left, right) => new Date(left.time || 0).getTime() - new Date(right.time || 0).getTime());
  const openByUid = new Map<string, ClockLogLike | null>();
  logs.forEach((log) => {
    if (log.status === "In") openByUid.set(String(log.uid), log);
    if (log.status === "Out") openByUid.set(String(log.uid), null);
  });
  const openLogs = new Set<ClockLogLike>();
  openByUid.forEach((log) => { if (log) openLogs.add(log); });
  let flagsChanged = false;
  logs.forEach((log) => {
    if (log.status !== "In" && log.status !== "Out") return;
    const next = openLogs.has(log);
    if (Boolean(log.active) !== next) { log.active = next; flagsChanged = true; }
  });
  if (restored || flagsChanged) {
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
  }
  return { restored };
}

/* Remember a deliberate session removal so reconciliation honours it. */
export function markLogsRemoved(store: StaffStoreLike, ids: string[]) {
  const removed = Array.isArray(store.removedLogIds) ? store.removedLogIds : [];
  ids.forEach((id) => { if (id && !removed.includes(id)) removed.push(id); });
  store.removedLogIds = removed.slice(-500);
}
