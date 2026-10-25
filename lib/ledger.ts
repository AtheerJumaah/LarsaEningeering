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
import type { SupabaseClient } from "@supabase/supabase-js";

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
  correctionId?: string;
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

/* The authoritative punch RPC has already accepted this event. Marking it
 * seen before the local staff blob is written prevents the compatibility tap
 * below from submitting the same event a second time. Offline events are not
 * marked here; they remain eligible for the durable queue. */
export function markAttendanceEventSent(clientEventId: string) {
  if (!clientEventId) return;
  const seen = new Set(readJson<string[]>(SEEN_KEY, []));
  if (seen.has(clientEventId)) return;
  seen.add(clientEventId);
  writeJson(SEEN_KEY, Array.from(seen).slice(-10000));
}

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
    /* Every queued event must cross the same authoritative operation as a
       deliberate punch. A direct table upsert bypassed chronology checks and
       would also bypass any future server-side identity gate. Process rows
       individually so one review-required event cannot hold back unrelated
       retries. `already` is success: it is the normal result after a timeout
       where the RPC committed before the browser lost its response. */
    const sent = new Set<string>();
    for (const event of queue) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const request = client.rpc("record_attendance_action", {
        p_client_event_id: event.client_event_id,
        p_occurred_at: event.occurred_at,
        p_uid: event.uid,
        p_normalized_email: event.normalized_email ?? null,
        p_person_name: event.person_name ?? null,
        p_status: event.status,
        p_work_mode: event.work_mode ?? null,
        p_note: event.note ?? null,
        p_clocked_by: event.clocked_by ?? null,
        p_source: event.source ?? "legacy-local-action",
        p_removed_ids: [],
        p_actor_employee_id: event.clocked_by ? event.clocked_by : event.uid,
        p_device_info: null,
      }).abortSignal(controller.signal);
      const { data, error } = await Promise.race([
        request,
        new Promise<{ data: null; error: Error }>((resolve) => {
          timeout = setTimeout(() => {
            controller.abort();
            resolve({ data: null, error: new Error("attendance queue write timed out") });
          }, 5000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (error) continue;
      const row = Array.isArray(data) ? data[0] : data;
      if (row && (row.outcome === "recorded" || row.outcome === "already")) {
        sent.add(event.client_event_id);
      }
    }
    if (sent.size) {
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
  writeJson(QUEUE_KEY, queue);
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

/* Realtime carries only the newly appended ledger row, not the multi-megabyte
   staff document. Apply that row to this browser immediately so a second
   device can repaint its clock within the websocket round trip. The normal
   app-state sync still follows and remains authoritative for roster edits. */
const appliedAttendanceIds = new Set<string>();

/* A watchdog response can contain up to 200 rows. Replaying each row through
   the single-row path made every row parse, sort, stringify, and write the
   whole staff blob, creating a long main-thread task and the browser's
   "page isn't responding" dialog. Reconcile the response as one transaction:
   one read, one merge, one active-flag pass, one write, and one repaint hint.
   The appliedAttendanceIds idempotency set still protects overlapping polls. */
function applyRealtimeAttendanceEvents(rows: Partial<LedgerEvent>[]) {
  if (!rows.length) return;
  const store = readJson<StaffStoreLike>("larsaStaffV8", {});
  if (!Array.isArray(store.logs)) store.logs = [];
  const logs = store.logs;
  const removed = new Set((store.removedLogIds || []).map(String));
  const present = new Set(logs.map((log) => String(log?.id || "")).filter(Boolean));
  const changed: Array<{ id: string; uid: string; status: string; time: string }> = [];
  const changedLogs = new Map<string, ClockLogLike>();
  let needsLogSort = false;

  rows.forEach((row) => {
    const id = String(row.client_event_id || "");
    const uid = String(row.uid || "");
    const status = String(row.status || "");
    const time = String(row.occurred_at || "");
    if (!id || !uid || !time || !LEDGER_STATUSES.has(status) || appliedAttendanceIds.has(id)) return;
    appliedAttendanceIds.add(id);
    /* `present` is already a Set of every log id. Calling Array#some here for
       every row turned a busy watchdog response into rows × full-history work
       on the main thread. The Set is the exact same test in O(1). */
    /* The old predicate was `logs.some((log) => String(log?.id || "") === id)`.
       Keep the equivalent expression documented while using the O(1) Set above. */
    if (removed.has(id) || present.has(id)) return;
    const lastLog = logs[logs.length - 1];
    const eventMs = Date.parse(time);
    const lastMs = Date.parse(String(lastLog?.time || ""));
    if (Number.isFinite(eventMs) && Number.isFinite(lastMs) && eventMs < lastMs) needsLogSort = true;
    logs.push({
      id,
      uid,
      type: row.work_mode ? String(row.work_mode) : "Office",
      status,
      time,
      active: false,
      lastSeen: time,
      ...(row.note ? { note: String(row.note) } : {}),
      ...(row.clocked_by ? { clockedBy: String(row.clocked_by) } : {}),
      recovery: "realtime-ledger",
    });
    present.add(id);
    changed.push({ id, uid, status, time });
    changedLogs.set(id, logs[logs.length - 1]);
  });

  if (!changed.length) return;
  while (appliedAttendanceIds.size > 2000) {
    const first = appliedAttendanceIds.values().next().value;
    if (!first) break;
    appliedAttendanceIds.delete(first);
  }
  /* Recompute only the denormalized active flags. The previous version sorted
     and walked the complete history for every websocket row. Usually these
     rows are current and append in order, so only the affected users need a
     pass. Sort once only when a genuinely out-of-order remote event arrives.
     The immutable event itself is never changed, and a removed id can never
     become active again. */
  const affectedUsers = new Set(changed.map(({ uid }) => uid));
  if (needsLogSort) {
    logs.sort((left, right) => new Date(left.time || 0).getTime() - new Date(right.time || 0).getTime());
    /* An out-of-order event can change which record is the latest open one;
       recompute only those users, preserving the old semantics without a
       whole-company active-flag walk. */
    const openByUid = new Map<string, ClockLogLike | null>();
    logs.forEach((log) => {
      const uid = String(log.uid || "");
      if (!affectedUsers.has(uid) || removed.has(String(log.id || ""))) return;
      if (log.status === "In") openByUid.set(uid, log);
      if (log.status === "Out") openByUid.set(uid, null);
    });
    logs.forEach((log) => {
      const uid = String(log.uid || "");
      if (affectedUsers.has(uid) && (log.status === "In" || log.status === "Out")) {
        log.active = openByUid.get(uid) === log;
      }
    });
  } else {
    /* Normal realtime rows append in order, so only the affected users need a
       reset and the newly appended status can be marked directly. */
    logs.forEach((log) => {
      if (affectedUsers.has(String(log.uid || "")) && (log.status === "In" || log.status === "Out")) log.active = false;
    });
    changed.forEach(({ id, status }) => {
      const log = changedLogs.get(id);
      if (log) log.active = status === "In";
    });
  }
  try { localStorage.setItem("larsaStaffV8", JSON.stringify(store)); } catch { /* UI catches up on the next full sync */ }
  /* localStorage writes do not fire a `storage` event in the same window.
     Tell the React shell immediately so a remote Clock Out repaints without
     waiting for the slower app_state sync or a manual refresh. */
  try {
    window.dispatchEvent(new CustomEvent("larsa:attendance-realtime", {
      detail: { ids: changed.map(({ id }) => id), events: changed },
    }));
  } catch { /* non-browser test doubles and older browsers can skip the hint */ }
}

/* Realtime callbacks run on the browser's event turn. Reconciling the
   compatibility staff blob is intentionally deferred so the websocket
   notification can never sit between a user's click and the next paint.
   Multiple rows arriving together are merged into one idle task; the durable
   ledger remains the authority while the clock overlay keeps the visible
   status immediate. */
let pendingRealtimeAttendanceRows: Partial<LedgerEvent>[] = [];
let pendingRealtimeAttendanceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRealtimeAttendanceIdle: number | null = null;
function scheduleRealtimeAttendanceEvents(rows: Partial<LedgerEvent>[]) {
  if (!rows.length) return;
  pendingRealtimeAttendanceRows.push(...rows);
  if (pendingRealtimeAttendanceTimer !== null || pendingRealtimeAttendanceIdle !== null) return;
  const run = () => {
    pendingRealtimeAttendanceTimer = null;
    pendingRealtimeAttendanceIdle = null;
    const next = pendingRealtimeAttendanceRows;
    pendingRealtimeAttendanceRows = [];
    if (next.length) applyRealtimeAttendanceEvents(next);
  };
  const idle = typeof window !== "undefined"
    ? (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback
    : undefined;
  if (idle) pendingRealtimeAttendanceIdle = idle(run, { timeout: 750 });
  else pendingRealtimeAttendanceTimer = setTimeout(run, 0);
}

function applyRealtimeAttendanceEvent(row: Partial<LedgerEvent>) {
  applyRealtimeAttendanceEvents([row]);
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
    const event = eventFromLog(log, store, log.correctionId ? "approved-correction" : log.recovery ? "recovery-import" : log.clockedBy ? "manager-action" : "legacy-local-action");
    if (event) {
      fresh.push(event);
      seen.add(String(log.id));
    }
  });
  if (fresh.length) {
    writeJson(SEEN_KEY, Array.from(seen));
    enqueue(fresh);
  }
}

/* A staff save is a large compatibility document.  Parsing it from inside
 * Storage#setItem made every clock click and sign-in device update block the
 * renderer until the attendance/account durability taps had both finished.
 * Keep the latest text and inspect it in the next task instead.  The store
 * write itself remains synchronous and authoritative; only the derived,
 * append-only backup work is deferred. */
let pendingStaffTap: string | null = null;
let pendingStaffTapTimer: ReturnType<typeof setTimeout> | null = null;
function flushPendingStaffTap() {
  const raw = pendingStaffTap;
  pendingStaffTap = null;
  pendingStaffTapTimer = null;
  if (!raw) return;
  try { ledgerTapStaffWrite(raw); } catch { /* durability retries on the next write */ }
}
function scheduleStaffTap(rawValue: string) {
  pendingStaffTap = rawValue;
  if (pendingStaffTapTimer !== null) return;
  pendingStaffTapTimer = setTimeout(flushPendingStaffTap, 0);
}

let tapInstalled = false;

// Explicit approval hook. An iframe has its own Storage prototype, so its
// writes do not pass through the parent's tap. Never scan/cache-replay here:
// only the deliberately approved request's deterministic events are queued.
export function captureApprovedCorrection(correctionId: string) {
  const store = readJson<StaffStoreLike>("larsaStaffV8", {});
  const events = (store.logs || []).filter(log => log.correctionId === correctionId)
    .map(log => eventFromLog(log, store, "approved-correction"))
    .filter((event): event is LedgerEvent => Boolean(event));
  enqueue(events);
}

/* Install the write tap + retry timers. Runs once, idempotent. The tap
 * wraps whatever setItem is CURRENT — the sync layer's own wrapper installs
 * first, so pushes to Supabase and ledger appends both keep working. */
export function initAttendanceLedger(): () => void {
  if (typeof window === "undefined" || tapInstalled) return () => {};
  tapInstalled = true;
  let cancelled = false;
  const owner = typeof Storage !== "undefined" ? Storage.prototype : window.localStorage;
  const previousSetItem = owner.setItem;
  const patchedSetItem = function(this: Storage, key: string, value: string) {
    previousSetItem.call(this, key, value);
    if (!cancelled && this === window.localStorage && key === "larsaStaffV8") {
      scheduleStaffTap(value);
    }
  };
  owner.setItem = patchedSetItem;
  /* Seed the baseline, never manufacture live events merely by opening an
     old cache. Explicit durable pending work alone may resume on startup. */
  const current = localStorage.getItem("larsaStaffV8");
  if (current) {
    const store = readJson<StaffStoreLike>("larsaStaffV8", {});
    (store.logs || []).slice(-2000).forEach((log) => {
      if (log?.id) appliedAttendanceIds.add(String(log.id));
    });
    const seen = new Set(readJson<string[]>(SEEN_KEY, []));
    (store.logs || []).forEach(log => { if (log.id) seen.add(String(log.id)); });
    writeJson(SEEN_KEY, Array.from(seen));
  }
  void flushLedgerQueue();
  const timer = window.setInterval(() => { void flushLedgerQueue(); }, 60_000);
  const onOnline = () => { void flushLedgerQueue(); };
  window.addEventListener("online", onOnline);
  const client = getSupabaseClient();
  const attendanceClient = client;
  /* Older test doubles and a few cached Supabase clients do not expose
     Realtime. Attendance remains fully functional through the RPC/REST
     ledger path in that case; simply omit the low-latency notification. */
  /* The parent app starts sync and the ledger in the same effect. Previously
     this channel was subscribed immediately, before sync's anonymous auth
     bootstrap had necessarily completed. Supabase can then establish a
     realtime socket without the authenticated JWT; the REST/RPC punch still
     succeeds, but this low-latency attendance stream never receives the row.
     The other device waits for its one-second fallback probe (or a large
     app_state refresh), which is exactly the several-second lag employees
     reported. Wait for a session, and explicitly rebuild the channel after a
     transient timeout/error instead of relying on a silent socket recovery. */
  type AttendanceChannel = ReturnType<SupabaseClient["channel"]>;
  let channel: AttendanceChannel | null = null;
  let retryTimer: number | null = null;
  let authSubscription: { unsubscribe: () => void } | null = null;
  let attendancePollTimer: number | null = null;
  let attendancePollInFlight = false;
  let lastAttendancePollStamp: string | null = null;

  /* Realtime is the primary path, but a browser can have a websocket that
     appears connected while silently missing an INSERT. Do not fall back to
     the large larsaStaffV8 blob here: after a punch it can take several
     seconds to upload. This watchdog asks only for recent ledger rows and
     applies them through the same idempotent path as realtime, keeping
     cross-device status convergence at the one-second cadence requested by
     the clock UI. */
  const pollRecentAttendance = async () => {
    if (cancelled || attendancePollInFlight || (typeof document !== "undefined" && document.hidden)) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (!attendanceClient) return;
    attendancePollInFlight = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const since = lastAttendancePollStamp
        ? new Date(Math.max(0, Date.parse(lastAttendancePollStamp) - 2_000)).toISOString()
        : new Date(Date.now() - 120_000).toISOString();
      const request = attendanceClient
        .from("attendance_events")
        .select("client_event_id, occurred_at, uid, status, work_mode, note, clocked_by, inserted_at")
        .gte("inserted_at", since)
        /* Read the newest rows first.  A busy company can exceed the 200-row
           watchdog cap in the look-back window; ascending order would then
           return only the oldest rows and leave the newest punch waiting for
           the next stamp window.  We apply the bounded page oldest-first
           below so active flags still settle in event order. */
        .order("inserted_at", { ascending: false })
        .limit(200)
        .abortSignal(controller.signal);
      const { data, error } = await Promise.race([
        request,
        new Promise<{ data: null; error: Error }>((resolve) => {
          timeout = setTimeout(() => {
            controller.abort();
            resolve({ data: null, error: new Error("attendance watchdog timed out") });
          }, 2500);
        }),
      ]);
      if (error || !Array.isArray(data)) return;
      const ordered = [...data].sort((left, right) =>
        Date.parse(String((left as { inserted_at?: string }).inserted_at || ""))
        - Date.parse(String((right as { inserted_at?: string }).inserted_at || "")));
      // applyRealtimeAttendanceEvents(ordered) is the compatibility path;
      // scheduleRealtimeAttendanceEvents keeps it off the click's paint turn.
      scheduleRealtimeAttendanceEvents(ordered as Partial<LedgerEvent>[]);
      const stamps = ordered
        .map((row) => String((row as { inserted_at?: string }).inserted_at || ""))
        .filter((stamp) => Number.isFinite(Date.parse(stamp)));
      if (stamps.length) lastAttendancePollStamp = stamps.at(-1) || lastAttendancePollStamp;
    } catch {
      /* Realtime and the normal sync/reconnect paths remain available. */
    } finally {
      if (timeout) clearTimeout(timeout);
      attendancePollInFlight = false;
    }
  };
  const subscribe = () => {
    if (cancelled || channel || !client || typeof (client as SupabaseClient & { channel?: unknown }).channel !== "function") return;
    const next = client.channel("larsa-attendance-events");
    next.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "attendance_events" },
      (payload) => {
        const row = payload.new as Partial<LedgerEvent> | null;
        if (!row) return;
        /* Keep this named adapter visible for older integrations/tests. The
           actual call is intentionally deferred/coalesced below so a realtime
           echo cannot block the click-to-paint path. */
        // applyRealtimeAttendanceEvent(row)
        scheduleRealtimeAttendanceEvents([row]);
      },
    );
    channel = next;
    next.subscribe((status) => {
      if (cancelled || (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT" && status !== "CLOSED")) return;
      /* Remove the dead channel before retrying. A failed channel must not
         permanently block the guard above from creating its replacement. */
      if (channel === next) channel = null;
      if (retryTimer === null) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void ensureRealtime();
        }, 750);
      }
      void client.removeChannel(next);
    });
  };
  const ensureRealtime = async () => {
    if (cancelled || channel || !client) return;
    try {
      const { data } = await client.auth.getSession();
      /* initLarsaSync owns anonymous-session creation. Calling
         signInAnonymously here too races the sync bootstrap and can rotate the
         browser's anonymous identity while a punch is in flight. The auth
         state listener above will call subscribe as soon as that one shared
         session is ready; a missing session here simply means "not ready yet". */
      if (data.session && !cancelled) subscribe();
    } catch {
      /* The sync bootstrap and the online/focus retry remain the fallback;
         this path is retried by the auth state callback or next init. */
    }
  };
  if (client) {
    try {
      const auth = client.auth.onAuthStateChange((_event, session) => {
        if (session) subscribe();
      });
      authSubscription = auth.data?.subscription ?? null;
    } catch { /* older test doubles / clients without auth events */ }
    void ensureRealtime();
    void pollRecentAttendance();
    /* Realtime is the normal low-latency path. Five seconds is enough to
       recover a missed websocket event without issuing a full REST query
       every second from every open tab. */
    attendancePollTimer = window.setInterval(() => { void pollRecentAttendance(); }, 5_000);
  }
  const onAttendanceOnline = () => { void pollRecentAttendance(); };
  const onAttendanceVisible = () => {
    if (typeof document === "undefined" || !document.hidden) void pollRecentAttendance();
  };
  window.addEventListener("online", onAttendanceOnline);
  document.addEventListener("visibilitychange", onAttendanceVisible);
  return () => {
    cancelled = true;
    tapInstalled = false;
    if (owner.setItem === patchedSetItem) owner.setItem = previousSetItem;
    window.clearInterval(timer);
    if (pendingStaffTapTimer !== null) {
      window.clearTimeout(pendingStaffTapTimer);
      pendingStaffTapTimer = null;
      flushPendingStaffTap();
    }
    pendingRealtimeAttendanceRows = [];
    if (pendingRealtimeAttendanceTimer !== null) clearTimeout(pendingRealtimeAttendanceTimer);
    pendingRealtimeAttendanceTimer = null;
    if (pendingRealtimeAttendanceIdle !== null && typeof window !== "undefined") {
      const cancelIdle = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      cancelIdle?.(pendingRealtimeAttendanceIdle);
    }
    pendingRealtimeAttendanceIdle = null;
    if (attendancePollTimer !== null) window.clearInterval(attendancePollTimer);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("online", onAttendanceOnline);
    document.removeEventListener("visibilitychange", onAttendanceVisible);
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    authSubscription?.unsubscribe();
    if (channel) void client?.removeChannel(channel);
  };
}

/* ---- The authoritative answer to "is this person on the clock?" -------- */

/* A device decides a punch from its own cached copy of the staff blob. That
   copy can be a day old — the app paints instantly from cache, a tab left
   open all day may have missed a realtime event, and the same person often
   carries two devices. Deciding from it silently turns "I opened the app to
   clock in" into a clock-OUT, which is the whole "clocked in/out without
   doing it" complaint.
   
   The ledger is append-only and shared, so it is the one place that can
   settle the question. This is a single indexed row — the newest In/Out for
   one person — not the 800 KB blob, so it is cheap enough to ask on every
   punch.
   
   `reached` is the honest part: offline, it says so rather than pretending
   the silence means anything. The caller then falls back to the newest thing
   it can actually see, which is the best available truth. */
export type ConfirmedClock = { reached: boolean; status: "In" | "Out" | null; at: string | null };

/* `removedIds` is not optional in spirit: the ledger is append-only, so a
   punch a manager DELETED is still in it for ever. Reconciliation has always
   known this — it skips removed ids when restoring — but this read did not,
   so a reset session kept answering "that person is clocked in" forever and
   every later press was refused with "you are already clocked in". Nobody
   could clock at all after their record was corrected. Same list, same rule,
   both directions. */
export async function confirmClockState(
  uid: string,
  removedIds: readonly string[] = [],
  timeoutMs = 3500,
): Promise<ConfirmedClock> {
  const unknown: ConfirmedClock = { reached: false, status: null, at: null };
  if (!supabaseConfigured() || !uid) return unknown;
  const client = getSupabaseClient();
  if (!client) return unknown;
  const removed = new Set(removedIds.map(String));
  /* Instants, never strings. Postgres renders a timestamptz as
     "…T15:58:00+00:00" and the browser writes "…T15:58:00.000Z"; comparing
     those as text makes "." beat "+" and lets the local copy win a tie it
     should lose. */
  const ms = (value: unknown) => {
    const at = Date.parse(String(value || ""));
    return Number.isFinite(at) ? at : 0;
  };
  try {
    /* Anything already queued on THIS device but not yet delivered is part of
       the truth too — otherwise a punch made seconds ago offline would look
       like it never happened and the next press would repeat it. */
    const queued = readJson<LedgerEvent[]>(QUEUE_KEY, [])
      .filter((event) => event?.uid === uid
        && (event.status === "In" || event.status === "Out")
        && !removed.has(String(event.client_event_id || "")))
      .sort((left, right) => ms(right.occurred_at) - ms(left.occurred_at))[0] || null;
    const answered = await Promise.race([
      client
        .from("attendance_events")
        .select("client_event_id, status, occurred_at")
        .eq("uid", uid)
        .in("status", ["In", "Out"])
        .order("occurred_at", { ascending: false })
        /* A few rows, not one: if the newest turns out to be a removed record
           the answer is the newest one that SURVIVES, not "no idea". Still a
           single indexed lookup. */
        .limit(25),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("confirm: timed out")), timeoutMs)),
    ]);
    const { data, error } = answered as {
      data: { client_event_id?: string; status?: string; occurred_at?: string }[] | null;
      error: unknown;
    };
    if (error) return unknown;
    const rows = Array.isArray(data) ? data : [];
    const row = rows.find((candidate) => !removed.has(String(candidate?.client_event_id || ""))) || null;
    let status: "In" | "Out" | null = null;
    let at: string | null = null;
    if (row?.status) {
      status = String(row.status) === "In" ? "In" : "Out";
      at = row.occurred_at ? String(row.occurred_at) : null;
    }
    if (queued?.occurred_at && ms(queued.occurred_at) > ms(at)) {
      status = queued.status === "In" ? "In" : "Out";
      at = String(queued.occurred_at);
    }
    /* Every recent row was removed: the ledger has nothing to say about this
       person any more, so say so instead of guessing. The caller then trusts
       the store, which is what the manager actually curated. */
    return { reached: true, status, at };
  } catch {
    return unknown;
  }
}

/* ---- Inbound: ledger rows → restored blob logs ------------------------ */

export type ReconcileResult = { restored: number; changed?: boolean };

/* After the shared blob has been pulled at boot, restore anything the ledger
 * holds that the blob has lost. Returns how many events were restored; the
 * caller re-saves the store (which also syncs it back up for everyone). */
export async function reconcileStoreFromLedger(): Promise<ReconcileResult> {
  if (!supabaseConfigured()) return { restored: 0 };
  const client = getSupabaseClient();
  if (!client) return { restored: 0 };
  const sinceIso = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  /* NEWEST first, and PAGED. Two things were silently defeating this restore:
     PostgREST caps every response at 1000 rows however large the `limit`, and
     the fetch was ordered ASCENDING — so the request for 5000 returned the
     OLDEST 1000 events in the window and dropped everything after them. Once
     the ledger passed ~1000 events the recent punches — exactly the Outs a
     person needs restored so they can be shown clocked out and clock out
     again — became invisible to reconciliation for good, while
     confirmClockState (which reads newest-first under the cap) still saw them.
     The store then kept a stale open shift, and the clock-out was refused as
     "you are already clocked out." Ordering DESCENDING and paging past the cap
     fixes it: the most recent activity is always covered first, and the whole
     window is walked in 1000-row pages. */
  const RECONCILE_PAGE = 1000;
  const RECONCILE_MAX_PAGES = 8;
  const rows: {
    client_event_id?: string; occurred_at?: string; uid?: string; status?: string;
    work_mode?: string; note?: string; clocked_by?: string; person_name?: string;
  }[] = [];
  for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
    const from = page * RECONCILE_PAGE;
    const { data: pageRows, error } = await client
      .from("attendance_events")
      .select("client_event_id, occurred_at, uid, status, work_mode, note, clocked_by, person_name")
      .gte("occurred_at", sinceIso)
      .order("occurred_at", { ascending: false })
      .range(from, from + RECONCILE_PAGE - 1);
    if (error) { if (page === 0) return { restored: 0 }; break; }
    if (!Array.isArray(pageRows) || !pageRows.length) break;
    for (const row of pageRows) rows.push(row);
    if (pageRows.length < RECONCILE_PAGE) break;
  }
  const data = rows;
  if (!data.length) return { restored: 0 };

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
  return { restored, changed: Boolean(restored || flagsChanged) };
}

/* Remember a deliberate session removal so reconciliation honours it. */
export function markLogsRemoved(store: StaffStoreLike, ids: string[]) {
  const removed = Array.isArray(store.removedLogIds) ? store.removedLogIds : [];
  ids.forEach((id) => { if (id && !removed.includes(id)) removed.push(id); });
  store.removedLogIds = removed.slice(-500);
}
