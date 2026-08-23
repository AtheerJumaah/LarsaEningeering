"use client";

/* The durable ACCOUNT ledger — the twin of lib/ledger.ts, and the answer to
 * the same failure in a different place.
 *
 * What went wrong. Attendance was already protected: every punch is appended
 * to attendance_events, a table nothing can delete, and the app restores from
 * it on boot. So when a stale device overwrote the shared staff blob, the
 * punches walked back. Accounts had no such backstop. They lived ONLY inside
 * that one overwritable JSON document, which means a browser holding an older
 * copy could save it back and erase people who had been created since — and
 * there was nothing left to restore them from. That is exactly what happened
 * on 8 August: accounts created during the day were repeatedly wiped, while
 * the punches those same people made survived untouched in the ledger.
 *
 * The fix, and why it is shaped this way. Accounts now get the identical
 * treatment:
 *
 *   OUT  every write of larsaStaffV8 is tapped, and every account in it is
 *        upserted into public.staff_accounts through an RPC. Queued in
 *        localStorage first and retried, so an account created offline or
 *        mid-outage still reaches the ledger.
 *   IN   on boot and on every sync settle, the ledger is read back and any
 *        account missing from the blob is put back.
 *
 * Deletion is the one thing that is NOT inferred. An account disappearing
 * from the blob means nothing — that is precisely the bug — so absence never
 * removes anything. An account leaves only by being TOMBSTONED: a deliberate,
 * attributed act recorded server-side, which is what the permanent-delete
 * path calls. Offboarding and the recycling bin do not tombstone, because
 * those keep the account in the directory with a flag; they were never
 * removals.
 *
 * The failure direction is chosen deliberately, the same way it was for
 * attendance: if a tombstone were itself lost, a removed account comes back
 * and an administrator removes it again. A real person's account never
 * silently vanishes. This app loses tidiness before it loses people. */

import { getSupabaseClient, supabaseConfigured } from "./supabase/client";

type AccountLike = {
  id?: string;
  name?: string;
  email?: string;
  username?: string;
  access?: string;
  [key: string]: unknown;
};

type StaffStoreLike = {
  users?: AccountLike[];
  removedUserIds?: string[];
};

type LedgerRow = {
  uid: string;
  name: string | null;
  normalized_email: string | null;
  access: string | null;
  username: string | null;
  record: AccountLike | null;
  removed_at: string | null;
};

const QUEUE_KEY = "larsaAccountQueueV1";
const SENT_KEY = "larsaAccountSentV1";

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
    /* storage full / private mode — the tap re-derives on the next write */
  }
}

function normalizeEmail(value: unknown): string {
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

/* A cheap content signature, so an unchanged account is not re-sent on every
   single blob write (which happens on every clock tick for somebody). */
function signatureOf(user: AccountLike): string {
  return JSON.stringify([
    user.id, user.name, normalizeEmail(user.email), user.username, user.access,
    user.enabled, user.offboarded, user.recycled, user.accountingAccess,
    /* The recency stamps are part of the signature so a stamped edit — a
       password change, a lifecycle action — re-delivers the record to the
       ledger, where staff_account_upsert keeps whichever copy is newest. */
    user.touchedAt, user.passwordChangedAt, user.pinChangedAt, user.emailVerified,
  ]);
}

/* ---- Outbound: blob accounts → ledger rows ----------------------------- */

type QueuedAccount = {
  uid: string;
  name: string;
  normalized_email: string;
  access: string;
  username: string;
  record: AccountLike;
};

let flushing = false;

export async function flushAccountQueue(): Promise<void> {
  if (flushing || !supabaseConfigured()) return;
  const client = getSupabaseClient();
  if (!client) return;
  const queue = readJson<QueuedAccount[]>(QUEUE_KEY, []);
  if (!queue.length) return;
  flushing = true;
  try {
    const { error } = await client.rpc("staff_account_upsert", { p_accounts: queue });
    if (!error) {
      const sent = new Set(queue.map((row) => row.uid + "|" + signatureOf(row.record)));
      const remaining = readJson<QueuedAccount[]>(QUEUE_KEY, []).filter(
        (row) => !sent.has(row.uid + "|" + signatureOf(row.record)),
      );
      writeJson(QUEUE_KEY, remaining);
      const already = readJson<string[]>(SENT_KEY, []);
      writeJson(SENT_KEY, Array.from(new Set([...already, ...sent])).slice(-2000));
    }
  } catch {
    /* stays queued; retried on the next write, the timer, or reconnect */
  } finally {
    flushing = false;
  }
}

function enqueue(rows: QueuedAccount[]) {
  if (!rows.length) return;
  const queue = readJson<QueuedAccount[]>(QUEUE_KEY, []);
  const present = new Set(queue.map((row) => row.uid + "|" + signatureOf(row.record)));
  rows.forEach((row) => {
    const key = row.uid + "|" + signatureOf(row.record);
    if (!present.has(key)) { queue.push(row); present.add(key); }
  });
  writeJson(QUEUE_KEY, queue.slice(-1000));
  void flushAccountQueue();
}

/* Called on EVERY write of larsaStaffV8. Any account whose content we have
 * not already delivered is queued — whoever wrote it, from the Access Center,
 * a self-service signup, or the legacy engine iframe, because all of them
 * funnel through this one localStorage key. */
export function accountsTapStaffWrite(rawValue: string) {
  let store: StaffStoreLike;
  try {
    store = JSON.parse(rawValue) as StaffStoreLike;
  } catch {
    return;
  }
  const users = Array.isArray(store?.users) ? store.users : [];
  if (!users.length) return;
  const sent = new Set(readJson<string[]>(SENT_KEY, []));
  const fresh: QueuedAccount[] = [];
  users.forEach((user) => {
    const uid = String(user?.id || "");
    if (!uid) return;
    if (sent.has(uid + "|" + signatureOf(user))) return;
    fresh.push({
      uid,
      name: String(user.name || ""),
      normalized_email: normalizeEmail(user.email),
      access: String(user.access || ""),
      username: String(user.username || ""),
      record: user,
    });
  });
  if (fresh.length) enqueue(fresh);
}

let tapInstalled = false;

/* Install the write tap and retry timers. Idempotent; wraps whatever setItem
 * is current, so it composes with the sync layer's wrapper and the attendance
 * ledger's rather than replacing either. */
export function initAccountLedger(): () => void {
  if (typeof window === "undefined" || tapInstalled) return () => {};
  tapInstalled = true;
  const previousSetItem = window.localStorage.setItem.bind(window.localStorage);
  window.localStorage.setItem = function accountPatchedSetItem(key: string, value: string) {
    previousSetItem(key, value);
    if (key === "larsaStaffV8") {
      try { accountsTapStaffWrite(value); } catch { /* never break a save */ }
    }
  };
  const current = localStorage.getItem("larsaStaffV8");
  if (current) { try { accountsTapStaffWrite(current); } catch { /* as above */ } }
  const timer = window.setInterval(() => { void flushAccountQueue(); }, 60_000);
  const onOnline = () => { void flushAccountQueue(); };
  window.addEventListener("online", onOnline);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("online", onOnline);
  };
}

/* ---- Inbound: ledger rows → restored accounts -------------------------- */

export type AccountReconcileResult = { restored: number; names: string[] };

/* Put back every account the ledger knows about that the blob has lost.
 *
 * Absence from the blob is never read as a deletion — that is the very bug
 * this exists to undo. Only two things stop an account being restored: a
 * server-side tombstone (a deliberate permanent delete), or a local
 * removedUserIds entry written by that same audited path. */
export async function reconcileAccountsFromLedger(): Promise<AccountReconcileResult> {
  const empty = { restored: 0, names: [] as string[] };
  if (!supabaseConfigured()) return empty;
  const client = getSupabaseClient();
  if (!client) return empty;
  const { data, error } = await client
    .from("staff_accounts")
    .select("uid, name, normalized_email, access, username, record, removed_at")
    .is("removed_at", null)
    .limit(2000);
  if (error || !Array.isArray(data) || !data.length) return empty;

  const raw = localStorage.getItem("larsaStaffV8");
  if (!raw) return empty;
  let store: StaffStoreLike;
  try {
    store = JSON.parse(raw) as StaffStoreLike;
  } catch {
    return empty;
  }
  if (!Array.isArray(store.users)) store.users = [];
  const present = new Set(store.users.map((user) => String(user?.id || "")));
  /* Emails are the business identity, so an account whose address is already
     held by somebody live is NOT re-added — that would hand one person two
     records and two sets of hours. It stays in the ledger for an admin to
     look at instead. */
  const liveEmails = new Set(
    store.users.map((user) => normalizeEmail(user?.email)).filter(Boolean),
  );
  const removed = new Set((store.removedUserIds || []).map(String));

  const names: string[] = [];
  (data as LedgerRow[]).forEach((row) => {
    const uid = String(row.uid || "");
    if (!uid || present.has(uid) || removed.has(uid)) return;
    const email = normalizeEmail(row.normalized_email);
    if (email && liveEmails.has(email)) return;
    const record: AccountLike = (row.record && typeof row.record === "object" && row.record.id)
      ? { ...row.record }
      : {
        id: uid,
        name: row.name || `Needs identification (${uid})`,
        email: email || "",
        username: row.username || "",
        access: row.access || "Engineer",
        enabled: true,
      };
    record.id = uid;
    record.recovery = "account-restore";
    store.users!.push(record);
    present.add(uid);
    if (email) liveEmails.add(email);
    names.push(String(record.name || uid));
  });

  if (names.length) localStorage.setItem("larsaStaffV8", JSON.stringify(store));
  return { restored: names.length, names };
}

/* A deliberate permanent delete: remembered locally so reconciliation honours
 * it, and tombstoned server-side so every OTHER device honours it too. The
 * local list alone would not be enough — another browser would simply restore
 * the account from the ledger a moment later. */
export function markAccountsRemoved(store: StaffStoreLike, ids: string[]) {
  const removed = Array.isArray(store.removedUserIds) ? store.removedUserIds : [];
  ids.forEach((id) => { if (id && !removed.includes(id)) removed.push(id); });
  store.removedUserIds = removed.slice(-500);
}

/* Returns whether the tombstone was actually recorded server-side. The
 * permanent-delete path REQUIRES a true here before it touches the shared
 * document: under the repair_008 healing rules an account that leaves the
 * document without a server-side tombstone is put straight back, so deleting
 * locally first would only produce a delete that undoes itself. */
export async function tombstoneAccount(uid: string, by: string, reason: string): Promise<boolean> {
  if (!uid || !supabaseConfigured()) return false;
  const client = getSupabaseClient();
  if (!client) return false;
  try {
    const { error } = await client.rpc("staff_account_tombstone", { p_uid: uid, p_by: by, p_reason: reason });
    return !error;
  } catch {
    return false;
  }
}

/* Reactivating a permanently deleted account (restoring from the bin) has to
 * lift the tombstone, or reconciliation would keep refusing to bring it back. */
export async function untombstoneAccount(uid: string, by: string): Promise<void> {
  if (!uid || !supabaseConfigured()) return;
  const client = getSupabaseClient();
  if (!client) return;
  try {
    await client.rpc("staff_account_untombstone", { p_uid: uid, p_by: by });
  } catch {
    /* retried the next time the account is saved */
  }
}
