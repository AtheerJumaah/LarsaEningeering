// Creates, updates, and removes Viewer accounts — the client/read-only
// role a Larsa Admin sets up for someone outside the company (usually a
// client) to see their own project's progress and numbers.
//
// Why this is its own function instead of another acct_*/pay_* RPC:
// every one of those RPCs accepts a client-supplied {email, role} actor
// and trusts it at face value (see acct_check_actor in
// 20260801_acct_002_engine_functions.sql) — a deliberate, pre-existing,
// whole-app trade-off that this change does not touch for employees.
// Viewer accounts are different on purpose: each one gets a REAL
// Supabase Auth identity (auth.uid()), created here with the service
// role, so the restrictive RLS policies added in
// 20260803_acct_016_viewer_accounts.sql can genuinely enforce project
// scope in Postgres — not just hide things in the browser. A Viewer's
// login email is synthetic (`<username>@viewer.larsaeng.internal`, a
// domain nobody can receive mail at) purely so Supabase Auth's own
// battle-tested email+password mechanism can be reused for a
// username-only login; it is never shown to anyone and no mail is ever
// sent to it.
//
// Who may call this: the actor's asserted role must be one of the roles
// that already carry the "Users & Access" permission in the app today
// (Super Admin, Admin, Admin HR — see presetPermissionProfile in
// app/page.tsx). That is the same self-asserted-role trust boundary the
// rest of the app already uses for "which employee can do this
// employee-management action" — a real, separate question from "can a
// Viewer escape their assigned projects," which is what the RLS layer
// genuinely enforces regardless of what this function is told.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const VIEWER_DOMAIN = "viewer.larsaeng.internal";
const WRITE_ROLES = ["Super Admin", "Admin", "Admin HR"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}

function normUsername(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function usernameProblem(username: string): string | null {
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return "Username must be 3-32 characters: lowercase letters, numbers, dot, underscore, or hyphen only.";
  }
  return null;
}

function passwordProblem(password: string, confirm: string): string | null {
  if (String(password || "").length < 8) return "Password must be at least 8 characters.";
  if (password !== confirm) return "Password and confirmation do not match.";
  return null;
}

function syntheticEmail(username: string): string {
  return `${username}@${VIEWER_DOMAIN}`;
}

/* Same trust boundary as acct_check_actor: a valid-looking email plus a
   role string on the allowed list. This governs "which employee may
   manage Viewer accounts," not "what can a Viewer see" — that second
   question is enforced by RLS regardless of anything checked here. */
function checkActor(actor: unknown): { email: string } | { error: string } {
  const a = (actor || {}) as Record<string, unknown>;
  const email = String(a.email || "").trim().toLowerCase();
  const role = String(a.access || a.role || "");
  if (!email || !email.includes("@")) return { error: "A valid actor email is required." };
  if (!WRITE_ROLES.includes(role)) return { error: `Role "${role}" cannot manage Viewer accounts.` };
  return { email };
}

async function audit(actorEmail: string, actorRole: string, action: string, targetId: string, targetLabel: string, details: Record<string, unknown> = {}) {
  try {
    await db.from("account_lifecycle_audit").insert({
      actor_email: actorEmail, actor_role: actorRole, action,
      target_type: "viewer_account", target_id: targetId, target_label: targetLabel, details,
    });
  } catch {
    // The change still happened; losing the note must not undo it.
  }
}

/* Drops any project id that doesn't exist in acct_projects rather than
   silently granting scope to a typo. Returns the filtered list plus
   whatever was dropped, so the caller can surface a warning. */
async function sanitizeProjectIds(ids: unknown): Promise<{ ok: string[]; dropped: string[] }> {
  const raw = Array.isArray(ids) ? [...new Set(ids.map((v) => String(v || "").trim()).filter(Boolean))] : [];
  if (!raw.length) return { ok: [], dropped: [] };
  const { data } = await db.from("acct_projects").select("id").in("id", raw);
  const known = new Set((data || []).map((r: { id: string }) => r.id));
  return { ok: raw.filter((id) => known.has(id)), dropped: raw.filter((id) => !known.has(id)) };
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
  const actorCheck = checkActor(payload.actor);
  if ("error" in actorCheck) return json({ ok: false, error: actorCheck.error });
  const actorEmail = actorCheck.email;
  const actorRole = String((payload.actor as Record<string, unknown> | undefined)?.access || (payload.actor as Record<string, unknown> | undefined)?.role || "");

  if (op === "create") {
    const username = normUsername(payload.username);
    const displayName = String(payload.displayName || "").trim();
    const password = String(payload.password || "");
    const confirmPassword = String(payload.confirmPassword || "");
    const projectAccessMode = ["all", "assigned", "none"].includes(String(payload.projectAccessMode))
      ? String(payload.projectAccessMode) : "assigned";
    const expiresAt = payload.expiresAt ? String(payload.expiresAt) : null;

    if (!displayName) return json({ ok: false, error: "Enter a client/display name." });
    const unameProblem = usernameProblem(username);
    if (unameProblem) return json({ ok: false, error: unameProblem });
    const pwProblem = passwordProblem(password, confirmPassword);
    if (pwProblem) return json({ ok: false, error: pwProblem });

    const { data: existing } = await db.from("viewer_accounts").select("id").ilike("username", username).maybeSingle();
    if (existing) return json({ ok: false, error: "That username is already taken." });

    const { ok: allowedProjectIds, dropped } = await sanitizeProjectIds(payload.allowedProjectIds);

    const { data: created, error: createError } = await db.auth.admin.createUser({
      email: syntheticEmail(username),
      password,
      email_confirm: true,
      user_metadata: { larsa_viewer: true, username },
    });
    if (createError || !created?.user) {
      return json({ ok: false, error: "Could not create the Viewer's sign-in (username may already be in use)." });
    }

    const { data: row, error: insertError } = await db.from("viewer_accounts").insert({
      auth_user_id: created.user.id,
      username,
      display_name: displayName,
      project_access_mode: projectAccessMode,
      allowed_project_ids: allowedProjectIds,
      enabled: payload.enabled !== false,
      expires_at: expiresAt,
      created_by: actorEmail,
      updated_by: actorEmail,
    }).select().single();
    if (insertError) {
      // Don't leave an orphaned auth user behind if the profile row failed.
      await db.auth.admin.deleteUser(created.user.id).catch(() => {});
      return json({ ok: false, error: "Could not save the Viewer account. Nothing was created." });
    }

    await audit(actorEmail, actorRole, "viewer.created", row.id, displayName, { username, projectAccessMode, allowedProjectIds });
    return json({ ok: true, viewer: row, droppedProjectIds: dropped });
  }

  if (op === "update") {
    const id = String(payload.id || "");
    if (!id) return json({ ok: false, error: "Unknown Viewer account." });
    const { data: existing } = await db.from("viewer_accounts").select("*").eq("id", id).maybeSingle();
    if (!existing) return json({ ok: false, error: "That Viewer account could not be found." });

    const changes: Record<string, unknown> = { updated_by: actorEmail, updated_at: new Date().toISOString() };
    const details: Record<string, unknown> = {};

    if (typeof payload.displayName === "string" && payload.displayName.trim()) {
      changes.display_name = payload.displayName.trim();
    }
    if (payload.projectAccessMode && ["all", "assigned", "none"].includes(String(payload.projectAccessMode))) {
      changes.project_access_mode = String(payload.projectAccessMode);
      details.projectAccessMode = changes.project_access_mode;
    }
    let droppedProjectIds: string[] = [];
    if (payload.allowedProjectIds !== undefined) {
      const sanitized = await sanitizeProjectIds(payload.allowedProjectIds);
      changes.allowed_project_ids = sanitized.ok;
      droppedProjectIds = sanitized.dropped;
      details.allowedProjectIds = sanitized.ok;
    }
    if (typeof payload.enabled === "boolean") {
      changes.enabled = payload.enabled;
      details.enabled = payload.enabled;
    }
    if (payload.expiresAt !== undefined) {
      changes.expires_at = payload.expiresAt ? String(payload.expiresAt) : null;
      details.expiresAt = changes.expires_at;
    }

    let newUsername: string | null = null;
    if (typeof payload.username === "string" && normUsername(payload.username) !== existing.username) {
      newUsername = normUsername(payload.username);
      const unameProblem = usernameProblem(newUsername);
      if (unameProblem) return json({ ok: false, error: unameProblem });
      const { data: clash } = await db.from("viewer_accounts").select("id").ilike("username", newUsername).neq("id", id).maybeSingle();
      if (clash) return json({ ok: false, error: "That username is already taken." });
      const { error: emailError } = await db.auth.admin.updateUserById(existing.auth_user_id, { email: syntheticEmail(newUsername) });
      if (emailError) return json({ ok: false, error: "Could not change the username." });
      changes.username = newUsername;
      details.username = newUsername;
    }

    const { data: updated, error: updateError } = await db.from("viewer_accounts").update(changes).eq("id", id).select().single();
    if (updateError) return json({ ok: false, error: "Could not save those changes." });

    await audit(actorEmail, actorRole, "viewer.updated", id, updated.display_name, details);
    return json({ ok: true, viewer: updated, droppedProjectIds });
  }

  if (op === "resetPassword") {
    const id = String(payload.id || "");
    const password = String(payload.password || "");
    const confirmPassword = String(payload.confirmPassword || "");
    const pwProblem = passwordProblem(password, confirmPassword);
    if (pwProblem) return json({ ok: false, error: pwProblem });

    const { data: existing } = await db.from("viewer_accounts").select("id, auth_user_id, display_name").eq("id", id).maybeSingle();
    if (!existing) return json({ ok: false, error: "That Viewer account could not be found." });

    const { error } = await db.auth.admin.updateUserById(existing.auth_user_id, { password });
    if (error) return json({ ok: false, error: "Could not reset the password." });

    await db.from("viewer_accounts").update({ updated_by: actorEmail, updated_at: new Date().toISOString() }).eq("id", id);
    // Never log the password itself — only that a reset happened.
    await audit(actorEmail, actorRole, "viewer.password_reset", id, existing.display_name, {});
    return json({ ok: true });
  }

  if (op === "delete") {
    const id = String(payload.id || "");
    const { data: existing } = await db.from("viewer_accounts").select("id, auth_user_id, display_name, username").eq("id", id).maybeSingle();
    if (!existing) return json({ ok: false, error: "That Viewer account could not be found." });

    const { error } = await db.auth.admin.deleteUser(existing.auth_user_id);
    if (error) return json({ ok: false, error: "Could not delete the Viewer account." });
    // The FK is ON DELETE CASCADE, so the viewer_accounts row is already
    // gone the moment the auth user is removed.

    await audit(actorEmail, actorRole, "viewer.deleted", id, existing.display_name, { username: existing.username });
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown operation." });
});
