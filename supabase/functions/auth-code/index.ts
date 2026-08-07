// Generates, emails, and checks the 6-digit codes used for email
// verification, self-signup, and password reset across the app.
//
// Why this exists instead of Supabase Auth's built-in signInWithOtp: the
// default Supabase mailer caps out at a couple of emails an hour with no way
// to raise it short of wiring up a separate SMTP provider. This function
// sends through the same Microsoft Graph mailbox the rest of the app's
// notifications already use (via the send-mail function), so it isn't
// subject to that ceiling, and it works for people who don't have a
// Supabase Auth account at all -- this app's staff records are plain rows in
// the app_state JSON blob, not Supabase Auth users.
//
// Codes live in public.auth_codes, a service-role-only table (RLS enabled,
// no policies) -- nothing here is reachable except through this function,
// which enforces a 60s resend cooldown, a 10 minute expiry, and a 5-attempt
// cap per code.
//
// Every response is HTTP 200 with an {ok, error} body, including refusals.
// supabase-js's functions.invoke() turns a non-2xx into an opaque
// FunctionsHttpError whose message the caller can only reach by re-reading
// the response stream, so a failure would otherwise reach the user as
// "Edge Function returned a non-2xx status code" instead of the sentence
// written here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const RESEND_COOLDOWN_MS = 60_000;
const EXPIRY_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

// This is called from the browser (app/AccountAccess.tsx and the sign-in
// verification gate in app/page.tsx), so the preflight has to be answered and
// every response has to carry the CORS headers -- without them the browser
// discards the reply before the app ever sees it, and the user is told the
// email service is unreachable when in fact the mail was sent.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normEmail(email: string) {
  return String(email || "").trim().toLowerCase();
}

function genCode() {
  /* Math.random() is not a source of secrets: its state is recoverable from
     outputs, which for a six-digit code with five attempts is not academic.
     One uniform draw from the CSPRNG, rejection-sampled so every code in
     100000-999999 is equally likely. */
  const range = 900000;
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return String(100000 + (buf[0] % range));
}

function json(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
}

function emailHtml(purpose: string, code: string, name?: string) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const action = purpose === "reset" ? "reset your password" : "verify your email address";
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.5">
    <p>${greeting}</p>
    <p>Use this code to ${action} in Larsa Control:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:20px 0">${code}</p>
    <p style="color:#666">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
  </div>`;
}

async function sendCodeEmail(email: string, purpose: string, code: string, name?: string) {
  const subject = purpose === "reset" ? "Your Larsa Control password reset code" : "Your Larsa Control verification code";
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-mail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: email, subject, html: emailHtml(purpose, code, name) }),
  });
  if (!res.ok) throw new Error(`send-mail failed (${res.status})`);
}

/* Records that this person has just proved their mailbox. Done here rather
 * than in the browser on purpose: this is the only place that knows a code was
 * genuinely accepted, so it is the only place entitled to move the clock that
 * decides access. A client that could call it directly could grant itself
 * another 72 hours without ever opening an email.
 */
async function stampPeriodicVerification(userId: string, email: string) {
  if (!userId) return;
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/auth-policy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      /* The stamp carries the normalized email as well as the uid: the email
         is the permanent business identity, so a verification survives the
         account being recreated under a new uid — the exact failure that had
         people re-verifying on every sign-in during the incident. */
      body: JSON.stringify({ op: "stamp", userId, email, secret: SERVICE_ROLE_KEY }),
    });
  } catch {
    // The code was still valid, so let the sign-in through. The worst case is
    // being asked again sooner than necessary, which is the safe direction.
  }
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
  const email = normEmail(String(payload.email || ""));
  const purpose = String(payload.purpose || "");
  if (!email || !email.includes("@")) return json({ ok: false, error: "A valid email address is required." });
  if (purpose !== "verify" && purpose !== "reset") return json({ ok: false, error: "Unknown code purpose." });

  // Opportunistic cleanup of old rows so this table doesn't grow forever.
  // Best-effort only -- never block the actual request on this.
  db.from("auth_codes").delete().lt("expires_at", new Date(Date.now() - 86_400_000).toISOString()).then(() => {}, () => {});

  if (op === "send") {
    const { data: recent } = await db
      .from("auth_codes")
      .select("id, created_at")
      .eq("email", email)
      .eq("purpose", purpose)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent && Date.now() - new Date(recent.created_at as string).getTime() < RESEND_COOLDOWN_MS) {
      return json({ ok: false, error: "A code was just sent. Wait a minute before asking for another." });
    }

    const code = genCode();
    const expires_at = new Date(Date.now() + EXPIRY_MS).toISOString();
    const { error: insertError } = await db.from("auth_codes").insert({ email, purpose, code, expires_at });
    if (insertError) return json({ ok: false, error: "Could not create a code. Try again." });

    try {
      await sendCodeEmail(email, purpose, code, typeof payload.name === "string" ? payload.name : undefined);
    } catch {
      return json({ ok: false, error: "Could not send the email. Check the address and try again." });
    }
    return json({ ok: true });
  }

  if (op === "verify") {
    const code = String(payload.code || "").trim();
    if (!code) return json({ ok: false, error: "Enter the 6-digit code from your email." });

    const { data: row } = await db
      .from("auth_codes")
      .select("id, code, attempts, expires_at")
      .eq("email", email)
      .eq("purpose", purpose)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row || new Date(row.expires_at as string).getTime() < Date.now()) {
      return json({ ok: false, error: "That code has expired. Ask for a new one." });
    }
    if ((row.attempts as number) >= MAX_ATTEMPTS) {
      return json({ ok: false, error: "Too many wrong attempts. Ask for a new code." });
    }
    if (String(row.code) !== code) {
      await db.from("auth_codes").update({ attempts: (row.attempts as number) + 1 }).eq("id", row.id as string);
      return json({ ok: false, error: "That code was not accepted. Check it and try again." });
    }

    await db.from("auth_codes").update({ consumed_at: new Date().toISOString() }).eq("id", row.id as string);

    /* Only a verify-purpose code renews the periodic clock. A password reset
       proves the mailbox too, but treating it as a security check would let
       somebody stretch their interval by resetting their password instead of
       verifying, which is not the same act. */
    if (purpose === "verify" && payload.userId) {
      /* The code proved control of `email`. The stamp is a claim about a user
         id, and the two were previously never tied together -- anyone who
         could verify their OWN mailbox could renew the periodic clock of ANY
         user id they named. Bind them: the stamp only lands if the staff
         record for that id actually carries this email. The email
         verification itself still succeeds either way -- the mailbox really
         was proved; it is only the side-effect that must not cross accounts. */
      const { data: staffRow } = await db.from("app_state").select("data").eq("store_key", "larsaStaffV8").maybeSingle();
      const users = (staffRow?.data as { users?: { id?: string; email?: string }[] } | null)?.users;
      const owner = Array.isArray(users) ? users.find((u) => String(u?.id || "") === String(payload.userId)) : null;
      if (owner && normEmail(String(owner.email || "")) === email) {
        await stampPeriodicVerification(String(payload.userId), email);
      }
    }

    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown operation." });
});
