"use client";

/* Platform Settings: where the SOFTWARE is administered, as opposed to the
 * company that runs inside it.
 *
 * Everything on this screen is enforced by the auth-policy function, not by
 * this component. Being able to see the panel proves nothing; every save is
 * refused server-side unless the actor's email is in platform_admins AND they
 * present a fresh emailed code. The panel's job is to collect the changes and
 * the code, then show what the server decided.
 *
 * The step-up is one code per batch of changes, requested when the person
 * presses save -- not one per toggle, which would make the screen unusable,
 * and not on open, which would spend a code on someone who only came to look.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Database, DownloadCloud, KeyRound, Mail, Save, ShieldCheck, Smartphone, UserCog } from "lucide-react";
import { getSupabaseClient, supabaseConfigured } from "../lib/supabase/client";
import { registerBackCloser } from "./backstack";
import { normalizeReportingWeekStart, publishReportingWeekStart, REPORTING_WEEK_DAYS } from "../lib/reporting-week.mjs";
import { publishPolicy } from "../lib/verification";

type Policy = {
  enabled: boolean;
  engineer_hours: number | null;
  privileged_hours: number | null;
  force_relogin: boolean;
  self_signup_enabled: boolean;
  signup_requires_approval: boolean;
  initial_verification_required: boolean;
  pin_verification_required: boolean;
  pin_hours: number;
  interval_unit?: "hours" | "days" | "business_days";
  week_start_day: number;
  attendance_notifications: AttendanceNotificationPolicy;
  attendance_approval: {
    add_hours_requires_approval: boolean;
    trim_hours_requires_approval: boolean;
  };
};

type AttendanceNotificationPolicy = {
  enabled: boolean;
  push_enabled: boolean;
  email_enabled: boolean;
  email_hourly: boolean;
  milestone_interval_hours: number;
  milestone_max_hours: number;
  missing_clock_in: boolean;
  missing_grace_minutes: number;
  use_schedule: boolean;
  use_work_pattern: boolean;
  pattern_lookback_days: number;
  pattern_min_days: number;
  active_from_hour: number;
  active_to_hour: number;
  critical_shift_hours: number;
  notify_manager_on_critical: boolean;
};

type AuditRow = { at: string; actor: string | null; action: string; target: string | null };
type AdminRow = { email: string; added_by: string | null; added_at: string };
type ExemptionRow = { user_id: string; exempt_reason: string | null; exempt_set_by: string | null };

type Person = { id: string; name: string; email?: string; enabled?: boolean };

type BackupSettings = { enabled: boolean; interval_hours: number; retain_days: number; emails: string[]; updated_at?: string; updated_by?: string };
type BackupRow = { id: string; created_at: string; kind: string; label: string | null; table_counts: Record<string, number>; byte_size: number; created_by: string | null };

/* Never let password or PIN hashes leave the database in a downloaded file,
   the same rule the in-app Data Center export already follows. */
function stripBackupSecrets(data: unknown): unknown {
  try {
    const clone = JSON.parse(JSON.stringify(data)) as { tables?: { app_state?: Array<{ store_key?: string; data?: { users?: Array<Record<string, unknown>> } }> } };
    const appState = clone?.tables?.app_state;
    if (Array.isArray(appState)) {
      for (const row of appState) {
        if (row?.store_key === "larsaStaffV8" && Array.isArray(row.data?.users)) {
          for (const u of row.data!.users!) { delete u.password; delete u.pin; delete u.passwordHash; delete u.pinHash; }
        }
      }
    }
    return clone;
  } catch {
    return data;
  }
}

/* A captured snapshot is one JSON object: every backed-up table becomes an
   array of its rows under `tables`. The point-in-time viewer reads it directly
   — nothing is written, and the copy it reads is already secret-stripped by the
   server (platform_backup_admin_get runs platform_backup_export_data). */
type SnapshotRow = Record<string, unknown>;
type SnapshotData = { format?: string; version?: number; captured_at?: string; tables?: Record<string, SnapshotRow[]> };

/* The staff directory lives inside one app_state blob, not its own table. */
function snapshotStaff(data: SnapshotData): SnapshotRow[] {
  const appState = data?.tables?.app_state;
  if (!Array.isArray(appState)) return [];
  const row = appState.find((r) => (r as { store_key?: string }).store_key === "larsaStaffV8");
  const users = (row as { data?: { users?: SnapshotRow[] } } | undefined)?.data?.users;
  return Array.isArray(users) ? users : [];
}

/* Render any cell — a scalar as text, an object/array as compact JSON — without
   ever letting one runaway value blow out the row height. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    try { const s = JSON.stringify(v); return s.length > 90 ? s.slice(0, 90) + "…" : s; }
    catch { return "[object]"; }
  }
  const s = String(v);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

/* A generic, read-only grid for an array of table rows. Columns are the union
   of keys seen across the rows (capped), rows are capped too, and both caps are
   surfaced rather than hidden so a big table never reads as if it were small. */
function DataGrid({ rows }: { rows: SnapshotRow[] }) {
  if (!rows.length) return <p className="org-none">No rows.</p>;
  const MAX_COLS = 9, MAX_ROWS = 150;
  const keySet: string[] = [];
  for (const r of rows.slice(0, 60)) {
    for (const k of Object.keys(r || {})) if (!keySet.includes(k)) keySet.push(k);
  }
  const cols = keySet.slice(0, MAX_COLS);
  const extraCols = keySet.length - cols.length;
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <div style={{ overflowX: "auto", marginTop: 6 }}>
      <table className="pit-table">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}{extraCols > 0 ? <th>+{extraCols}</th> : null}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c} title={cellText(r?.[c])}>{cellText(r?.[c])}</td>)}{extraCols > 0 ? <td>…</td> : null}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS ? <p className="ps-note">Showing first {MAX_ROWS} of {rows.length} rows. Download the snapshot for the complete data.</p> : null}
    </div>
  );
}

/* The point-in-time window: the platform as it stood when this snapshot was
   taken. Staff first (the app's heart), then every other table as a collapsible
   grid. Strictly read-only — a historical view, never an editor. */
function PointInTimeModal({ row, data, busy, onClose, onDownload }: { row: BackupRow; data: SnapshotData | null; busy: boolean; onClose: () => void; onDownload: () => void }) {
  const [openTable, setOpenTable] = useState<string | null>(null);
  const staff = data ? snapshotStaff(data) : [];
  const tables = data?.tables || {};
  const tableNames = Object.keys(tables).filter((t) => t !== "app_state").sort();
  const otherStoreKeys = Array.isArray(tables.app_state)
    ? (tables.app_state as Array<{ store_key?: string }>).map((r) => r.store_key).filter((k): k is string => Boolean(k) && k !== "larsaStaffV8")
    : [];
  const totalRecords = Object.values(tables).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  return (
    <div className="pit-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="pit-card" onClick={(e) => e.stopPropagation()}>
        <div className="pit-head">
          <div>
            <span className="org-eyebrow"><Database size={14} /> Point in time</span>
            <h3 style={{ margin: "4px 0 0" }}>Platform as of {new Date(row.created_at).toLocaleString()}</h3>
            <small className="pit-sub">{row.kind === "manual" ? "manual" : "scheduled"} snapshot · {totalRecords} records across {Object.keys(tables).length} tables · read-only</small>
          </div>
          <button type="button" className="btn small" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!data ? <p className="org-none" style={{ padding: 16 }}>Loading this day&apos;s data…</p> : (
          <div className="pit-body">
            <div className="pit-section">
              <h4>Staff directory <small>({staff.length})</small></h4>
              {staff.length === 0 ? <p className="org-none">No staff in this snapshot.</p> : (
                <div style={{ overflowX: "auto" }}>
                  <table className="pit-table">
                    <thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Department</th><th>Enabled</th></tr></thead>
                    <tbody>
                      {staff.map((u, i) => (
                        <tr key={i}>
                          <td>{cellText(u.name)}</td>
                          <td>{cellText(u.email)}</td>
                          <td>{cellText(u.access)}</td>
                          <td>{cellText(u.department)}</td>
                          <td>{u.enabled === false ? "no" : "yes"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="pit-section">
              <h4>Accounting, payroll &amp; operations</h4>
              <p className="ps-note" style={{ marginTop: 2 }}>Every backed-up table as it was that day. Open one to read its records.</p>
              <ul className="org-people" style={{ marginTop: 6 }}>
                {tableNames.map((t) => {
                  const arr = Array.isArray(tables[t]) ? tables[t] : [];
                  const isOpen = openTable === t;
                  return (
                    <li key={t} style={{ flexDirection: "column", alignItems: "stretch" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                        <span><b>{t}</b><small>{arr.length} record{arr.length === 1 ? "" : "s"}</small></span>
                        <button type="button" className="btn small" disabled={arr.length === 0} onClick={() => setOpenTable(isOpen ? null : t)}>{isOpen ? "Hide" : "Open"}</button>
                      </div>
                      {isOpen ? <DataGrid rows={arr} /> : null}
                    </li>
                  );
                })}
              </ul>
              {otherStoreKeys.length ? <p className="ps-note">Also captured in app settings: {otherStoreKeys.join(", ")}.</p> : null}
            </div>
          </div>
        )}

        <div className="pit-foot">
          <button type="button" className="btn small" disabled={busy || !data} onClick={onDownload}><DownloadCloud size={13} /> Download this snapshot</button>
          <button type="button" className="org-add" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

async function call(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!supabaseConfigured()) return null;
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data, error } = await client.functions.invoke("auth-policy", { body });
    if (error) return null;
    return (data || null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/* Read-only settings calls must never hold the whole page on an endless
   spinner. A slow Edge Function may still finish in the background, but the
   screen gets its control back and can retry or show a useful error. Writes
   deliberately keep using call() above: timing out a save that later commits
   would invite a dangerous double-submit. */
async function readCall(body: Record<string, unknown>, timeoutMs = 6500): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(body),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_ATTENDANCE_NOTIFICATIONS: AttendanceNotificationPolicy = {
  enabled: true,
  push_enabled: true,
  email_enabled: true,
  email_hourly: false,
  milestone_interval_hours: 1,
  milestone_max_hours: 9,
  missing_clock_in: true,
  missing_grace_minutes: 90,
  use_schedule: true,
  use_work_pattern: true,
  pattern_lookback_days: 56,
  pattern_min_days: 2,
  active_from_hour: 7,
  active_to_hour: 21,
  critical_shift_hours: 12,
  notify_manager_on_critical: true,
};

function normalizePolicy(value: unknown): Policy | null {
  if (!value || typeof value !== "object") return null;
  const policy = value as Policy;
  return {
    ...policy,
    week_start_day: normalizeReportingWeekStart(policy.week_start_day),
    attendance_notifications: {
      ...DEFAULT_ATTENDANCE_NOTIFICATIONS,
      ...(policy.attendance_notifications || {}),
    },
    attendance_approval: {
      add_hours_requires_approval: policy.attendance_approval?.add_hours_requires_approval === true,
      trim_hours_requires_approval: policy.attendance_approval?.trim_hours_requires_approval === true,
    },
  };
}

async function sendStepUpCode(email: string, name?: string): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  const client = getSupabaseClient();
  if (!client) return false;
  try {
    const { data } = await client.functions.invoke("auth-code", { body: { op: "send", email, purpose: "verify", name } });
    return Boolean(data && (data as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

function VerificationInterval({ id, title, description, enabled, value, unit, disabled, onToggle, onChange }: {
  id: string; title: string; description: string; enabled: boolean; value: number;
  unit: string; disabled: boolean; onToggle: (enabled: boolean) => void; onChange: (value: number) => void;
}) {
  return (
    <div className="ps-field ps-interval" data-enabled={enabled}>
      <div className="ps-interval-head">
        <label htmlFor={`${id}-interval`}>{title}</label>
        <label className="ps-switch">
          <input type="checkbox" role="switch" aria-label={`${title} on or off`} checked={enabled} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} />
          <span className="ps-switch-track" aria-hidden="true" />
          <span>{enabled ? "On" : "Off"}</span>
        </label>
      </div>
      <div className="ps-inline">
        <input id={`${id}-interval`} type="number" min={1} max={8760} disabled={disabled || !enabled} value={value} aria-describedby={`${id}-hint`} onChange={(event) => onChange(Math.max(1, Math.min(8760, Number(event.target.value) || 1)))} />
        <small>{unit}</small>
      </div>
      <small id={`${id}-hint`} className="ps-note">{description}</small>
    </div>
  );
}

export function PlatformSettings({ viewer, users }: { viewer: Person | null; users: Person[] }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policyError, setPolicyError] = useState("");
  const intervalValues = useRef({ engineer: 72, privileged: 24 });
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [exemptions, setExemptions] = useState<ExemptionRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [message, setMessage] = useState("");

  /* The pending action: what to run once the code arrives. */
  const [pending, setPending] = useState<null | { kind: "save" } | { kind: "exempt"; userId: string; exempt: boolean } | { kind: "grant"; email: string } | { kind: "revoke"; email: string }>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [exemptTarget, setExemptTarget] = useState("");
  const [grantTarget, setGrantTarget] = useState("");

  const [backupCfg, setBackupCfg] = useState<BackupSettings | null>(null);
  const [backupDraft, setBackupDraft] = useState<BackupSettings | null>(null);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupError, setBackupError] = useState("");
  const [backupMsg, setBackupMsg] = useState("");
  const [backupEmail, setBackupEmail] = useState("");

  /* Point-in-time viewing: which snapshot is open, and its loaded data. */
  const [pitRow, setPitRow] = useState<BackupRow | null>(null);
  const [pitData, setPitData] = useState<SnapshotData | null>(null);
  const [pitBusy, setPitBusy] = useState(false);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((row) => map.set(row.id, row.name));
    return (id: string) => map.get(id) || id;
  }, [users]);

  async function loadPlatformLists() {
    /* These reads are independent. Running them in series made a single slow
       audit query delay everything behind it and multiplied the apparent load
       time. They are secondary data, so none of them blocks the settings form. */
    const who = viewer?.email || "";
    const [a, e, l] = await Promise.all([
      readCall({ op: "platformAdmins", actorEmail: who }, 8000),
      readCall({ op: "exemptions", actorEmail: who }, 8000),
      readCall({ op: "audit", actorEmail: who }, 8000),
    ]);
    if (a?.ok) setAdmins((a.rows as AdminRow[]) || []);
    if (e?.ok) setExemptions((e.rows as ExemptionRow[]) || []);
    if (l?.ok) setAuditRows((l.rows as AuditRow[]) || []);
  }

  async function refresh(attempt = 0) {
    if (attempt === 0) {
      setPolicyLoading(true);
      setPolicyError("");
    }
    const p = await readCall({ op: "policy" });
    const next = p?.ok ? normalizePolicy(p.policy) : null;
    if (!next) {
      if (attempt === 0) {
        const client = getSupabaseClient();
        try { await client?.auth.refreshSession(); } catch { /* retry regardless */ }
        return refresh(1);
      }
      setPolicyLoading(false);
      setPolicyError("Platform Settings did not respond. Your other work is safe; check the connection and try again.");
      return;
    }
    setPolicy(next);
    setDraft(next);
    publishReportingWeekStart(next.week_start_day);
    setPolicyLoading(false);
    if (next.engineer_hours !== null) intervalValues.current.engineer = next.engineer_hours;
    if (next.privileged_hours !== null) intervalValues.current.privileged = next.privileged_hours;
    void loadPlatformLists();
  }

  /* Loading the backup settings used to fail silently, and the panel then sat
     on "Loading backup settings..." for ever — so the schedule, the addresses
     and the snapshot list simply never appeared and the whole feature looked
     like it had never been built. The commonest cause is the least dramatic:
     a browser left open overnight reaches this with an expired token and the
     call comes back 401. So a failure now refreshes the session and tries
     again, and if it still will not load it SAYS so, with a way to retry. */
  async function loadBackups(attempt = 0) {
    const who = viewer?.email || "";
    const client = getSupabaseClient();
    if (!who || !client) return;
    if (attempt === 0) { setBackupError(""); setBackupLoading(true); }
    const s = await client.rpc("platform_backup_settings_get", { p_actor_email: who });
    if (s.error) {
      if (attempt === 0) {
        try { await client.auth.refreshSession(); } catch { /* try the call again regardless */ }
        return loadBackups(1);
      }
      setBackupLoading(false);
      setBackupError(String(s.error.message || "").toLowerCase().includes("forbidden")
        ? "Your account is not allowed to manage backups."
        : "Could not load the backup settings. Check your connection and try again.");
      return;
    }
    setBackupLoading(false);
    if (s.data) { setBackupCfg(s.data as BackupSettings); setBackupDraft(s.data as BackupSettings); }
    const l = await client.rpc("platform_backup_admin_list", { p_actor_email: who });
    if (!l.error && Array.isArray(l.data)) setBackups(l.data as BackupRow[]);
  }

  async function saveBackupSettings() {
    const who = viewer?.email || "";
    const client = getSupabaseClient();
    if (!who || !client || !backupDraft) return;
    setBackupBusy(true);
    const r = await client.rpc("platform_backup_settings_set", {
      p_actor_email: who, p_enabled: backupDraft.enabled, p_interval_hours: backupDraft.interval_hours,
      p_retain_days: backupDraft.retain_days, p_emails: backupDraft.emails,
    });
    setBackupBusy(false);
    if (!r.error && r.data) { setBackupCfg(r.data as BackupSettings); setBackupDraft(r.data as BackupSettings); setBackupMsg("Backup settings saved."); }
    else setBackupMsg("Could not save backup settings.");
  }

  async function runManualBackup() {
    const who = viewer?.email || "";
    const client = getSupabaseClient();
    if (!who || !client) return;
    setBackupBusy(true);
    setBackupMsg("Taking a backup...");
    const r = await client.rpc("platform_backup_admin_run", { p_actor_email: who, p_label: "Manual backup" });
    setBackupBusy(false);
    if (!r.error) { setBackupMsg("Backup taken."); loadBackups(); }
    else setBackupMsg("Could not take a backup.");
  }

  async function downloadBackup(row: BackupRow) {
    const who = viewer?.email || "";
    const client = getSupabaseClient();
    if (!who || !client) return;
    setBackupBusy(true);
    const r = await client.rpc("platform_backup_admin_get", { p_actor_email: who, p_id: row.id });
    setBackupBusy(false);
    if (r.error || !r.data) { setBackupMsg("Could not load that backup."); return; }
    const safe = stripBackupSecrets(r.data);
    const blob = new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `larsa-backup-${new Date(row.created_at).toISOString().slice(0, 10)}-${row.id.slice(0, 8)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  /* Open a snapshot for reading. The server returns it already stripped of
     password and PIN hashes, so the historical view can never expose them. */
  async function openPointInTime(row: BackupRow) {
    const who = viewer?.email || "";
    const client = getSupabaseClient();
    if (!who || !client) return;
    setPitRow(row); setPitData(null); setPitBusy(true);
    const r = await client.rpc("platform_backup_admin_get", { p_actor_email: who, p_id: row.id });
    setPitBusy(false);
    if (r.error || !r.data) { setBackupMsg("Could not open that snapshot."); setPitRow(null); return; }
    setPitData(r.data as SnapshotData);
  }
  function closePointInTime() { setPitRow(null); setPitData(null); }

  /* The phone's Back button closes the open snapshot window rather than
     navigating away underneath it. */
  useEffect(() => {
    if (!pitRow) return;
    return registerBackCloser(() => { setPitRow(null); setPitData(null); });
  }, [pitRow]);

  useEffect(() => { refresh(); loadBackups(); }, []);

  async function begin(action: NonNullable<typeof pending>) {
    if (!viewer || !viewer.email) return;
    setBusy(true);
    setMessage("Sending a confirmation code to " + viewer.email + "...");
    const sent = await sendStepUpCode(viewer.email, viewer.name);
    setBusy(false);
    if (!sent) {
      setMessage("Could not send the code. Wait a minute and try again.");
      return;
    }
    setPending(action);
    setCode("");
    setMessage("Enter the code sent to " + viewer.email + " to confirm this change.");
  }

  async function confirm() {
    if (!pending || !viewer || !viewer.email) return;
    setBusy(true);
    let result: Record<string, unknown> | null = null;
    const base = { actorEmail: viewer.email, code: code.trim() };

    if (pending.kind === "save" && draft) {
      result = await call({ op: "save", ...base, policy: draft });
    } else if (pending.kind === "exempt") {
      result = await call({ op: "exempt", ...base, userId: pending.userId, exempt: pending.exempt, reason: "Set from Platform Settings" });
    } else if (pending.kind === "grant") {
      result = await call({ op: "grantPlatform", ...base, targetEmail: pending.email });
    } else if (pending.kind === "revoke") {
      result = await call({ op: "revokePlatform", ...base, targetEmail: pending.email });
    }

    setBusy(false);
    if (result && result.ok) {
      setPending(null);
      setCode("");
      setMessage("Saved.");
      if (result.policy) publishReportingWeekStart((result.policy as Policy).week_start_day);
      if (result.policy) publishPolicy(result.policy as Policy);
      refresh();
    } else {
      setMessage(String((result && result.error) || "That code was not accepted."));
    }
  }

  if (!policy || !draft) {
    return (
      <div className="platform-settings">
        <section className="org-card ps-load-state" aria-live="polite">
          <span className="org-eyebrow"><ShieldCheck size={14} /> Platform settings</span>
          <h3>{policyLoading ? "Loading settings…" : "Settings could not load"}</h3>
          <p className="ps-note">{policyLoading
            ? "This should take only a few seconds."
            : policyError || "The settings service did not respond."}</p>
          {!policyLoading ? <button type="button" className="org-add" onClick={() => refresh()}>Try again</button> : null}
        </section>
      </div>
    );
  }

  const intervalUnit = draft.interval_unit === "days" ? "days" : draft.interval_unit === "business_days" ? "business days" : "hours";
  const dirty = JSON.stringify(policy) !== JSON.stringify(draft);
  const backupDirty = Boolean(backupCfg && backupDraft && JSON.stringify(backupCfg) !== JSON.stringify(backupDraft));

  return (
    <div className="platform-settings">
      <div className="ps-savebar" aria-label="Save platform settings">
        <div className="ps-savebar-main">
          <div className="ps-save-summary">
            <b>Platform settings</b>
            <span className={dirty ? "ps-save-state is-dirty" : "ps-save-state"} role="status">{dirty ? "Unsaved changes" : "All changes saved"}</span>
          </div>
          <div className="ps-actions">
            <button type="button" className="btn small" disabled={!dirty || busy || Boolean(pending)} onClick={() => {
              if (policy.engineer_hours !== null) intervalValues.current.engineer = policy.engineer_hours;
              if (policy.privileged_hours !== null) intervalValues.current.privileged = policy.privileged_hours;
              setDraft(policy);
              setMessage("");
            }}>Discard</button>
            <button type="button" className="org-add" disabled={!dirty || busy || Boolean(pending)} onClick={() => begin({ kind: "save" })}><Save size={15} /> {busy ? "Please wait…" : "Save changes"}</button>
          </div>
        </div>
      {message ? <p className="org-note">{message}</p> : null}

      {pending ? (
        <div className="ps-confirm" role="group" aria-label="Confirm settings change">
          <input
            aria-label="Confirmation code"
            className="ps-input"
            type="text"
            inputMode="numeric"
            maxLength={8}
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
          <button type="button" className="org-add" disabled={busy || !code.trim()} onClick={confirm}>Confirm</button>
          <button type="button" className="btn small" disabled={busy} onClick={() => { setPending(null); setCode(""); setMessage(""); }}>Cancel</button>
        </div>
      ) : null}

      </div>

      <fieldset className="ps-policy-fields" disabled={busy || Boolean(pending)}>
      <section className="org-card">
        <span className="org-eyebrow"><ShieldCheck size={14} /> Sign-in security</span>
        <h3>Periodic email verification</h3>

        <label className="ps-row">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          <span><b>Require periodic verification</b><small>Off means nobody is ever asked after sign-in.</small></span>
        </label>

        <label className="ps-field" style={{ marginBottom: 8 }}>
          <span>Counted in</span>
          <span className="ps-inline">
            <select
              value={draft.interval_unit || "hours"}
              onChange={(e) => setDraft({ ...draft, interval_unit: e.target.value as "hours" | "days" | "business_days" })}
            >
              <option value="hours">Hours</option>
              <option value="days">Calendar days</option>
              <option value="business_days">Business days (Sun–Thu)</option>
            </select>
            <small>Email intervals use this unit. Business days follow Sun–Thu. PIN re-verification always uses hours.</small>
          </span>
        </label>
        <div className="ps-grid ps-verification-grid">
          <VerificationInterval id="engineer" title="Engineers" description="Email verification for employee sign-ins."
            enabled={draft.engineer_hours !== null} value={draft.engineer_hours ?? intervalValues.current.engineer} unit={intervalUnit}
            disabled={!draft.enabled} onToggle={(enabled) => setDraft({ ...draft, engineer_hours: enabled ? intervalValues.current.engineer : null })}
            onChange={(value) => { intervalValues.current.engineer = value; setDraft({ ...draft, engineer_hours: value }); }} />
          <VerificationInterval id="privileged" title="Accountants & admins" description="Email verification for privileged sign-ins."
            enabled={draft.privileged_hours !== null} value={draft.privileged_hours ?? intervalValues.current.privileged} unit={intervalUnit}
            disabled={!draft.enabled} onToggle={(enabled) => setDraft({ ...draft, privileged_hours: enabled ? intervalValues.current.privileged : null })}
            onChange={(value) => { intervalValues.current.privileged = value; setDraft({ ...draft, privileged_hours: value }); }} />
          <VerificationInterval id="pin" title="PIN re-verification" description="PIN sign-in asks for an email code. 168 hours = weekly."
            enabled={draft.pin_verification_required !== false} value={draft.pin_hours || 168} unit="hours"
            disabled={!draft.enabled} onToggle={(enabled) => setDraft({ ...draft, pin_verification_required: enabled })}
            onChange={(value) => setDraft({ ...draft, pin_hours: value })} />
        </div>

        <label className="ps-row">
          <input type="checkbox" checked={draft.force_relogin} onChange={(e) => setDraft({ ...draft, force_relogin: e.target.checked })} />
          <span><b>Sign out when the interval expires</b><small>Off keeps the session alive; the next sign-in still has to verify.</small></span>
        </label>

        <p className="ps-note">Engineers default to 72 hours; accountants and admins to 24; PIN sign-ins to 168 (weekly). Changing anything here asks you for an email code first.</p>
      </section>

      <section className="org-card">
        <span className="org-eyebrow">Reporting calendar</span>
        <h3>First day of the week</h3>
        <p className="ps-note">Sets the boundaries for “This week” in Timesheets and attendance summaries. It changes the view only; recorded clock times stay intact.</p>
        <label className="ps-field">
          <span>Week starts on</span>
          <select className="org-select" value={draft.week_start_day}
            onChange={(event) => setDraft({ ...draft, week_start_day: Number(event.target.value) })}>
            {REPORTING_WEEK_DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
        </label>
        <p className="ps-note">Saturday is the default. Use Save changes above to apply a different day.</p>
      </section>

      <section className="org-card">
        <span className="org-eyebrow"><ShieldCheck size={14} /> Time records</span>
        <h3>Approval for employee time changes</h3>
        <p className="ps-note">Both options are off by default. With approval off, changes take effect when saved and are flagged for a leader to review, revise, or reject. Turning an option on holds that kind of change until a manager approves it.</p>
        <label className="ps-row">
          <input type="checkbox" checked={draft.attendance_approval.add_hours_requires_approval}
            onChange={(event) => setDraft({ ...draft, attendance_approval: { ...draft.attendance_approval, add_hours_requires_approval: event.target.checked } })} />
          <span><b>Require approval before added hours count</b><small>Includes missed clock-in/out and missed breaks.</small></span>
        </label>
        <label className="ps-row">
          <input type="checkbox" checked={draft.attendance_approval.trim_hours_requires_approval}
            onChange={(event) => setDraft({ ...draft, attendance_approval: { ...draft.attendance_approval, trim_hours_requires_approval: event.target.checked } })} />
          <span><b>Require approval before a self-trim takes effect</b><small>Manager changes to a record remain direct and audited.</small></span>
        </label>
      </section>

      <section className="org-card">
        <span className="org-eyebrow"><UserCog size={14} /> New accounts</span>
        <h3>Signup</h3>

        <label className="ps-row">
          <input type="checkbox" checked={draft.self_signup_enabled} onChange={(e) => setDraft({ ...draft, self_signup_enabled: e.target.checked })} />
          <span><b>Allow self-signup</b><small>Off removes Create account from the sign-in screen.</small></span>
        </label>
        <label className="ps-row">
          <input type="checkbox" checked={draft.signup_requires_approval} onChange={(e) => setDraft({ ...draft, signup_requires_approval: e.target.checked })} />
          <span><b>Every new account needs approval</b><small>On holds even company-domain signups until an admin enables them.</small></span>
        </label>
        <label className="ps-row">
          <input type="checkbox" checked={draft.initial_verification_required} onChange={(e) => setDraft({ ...draft, initial_verification_required: e.target.checked })} />
          <span><b>Require email verification at signup</b><small>Off skips the code for new signups; periodic verification still applies.</small></span>
        </label>
      </section>

      <section className="org-card">
        <span className="org-eyebrow"><BellRing size={14} /> Notification settings</span>
        <h3>Attendance encouragement</h3>
        <p className="ps-note" style={{ marginTop: -4 }}>
          Company-managed reminders continue when the app is closed. Employees cannot turn this attendance category off; operating-system notification permission still has to be enabled on each device.
        </p>

        <label className="ps-row">
          <input type="checkbox" checked={draft.attendance_notifications.enabled}
            onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, enabled: e.target.checked } })} />
          <span><b>Use attendance encouragement</b><small>Server-side checks every 15 minutes. No live browser polling is added.</small></span>
        </label>

        <div className="ps-grid">
          <label className="ps-row">
            <input type="checkbox" checked={draft.attendance_notifications.push_enabled}
              disabled={!draft.attendance_notifications.enabled}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, push_enabled: e.target.checked } })} />
            <span><b><Smartphone size={14} /> Device push</b><small>Progress and clock reminders on subscribed phones and computers.</small></span>
          </label>
          <label className="ps-row">
            <input type="checkbox" checked={draft.attendance_notifications.email_enabled}
              disabled={!draft.attendance_notifications.enabled}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, email_enabled: e.target.checked } })} />
            <span><b><Mail size={14} /> Email</b><small>Missing clock-ins, nine-hour notes, and critical long shifts.</small></span>
          </label>
        </div>

        <div className="ps-grid">
          <label className="ps-field">
            <span>Progress note frequency</span>
            <select className="org-select" disabled={!draft.attendance_notifications.enabled}
              value={draft.attendance_notifications.milestone_interval_hours}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, milestone_interval_hours: Number(e.target.value) } })}>
              <option value={1}>Every hour</option>
              <option value={2}>Every 2 hours</option>
              <option value={3}>Every 3 hours</option>
              <option value={4}>Every 4 hours</option>
            </select>
          </label>
          <label className="ps-field">
            <span>Progress notes through</span>
            <span className="ps-inline"><input type="number" min={1} max={16}
              disabled={!draft.attendance_notifications.enabled}
              value={draft.attendance_notifications.milestone_max_hours}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, milestone_max_hours: Math.max(1, Math.min(16, Number(e.target.value) || 9)) } })} /><small>hours</small></span>
          </label>
        </div>

        <label className="ps-row">
          <input type="checkbox" checked={draft.attendance_notifications.email_hourly}
            disabled={!draft.attendance_notifications.enabled || !draft.attendance_notifications.email_enabled}
            onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, email_hourly: e.target.checked } })} />
          <span><b>Email every progress milestone</b><small>Off keeps hourly encouragement as push and bell only; email is reserved for important moments.</small></span>
        </label>

        <label className="ps-row">
          <input type="checkbox" checked={draft.attendance_notifications.missing_clock_in}
            disabled={!draft.attendance_notifications.enabled}
            onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, missing_clock_in: e.target.checked } })} />
          <span><b>Gently notice a missing clock-in</b><small>Uses the saved schedule first, then a repeated personal weekday pattern. It does not assume Friday or Saturday is off.</small></span>
        </label>

        <div className="ps-grid">
          <label className="ps-field">
            <span>Grace after expected start</span>
            <span className="ps-inline"><input type="number" min={15} max={360} step={15}
              disabled={!draft.attendance_notifications.enabled || !draft.attendance_notifications.missing_clock_in}
              value={draft.attendance_notifications.missing_grace_minutes}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, missing_grace_minutes: Math.max(15, Math.min(360, Number(e.target.value) || 90)) } })} /><small>minutes</small></span>
          </label>
          <label className="ps-field">
            <span>Learn behavior from</span>
            <select className="org-select" disabled={!draft.attendance_notifications.enabled || !draft.attendance_notifications.use_work_pattern}
              value={draft.attendance_notifications.pattern_lookback_days}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, pattern_lookback_days: Number(e.target.value) } })}>
              <option value={28}>Last 4 weeks</option>
              <option value={42}>Last 6 weeks</option>
              <option value={56}>Last 8 weeks</option>
              <option value={84}>Last 12 weeks</option>
            </select>
          </label>
        </div>

        <div className="ps-grid">
          <label className="ps-row">
            <input type="checkbox" checked={draft.attendance_notifications.use_schedule}
              disabled={!draft.attendance_notifications.enabled || !draft.attendance_notifications.missing_clock_in}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, use_schedule: e.target.checked } })} />
            <span><b>Use saved schedules</b><small>A saved shift is the strongest signal.</small></span>
          </label>
          <label className="ps-row">
            <input type="checkbox" checked={draft.attendance_notifications.use_work_pattern}
              disabled={!draft.attendance_notifications.enabled || !draft.attendance_notifications.missing_clock_in}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, use_work_pattern: e.target.checked } })} />
            <span><b>Use repeated work patterns</b><small>Only after the same weekday has been worked at least twice.</small></span>
          </label>
        </div>

        <div className="ps-grid">
          <label className="ps-field">
            <span>Send only from</span>
            <select className="org-select" value={draft.attendance_notifications.active_from_hour}
              disabled={!draft.attendance_notifications.enabled}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, active_from_hour: Number(e.target.value) } })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00 local</option>)}
            </select>
          </label>
          <label className="ps-field">
            <span>Stop sending at</span>
            <select className="org-select" value={draft.attendance_notifications.active_to_hour}
              disabled={!draft.attendance_notifications.enabled}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, active_to_hour: Number(e.target.value) } })}>
              {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{String(h % 24).padStart(2, "0")}:00 local</option>)}
            </select>
          </label>
        </div>

        <div className="ps-grid">
          <label className="ps-field">
            <span>Critical open shift</span>
            <span className="ps-inline"><input type="number" min={9} max={24}
              disabled={!draft.attendance_notifications.enabled}
              value={draft.attendance_notifications.critical_shift_hours}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, critical_shift_hours: Math.max(9, Math.min(24, Number(e.target.value) || 12)) } })} /><small>hours</small></span>
          </label>
          <label className="ps-row">
            <input type="checkbox" checked={draft.attendance_notifications.notify_manager_on_critical}
              disabled={!draft.attendance_notifications.enabled}
              onChange={(e) => setDraft({ ...draft, attendance_notifications: { ...draft.attendance_notifications, notify_manager_on_critical: e.target.checked } })} />
            <span><b>Ask the direct manager to review</b><small>Only for a critical open shift, not ordinary progress.</small></span>
          </label>
        </div>

        <p className="ps-note">Example: “You have been clocked in for two hours. Nice progress.” At nine hours: “Great work—if you are finished, remember to clock out.” All timing uses the employee&apos;s notification timezone.</p>
      </section>

      </fieldset>

      <section className="org-card">
        <span className="org-eyebrow"><KeyRound size={14} /> Exemptions</span>
        <h3>Accounts excused from verification</h3>
        {exemptions.length === 0 ? <p className="org-none">None.</p> : (
          <ul className="org-people">
            {exemptions.map((row) => (
              <li key={row.user_id}>
                <span><b>{nameOf(row.user_id)}</b><small>{row.exempt_reason || "No reason recorded"} - by {row.exempt_set_by || "unknown"}</small></span>
                <button type="button" className="btn small" disabled={busy} onClick={() => begin({ kind: "exempt", userId: row.user_id, exempt: false })}>Re-enable</button>
              </li>
            ))}
          </ul>
        )}
        <div className="ps-inline" style={{ marginTop: 10 }}>
          <select className="org-select" value={exemptTarget} onChange={(e) => setExemptTarget(e.target.value)}>
            <option value="">Exempt an account...</option>
            {users.filter((row) => row.enabled !== false && !exemptions.some((x) => x.user_id === row.id)).map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </select>
          {exemptTarget ? (
            <button type="button" className="btn small" disabled={busy} onClick={() => { begin({ kind: "exempt", userId: exemptTarget, exempt: true }); setExemptTarget(""); }}>Exempt</button>
          ) : null}
        </div>
      </section>

      <section className="org-card">
        <span className="org-eyebrow"><ShieldCheck size={14} /> Platform owners</span>
        <h3>Who can change these settings</h3>
        <ul className="org-people">
          {admins.map((row) => (
            <li key={row.email}>
              <span><b>{row.email}</b><small>added by {row.added_by || "setup"}</small></span>
              {admins.length > 1 ? (
                <button type="button" className="btn small" disabled={busy} onClick={() => begin({ kind: "revoke", email: row.email })}>Remove</button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="ps-inline" style={{ marginTop: 10 }}>
          <input className="ps-input" type="email" placeholder="email@larsaeng.com" value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)} />
          {grantTarget.includes("@") ? (
            <button type="button" className="btn small" disabled={busy} onClick={() => { begin({ kind: "grant", email: grantTarget.trim().toLowerCase() }); setGrantTarget(""); }}>Add owner</button>
          ) : null}
        </div>
        <p className="ps-note">Platform ownership is separate from company roles. An operational admin cannot grant it; only an existing owner can, and only with an email code.</p>
      </section>

      <section className="org-card">
        <span className="org-eyebrow"><Database size={14} /> Backups &amp; history</span>
        <h3>Automatic backups</h3>
        {backupDraft ? (
          <>
            <label className="ps-row">
              <input type="checkbox" checked={backupDraft.enabled} onChange={(e) => setBackupDraft({ ...backupDraft, enabled: e.target.checked })} />
              <span><b>Keep automatic backups</b><small>A full snapshot of the whole platform on a schedule, kept for download and history.</small></span>
            </label>
            <div className="ps-grid">
              <label className="ps-field">
                <span>How often</span>
                <select className="org-select" value={backupDraft.interval_hours} onChange={(e) => setBackupDraft({ ...backupDraft, interval_hours: Number(e.target.value) })}>
                  <option value={12}>Every 12 hours</option>
                  <option value={24}>Every day</option>
                  <option value={168}>Every week</option>
                </select>
              </label>
              <label className="ps-field">
                <span>Keep backups for</span>
                <span className="ps-inline">
                  <input type="number" min={1} max={3650} value={backupDraft.retain_days} onChange={(e) => setBackupDraft({ ...backupDraft, retain_days: Number(e.target.value) || 365 })} />
                  <small>days</small>
                </span>
              </label>
            </div>
            <div className="ps-field" style={{ marginTop: 6 }}>
              <span>Email a copy to</span>
              {backupDraft.emails.length ? (
                <ul className="org-people">
                  {backupDraft.emails.map((addr) => (
                    <li key={addr}>
                      <span><b>{addr}</b></span>
                      <button type="button" className="btn small" onClick={() => setBackupDraft({ ...backupDraft, emails: backupDraft.emails.filter((x) => x !== addr) })}>Remove</button>
                    </li>
                  ))}
                </ul>
              ) : <p className="org-none">No addresses yet.</p>}
              <div className="ps-inline" style={{ marginTop: 8 }}>
                <input className="ps-input" type="email" placeholder="email@larsaeng.com" value={backupEmail} onChange={(e) => setBackupEmail(e.target.value)} />
                {backupEmail.includes("@") ? (
                  <button type="button" className="btn small" onClick={() => { const a = backupEmail.trim().toLowerCase(); if (a && !backupDraft.emails.includes(a)) setBackupDraft({ ...backupDraft, emails: [...backupDraft.emails, a] }); setBackupEmail(""); }}>Add</button>
                ) : null}
              </div>
            </div>
            <div className="ps-actions">
              <button type="button" className="org-add" disabled={!backupDirty || backupBusy} onClick={saveBackupSettings}><Save size={15} /> Save backup settings</button>
              <span className="ps-note" role="status">{backupDirty ? "Unsaved backup changes" : "Backup settings saved"}</span>
              <button type="button" className="btn small" disabled={backupBusy} onClick={runManualBackup}>Back up now</button>
            </div>
            <p className="ps-note">Backups capture the whole platform — staff, accounting, payroll, projects and settings. Password and PIN hashes are removed from any downloaded copy.</p>
          </>
        ) : backupLoading ? <p className="org-none">Loading backup settings...</p> : (
          <div className="ps-actions" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
            <p className="org-none">{backupError || "Backup settings are not available right now."}</p>
            <button type="button" className="btn small" onClick={() => loadBackups()}>Try again</button>
          </div>
        )}

        <h3 style={{ marginTop: 18 }}>Snapshots</h3>
        {backups.length === 0 ? (
          <p className="org-none">No backups yet. One will appear on the next scheduled run, or press &quot;Back up now&quot;.</p>
        ) : (
          <ul className="org-people">
            {backups.slice(0, 60).map((b) => (
              <li key={b.id}>
                <span>
                  <b>{new Date(b.created_at).toLocaleString()}</b>
                  <small>{b.kind === "manual" ? "manual" : "scheduled"} · {Math.max(1, Math.round(b.byte_size / 1024))} KB · {Object.values(b.table_counts || {}).reduce((sum, c) => sum + Number(c || 0), 0)} records</small>
                </span>
                <span className="pit-actions">
                  <button type="button" className="btn small" disabled={backupBusy || pitBusy} onClick={() => openPointInTime(b)}><Database size={13} /> View</button>
                  <button type="button" className="btn small" disabled={backupBusy} onClick={() => downloadBackup(b)}><DownloadCloud size={13} /> Download</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {backupMsg ? <p className="ps-note">{backupMsg}</p> : null}
      </section>

      <section className="org-card">
        <span className="org-eyebrow">Audit</span>
        <h3>Recent security changes</h3>
        {auditRows.length === 0 ? <p className="org-none">Nothing yet.</p> : (
          <ul className="org-people">
            {auditRows.slice(0, 12).map((row, index) => (
              <li key={index}>
                <span>
                  <b>{row.action}</b>
                  <small>{[row.target ? nameOf(row.target) : null, row.actor, new Date(row.at).toLocaleString()].filter(Boolean).join(" - ")}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pitRow ? (
        <PointInTimeModal
          row={pitRow}
          data={pitData}
          busy={pitBusy}
          onClose={closePointInTime}
          onDownload={() => pitRow && downloadBackup(pitRow)}
        />
      ) : null}
    </div>
  );
}
