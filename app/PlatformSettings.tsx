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

import { useEffect, useMemo, useState } from "react";
import { KeyRound, ShieldCheck, UserCog } from "lucide-react";
import { getSupabaseClient, supabaseConfigured } from "../lib/supabase/client";

type Policy = {
  enabled: boolean;
  engineer_hours: number | null;
  privileged_hours: number | null;
  force_relogin: boolean;
  self_signup_enabled: boolean;
  signup_requires_approval: boolean;
  initial_verification_required: boolean;
};

type AuditRow = { at: string; actor: string | null; action: string; target: string | null };
type AdminRow = { email: string; added_by: string | null; added_at: string };
type ExemptionRow = { user_id: string; exempt_reason: string | null; exempt_set_by: string | null };

type Person = { id: string; name: string; email?: string; enabled?: boolean };

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

export function PlatformSettings({ viewer, users }: { viewer: Person | null; users: Person[] }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
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

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((row) => map.set(row.id, row.name));
    return (id: string) => map.get(id) || id;
  }, [users]);

  async function refresh() {
    const p = await call({ op: "policy" });
    if (p && p.ok) {
      setPolicy(p.policy as Policy);
      setDraft(p.policy as Policy);
    }
    const a = await call({ op: "platformAdmins" });
    if (a && a.ok) setAdmins((a.rows as AdminRow[]) || []);
    const e = await call({ op: "exemptions" });
    if (e && e.ok) setExemptions((e.rows as ExemptionRow[]) || []);
    const l = await call({ op: "audit" });
    if (l && l.ok) setAuditRows((l.rows as AuditRow[]) || []);
  }

  useEffect(() => { refresh(); }, []);

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
      refresh();
    } else {
      setMessage(String((result && result.error) || "That code was not accepted."));
    }
  }

  if (!policy || !draft) {
    return <div className="platform-settings"><p className="org-none">Loading platform settings...</p></div>;
  }

  const dirty = JSON.stringify(policy) !== JSON.stringify(draft);

  return (
    <div className="platform-settings">
      <section className="org-card">
        <span className="org-eyebrow"><ShieldCheck size={14} /> Sign-in security</span>
        <h3>Periodic email verification</h3>

        <label className="ps-row">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          <span><b>Require periodic verification</b><small>Off means nobody is ever asked after sign-in.</small></span>
        </label>

        <div className="ps-grid">
          <label className="ps-field">
            <span>Engineers</span>
            <span className="ps-inline">
              <input type="number" min={1} max={8760} disabled={draft.engineer_hours === null}
                value={draft.engineer_hours ?? 72}
                onChange={(e) => setDraft({ ...draft, engineer_hours: Number(e.target.value) || 72 })} />
              <small>hours</small>
              <label className="ps-mini"><input type="checkbox" checked={draft.engineer_hours === null}
                onChange={(e) => setDraft({ ...draft, engineer_hours: e.target.checked ? null : 72 })} /> off</label>
            </span>
          </label>
          <label className="ps-field">
            <span>Accountants &amp; admins</span>
            <span className="ps-inline">
              <input type="number" min={1} max={8760} disabled={draft.privileged_hours === null}
                value={draft.privileged_hours ?? 24}
                onChange={(e) => setDraft({ ...draft, privileged_hours: Number(e.target.value) || 24 })} />
              <small>hours</small>
              <label className="ps-mini"><input type="checkbox" checked={draft.privileged_hours === null}
                onChange={(e) => setDraft({ ...draft, privileged_hours: e.target.checked ? null : 24 })} /> off</label>
            </span>
          </label>
        </div>

        <label className="ps-row">
          <input type="checkbox" checked={draft.force_relogin} onChange={(e) => setDraft({ ...draft, force_relogin: e.target.checked })} />
          <span><b>Sign out when the interval expires</b><small>Off keeps the session alive; the next sign-in still has to verify.</small></span>
        </label>

        <p className="ps-note">Engineers default to 72 hours; accountants and admins to 24. Changing anything here asks you for an email code first.</p>
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

      {dirty ? (
        <div className="ps-actions">
          <button type="button" className="org-add" disabled={busy} onClick={() => begin({ kind: "save" })}>Save changes</button>
          <button type="button" className="btn small" disabled={busy} onClick={() => { setDraft(policy); setMessage(""); }}>Discard</button>
        </div>
      ) : null}

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

      {message ? <p className="org-note">{message}</p> : null}

      {pending ? (
        <div className="ps-confirm">
          <input
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
  );
}
