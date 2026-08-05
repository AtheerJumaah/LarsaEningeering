// The platform's security policy, its owners, the per-person exemptions, and
// the record of when each person last passed a verification.
//
// Two administrations live in this app and this function keeps them apart.
// Operational admins run the company: staff, teams, attendance, approvals.
// Platform admins own the SOFTWARE: signup rules, verification intervals,
// exemptions, and who else is a platform admin. Operational access lives on
// staff records in a blob every client can write; platform ownership lives in
// a service-role-only table precisely so it cannot be self-granted by editing
// local data.
//
// Every change of platform state requires two things, checked HERE and not in
// the interface: the actor's email must already be in platform_admins, and
// the actor must present a fresh emailed code. Identity in this app is proven
// by mailbox control, so the code requirement is what turns "only a platform
// admin can do this" from a hidden button into an enforced rule.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}

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
};

const FALLBACK: Policy = {
  enabled: true,
  engineer_hours: 72,
  privileged_hours: 24,
  force_relogin: true,
  self_signup_enabled: true,
  signup_requires_approval: false,
  initial_verification_required: true,
  pin_verification_required: true,
  pin_hours: 168,
};

async function readPolicy(): Promise<Policy> {
  const { data } = await db
    .from("auth_policy")
    .select("enabled, engineer_hours, privileged_hours, force_relogin, self_signup_enabled, signup_requires_approval, initial_verification_required, pin_verification_required, pin_hours")
    .eq("id", 1)
    .maybeSingle();
  return (data as Policy) || FALLBACK;
}

function normEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

async function isPlatformAdmin(email: string): Promise<boolean> {
  if (!email) return false;
  const { data } = await db.from("platform_admins").select("email").eq("email", email).maybeSingle();
  return Boolean(data);
}

/* Accountant, operational admin and platform owner are held to the shorter
   interval; everyone else follows the engineer one. Matching on the text of
   both fields means a new title like "Finance Admin" lands on the strict side
   by default, which is the safer way to be wrong. */
function isPrivileged(access: string, role: string): boolean {
  const text = (access + " " + role).toLowerCase();
  return text.includes("admin") || text.includes("account") || text.includes("finance");
}

async function audit(actor: string, action: string, target: string, detail: Record<string, unknown>) {
  try {
    await db.from("auth_policy_audit").insert({ actor, action, target, detail });
  } catch {
    // The change still happened; losing the note must not undo it.
  }
}

/* Step-up: consumes a code the actor just received by email, through the same
   auth-code function every other verification uses. */
async function provedByEmail(email: string, code: string): Promise<boolean> {
  if (!email || !code) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/auth-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "verify", email, purpose: "verify", code }),
    });
    const body = await res.json();
    return Boolean(body && body.ok);
  } catch {
    return false;
  }
}

/* Both requirements for touching platform state, in one place. */
async function platformStepUp(payload: Record<string, unknown>): Promise<string | null> {
  const actor = normEmail(payload.actorEmail);
  if (!(await isPlatformAdmin(actor))) return null;
  if (!(await provedByEmail(actor, String(payload.code || "")))) return null;
  return actor;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request." });
  }

  const op = String(payload.op || "");

  if (op === "policy") {
    return json({ ok: true, policy: await readPolicy() });
  }

  /* Lets the app decide whether to show the Platform Settings area at all.
     Showing is cosmetic; every change is still checked server-side. */
  if (op === "amPlatformAdmin") {
    return json({ ok: true, admin: await isPlatformAdmin(normEmail(payload.email)) });
  }

  if (op === "status") {
    const userId = String(payload.userId || "");
    const access = String(payload.access || "");
    const role = String(payload.role || "");
    if (!userId) return json({ ok: false, error: "Unknown account." });

    const policy = await readPolicy();

    const { data } = await db
      .from("user_verification")
      .select("last_periodic_email_verified_at, verification_exempt")
      .eq("user_id", userId)
      .maybeSingle();

    if (data && data.verification_exempt) {
      return json({ ok: true, required: false, exempt: true, policy, hours: null });
    }

    const hours = !policy.enabled ? null : (isPrivileged(access, role) ? policy.privileged_hours : policy.engineer_hours);
    if (!hours) return json({ ok: true, required: false, policy, hours: null });

    const stamp = data && data.last_periodic_email_verified_at
      ? new Date(data.last_periodic_email_verified_at as string).getTime()
      : 0;

    /* Never verified counts as due, not as exempt. */
    const ageHours = stamp ? (Date.now() - stamp) / 3600000 : Number.POSITIVE_INFINITY;
    const required = ageHours >= hours;

    return json({
      ok: true,
      required,
      exempt: false,
      policy,
      hours,
      expiresInHours: required ? 0 : Math.max(0, hours - ageHours),
      lastVerifiedAt: stamp ? new Date(stamp).toISOString() : null,
    });
  }

  /* Called by auth-code once a code is genuinely accepted. Not reachable from
     a browser. */
  if (op === "stamp") {
    if (String(payload.secret || "") !== SERVICE_ROLE_KEY) return json({ ok: false, error: "Not permitted." });
    const userId = String(payload.userId || "");
    if (!userId) return json({ ok: false, error: "Unknown account." });

    const { error } = await db.from("user_verification").upsert(
      {
        user_id: userId,
        last_periodic_email_verified_at: new Date().toISOString(),
        initial_verification_skipped: Boolean(payload.initialSkipped),
        approved_by: payload.approvedBy ? String(payload.approvedBy) : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) return json({ ok: false, error: "Could not record the verification." });
    return json({ ok: true });
  }

  /* ---- Everything below changes platform state: platform admin + code. ---- */

  if (op === "save") {
    const actor = await platformStepUp(payload);
    if (!actor) return json({ ok: false, error: "That code was not accepted. The policy has not been changed." });

    const before = await readPolicy();
    const policy = (payload.policy || {}) as Partial<Policy>;
    const next: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString(), updated_by: actor };
    if (typeof policy.enabled === "boolean") next.enabled = policy.enabled;
    if (typeof policy.force_relogin === "boolean") next.force_relogin = policy.force_relogin;
    if (typeof policy.self_signup_enabled === "boolean") next.self_signup_enabled = policy.self_signup_enabled;
    if (typeof policy.signup_requires_approval === "boolean") next.signup_requires_approval = policy.signup_requires_approval;
    if (typeof policy.initial_verification_required === "boolean") next.initial_verification_required = policy.initial_verification_required;
    next.engineer_hours = policy.engineer_hours === null ? null : Number(policy.engineer_hours) || 72;
    next.privileged_hours = policy.privileged_hours === null ? null : Number(policy.privileged_hours) || 24;
    if (typeof policy.pin_verification_required === "boolean") next.pin_verification_required = policy.pin_verification_required;
    if (policy.pin_hours !== undefined) next.pin_hours = Math.max(1, Number(policy.pin_hours) || 168);

    const { error } = await db.from("auth_policy").upsert(next, { onConflict: "id" });
    if (error) return json({ ok: false, error: "Could not save the policy." });

    const after = await readPolicy();
    await audit(actor, "policy.update", "global", { before, after });
    return json({ ok: true, policy: after });
  }

  if (op === "exempt") {
    const actor = await platformStepUp(payload);
    if (!actor) return json({ ok: false, error: "That code was not accepted. Nothing has been changed." });

    const userId = String(payload.userId || "");
    if (!userId) return json({ ok: false, error: "Unknown account." });
    const exempt = Boolean(payload.exempt);
    const reason = payload.reason ? String(payload.reason) : null;

    const { error } = await db.from("user_verification").upsert(
      {
        user_id: userId,
        verification_exempt: exempt,
        exempt_reason: exempt ? reason : null,
        exempt_set_by: exempt ? actor : null,
        exempt_set_at: exempt ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) return json({ ok: false, error: "Could not change that account." });

    await audit(actor, exempt ? "verification.disable" : "verification.enable", userId, { reason });
    return json({ ok: true, exempt });
  }

  /* A new account approved by hand: the platform admin vouches for the address
     instead of the owner proving it, so the periodic clock starts now and the
     decision is logged with a name on it. */
  if (op === "approveUser") {
    const actor = await platformStepUp(payload);
    if (!actor) return json({ ok: false, error: "That code was not accepted. The account was not approved." });

    const userId = String(payload.userId || "");
    if (!userId) return json({ ok: false, error: "Unknown account." });

    const { error } = await db.from("user_verification").upsert(
      {
        user_id: userId,
        last_periodic_email_verified_at: new Date().toISOString(),
        initial_verification_skipped: true,
        approved_by: actor,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) return json({ ok: false, error: "Could not approve the account." });

    await audit(actor, "user.approve_without_initial_verification", userId, {
      role: payload.role ? String(payload.role) : null,
      email: normEmail(payload.userEmail) || null,
    });
    return json({ ok: true });
  }

  if (op === "grantPlatform" || op === "revokePlatform") {
    const actor = await platformStepUp(payload);
    if (!actor) return json({ ok: false, error: "That code was not accepted. Nothing has been changed." });

    const target = normEmail(payload.targetEmail);
    if (!target) return json({ ok: false, error: "A target email is required." });

    if (op === "revokePlatform") {
      /* The last owner cannot remove themselves: a platform nobody can
         administer is not safer, it is abandoned. */
      const { count } = await db.from("platform_admins").select("email", { count: "exact", head: true });
      if ((count || 0) <= 1 && target === actor) {
        return json({ ok: false, error: "You are the only platform admin. Add another before removing yourself." });
      }
      const { error } = await db.from("platform_admins").delete().eq("email", target);
      if (error) return json({ ok: false, error: "Could not remove that admin." });
      await audit(actor, "platform.revoke", target, {});
      return json({ ok: true });
    }

    const { error } = await db.from("platform_admins").upsert({ email: target, added_by: actor }, { onConflict: "email" });
    if (error) return json({ ok: false, error: "Could not add that admin." });
    await audit(actor, "platform.grant", target, {});
    return json({ ok: true });
  }

  /* The three reads below are the platform owners' own view -- who the
     admins are, who is exempt, and the policy audit trail. They used to be
     open to any caller holding the anon key. They now require the asserted
     actor to be a platform admin. Within this app's self-asserted trust
     model that is a bar, not a wall -- the write ops keep their emailed-code
     step-up, which is the real lock -- but "anyone" and "someone naming an
     admin" are different audiences for an audit trail. */
  if (op === "platformAdmins") {
    if (!(await isPlatformAdmin(normEmail(payload.actorEmail)))) return json({ ok: false, error: "Not authorized." });
    const { data } = await db.from("platform_admins").select("email, added_by, added_at").order("added_at");
    return json({ ok: true, rows: data || [] });
  }

  if (op === "exemptions") {
    if (!(await isPlatformAdmin(normEmail(payload.actorEmail)))) return json({ ok: false, error: "Not authorized." });
    const { data } = await db
      .from("user_verification")
      .select("user_id, verification_exempt, exempt_reason, exempt_set_by, exempt_set_at")
      .eq("verification_exempt", true);
    return json({ ok: true, rows: data || [] });
  }

  if (op === "audit") {
    if (!(await isPlatformAdmin(normEmail(payload.actorEmail)))) return json({ ok: false, error: "Not authorized." });
    const { data } = await db
      .from("auth_policy_audit")
      .select("at, actor, action, target, detail")
      .order("at", { ascending: false })
      .limit(50);
    return json({ ok: true, rows: data || [] });
  }

  return json({ ok: false, error: "Unknown operation." });
});
