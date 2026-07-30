"use client";

/* The three account-access flows that sit alongside sign-in: creating an
 * account, recovering a forgotten password, and the forced password change on
 * a first sign-in. All three end in the same place -- a verified email address
 * and a password the person chose themselves -- so they share one component
 * and one 6-digit-code round trip through the auth-code Edge Function.
 *
 * This lives outside app/page.tsx deliberately. page.tsx is one very large
 * client component; adding several hundred lines of auth UI to it would make
 * the sign-in path harder to audit, which is the last place that should be
 * hard to read.
 *
 * Staff records are plain objects inside the larsaStaffV8 localStorage blob,
 * not Supabase Auth users, so this writes to that blob directly. That write is
 * what lib/supabase/sync.ts is watching: it pushes the change to Supabase and
 * on to everyone else's browser, so an account created in Mosul exists in
 * Texas a second later without anything extra here.
 */

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { getSupabaseClient, supabaseConfigured } from "../lib/supabase/client";
import { sendMail } from "../lib/supabase/mail";

/* Only the fields these flows actually touch. page.tsx owns the full StaffUser
   shape; duplicating all of it here would just be a second copy to keep in
   sync. */
export type AccessUser = {
  id: string;
  name: string;
  username?: string;
  password?: string;
  pin?: string;
  access?: string;
  role?: string;
  department?: string;
  email?: string;
  phone?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  mustResetPassword?: boolean;
  pendingApproval?: boolean;
  projectAccessMode?: string;
  projectIds?: string[];
  notes?: string;
};

export type AccessMode = "signup" | "forgot" | "reset";

const STORE_KEY = "larsaStaffV8";

/* Anyone with an address at one of these domains is a colleague, so their
   account goes live the moment they prove they can read that inbox. Everything
   else -- a personal Gmail, a contractor's own company -- is created but held
   disabled until an administrator approves it. Two people on the contact sheet
   already use outside addresses, so this cannot simply reject them. */
const COMPANY_DOMAINS = ["larsaeng.com", "larsaengineering.com"];

/* What a brand-new account can do until someone grants it more: sign in, clock
   in and out, and see its own performance points. Viewer is the narrowest of
   the access levels already in use, and a project mode of "none" means no
   project data at all. */
const NEW_ACCOUNT_ACCESS = "Viewer";

function readStore(): { users: AccessUser[] } & Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      if (!Array.isArray((parsed as { users?: unknown }).users)) (parsed as { users: AccessUser[] }).users = [];
      return parsed as { users: AccessUser[] } & Record<string, unknown>;
    }
  } catch {
    // A corrupt blob is treated as an empty one rather than blocking sign-in.
  }
  return { users: [] };
}

function writeStore(store: { users: AccessUser[] } & Record<string, unknown>) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function normalise(value: string | undefined) {
  return String(value || "").trim().toLowerCase();
}

/* Collapses runs of spaces so "Mohammed  Jamal   Issa" and "mohammed jamal
   issa" compare as the same person. */
function nameKey(value: string | undefined) {
  return normalise(value).split(" ").filter(Boolean).join(" ");
}

function stripSpaces(value: string) {
  return value.split(" ").join("").split("	").join("");
}

function domainOf(email: string) {
  return normalise(email).split("@")[1] || "";
}

function isCompanyEmail(email: string) {
  return COMPANY_DOMAINS.indexOf(domainOf(email)) >= 0;
}

/* Keeps new ids in the u1, u2, u3 ... series the seed data uses instead of
   dropping a timestamp into the middle of it. */
function nextUserId(users: AccessUser[]) {
  let highest = 0;
  users.forEach((row) => {
    const id = String(row.id || "");
    if (id.charAt(0) !== "u") return;
    const digits = id.slice(1);
    if (!digits || Number.isNaN(Number(digits))) return;
    highest = Math.max(highest, Number(digits));
  });
  return "u" + String(highest + 1);
}

/* The local part of the address, which the sign-in form already accepts in
   place of a full address ("ajumaah" works as well as the whole thing). */
function usernameFor(email: string, users: AccessUser[]) {
  const base = normalise(email).split("@")[0] || "user";
  let candidate = base;
  let suffix = 2;
  while (users.some((row) => normalise(row.username) === candidate)) {
    candidate = base + String(suffix);
    suffix += 1;
  }
  return candidate;
}

type CodeResult = { ok: boolean; error?: string };

async function callAuthCode(body: Record<string, unknown>): Promise<CodeResult> {
  const unavailable = { ok: false, error: "Email is not configured on this deployment." };
  if (!supabaseConfigured()) return unavailable;
  const client = getSupabaseClient();
  if (!client) return unavailable;
  try {
    const { data, error } = await client.functions.invoke("auth-code", { body });
    if (error) return { ok: false, error: "Could not reach the email service. Check your connection and try again." };
    const result = (data || {}) as CodeResult;
    return { ok: Boolean(result.ok), error: result.error };
  } catch {
    return { ok: false, error: "Could not reach the email service. Check your connection and try again." };
  }
}

/* Tells the administrators that somebody outside the company is waiting. Sent
   best-effort: a mail failure must not lose the pending account, which is
   already saved by the time this runs. */
function notifyAdminsOfPendingAccount(user: AccessUser, users: AccessUser[]) {
  const admins = users
    .filter((row) => row.access === "Super Admin" || row.access === "Manager")
    .map((row) => String(row.email || "").trim())
    .filter(Boolean);
  const to = admins.length ? admins : ["ajumaah@larsaeng.com"];
  sendMail({
    to,
    subject: "Account approval needed: " + user.name,
    html:
      '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.6">' +
      "<p><b>" + user.name + "</b> created a Larsa Control account with an address outside the company domain.</p>" +
      "<p>Email: " + String(user.email) + "<br/>Phone: " + (user.phone || "not given") + "</p>" +
      "<p>The account is saved but disabled. Open <b>Staff Access</b> to approve it, or leave it turned off.</p>" +
      "</div>",
  });
}

export function AccountAccess({
  mode,
  currentUser,
  onCancel,
  onSwitchMode,
  onResetComplete,
}: {
  mode: AccessMode;
  currentUser?: AccessUser | null;
  onCancel?: () => void;
  onSwitchMode?: (next: AccessMode, email?: string) => void;
  onResetComplete?: (user: AccessUser) => void;
}) {
  const [stage, setStage] = useState<"details" | "code">("details");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [showPass, setShowPass] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState(mode === "reset" ? String(currentUser?.email || "") : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");

  /* Read once per mount rather than per keystroke. The duplicate check runs
     against this on submit; the list only changes if someone else signs up
     mid-session, which the next open picks up. */
  const users = useMemo(() => readStore().users, []);

  const heading =
    mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Choose a new password";

  function passwordProblem() {
    if (password.length < 8) return "Use at least 8 characters for your password.";
    if (password !== confirm) return "The two passwords do not match.";
    return "";
  }

  async function submitDetails(event: FormEvent) {
    event.preventDefault();
    setError("");
    setInfo("");

    const address = normalise(email);
    if (address.indexOf("@") < 0) {
      setError("Enter a valid email address.");
      return;
    }

    if (mode === "signup") {
      if (!name.trim()) {
        setError("Enter your full name.");
        return;
      }
      /* The duplicate check, run before anything is sent or saved. Matching on
         the address and on the name separately catches both "I forgot I already
         have an account" and "somebody set one up for me under my name". */
      const byEmail = users.find((row) => normalise(row.email) === address);
      const byName = users.find((row) => nameKey(row.name) === nameKey(name));
      const existing = byEmail || byName;
      if (existing) {
        setError(
          byEmail
            ? "An account already exists for this email address. Reset its password instead of creating a second one."
            : "An account already exists for " + existing.name + ". Reset its password instead of creating a second one.",
        );
        return;
      }
      const problem = passwordProblem();
      if (problem) {
        setError(problem);
        return;
      }
    }

    if (mode === "forgot" && !users.some((row) => normalise(row.email) === address)) {
      setError("No account found for that email address.");
      return;
    }

    if (mode === "reset") {
      const problem = passwordProblem();
      if (problem) {
        setError(problem);
        return;
      }
    }

    setBusy(true);
    const purpose = mode === "signup" ? "verify" : "reset";
    const result = await callAuthCode({ op: "send", email: address, purpose, name: name || currentUser?.name });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || "Could not send the code. Try again.");
      return;
    }
    setStage("code");
    setInfo("We sent a 6-digit code to " + address + ". It expires in 10 minutes.");
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setError("");

    /* On the recovery flow the new password is collected on this second screen,
       so a stranger who only knows someone's address cannot set a password
       without also reading that inbox. */
    if (mode === "forgot") {
      const problem = passwordProblem();
      if (problem) {
        setError(problem);
        return;
      }
    }

    const address = normalise(email);
    const purpose = mode === "signup" ? "verify" : "reset";
    setBusy(true);
    const result = await callAuthCode({ op: "verify", email: address, purpose, code });
    if (!result.ok) {
      setBusy(false);
      setError(result.error || "That code was not accepted.");
      return;
    }

    const store = readStore();
    const list = store.users;

    if (mode === "signup") {
      const company = isCompanyEmail(address);
      const created: AccessUser = {
        id: nextUserId(list),
        name: name.trim(),
        username: usernameFor(address, list),
        email: address,
        phone: phone.trim(),
        password,
        access: NEW_ACCOUNT_ACCESS,
        role: "Staff",
        department: "Unassigned",
        enabled: company,
        emailVerified: true,
        mustResetPassword: false,
        pendingApproval: !company,
        projectAccessMode: "none",
        projectIds: [],
        notes: company ? "" : "Self-registered from outside the company domain - awaiting approval.",
      };
      list.push(created);
      writeStore(store);
      setBusy(false);
      if (!company) {
        notifyAdminsOfPendingAccount(created, list);
        setStage("details");
        setInfo("");
        setError(
          "Your email is verified, but accounts outside the company domain need an administrator to approve them. We have let them know - you will be able to sign in once it is approved.",
        );
        return;
      }
      setInfo("Your account is ready. Sign in with your work email and the password you just chose.");
      window.setTimeout(() => { if (onCancel) onCancel(); }, 2200);
      return;
    }

    /* forgot and reset both land here: the code proved the inbox, so the new
       password can be written and the account marked verified. */
    const index = list.findIndex((row) =>
      mode === "reset" && currentUser ? row.id === currentUser.id : normalise(row.email) === address,
    );
    if (index < 0) {
      setBusy(false);
      setError("That account could no longer be found. Ask an administrator for help.");
      return;
    }
    list[index] = { ...list[index], password, emailVerified: true, mustResetPassword: false };
    writeStore(store);
    setBusy(false);

    if (mode === "reset") {
      if (onResetComplete) onResetComplete(list[index]);
      return;
    }
    setInfo("Password updated. Sign in with your new password.");
    window.setTimeout(() => { if (onCancel) onCancel(); }, 2000);
  }

  async function resend() {
    setBusy(true);
    setError("");
    const purpose = mode === "signup" ? "verify" : "reset";
    const result = await callAuthCode({ op: "send", email: normalise(email), purpose, name: name || currentUser?.name });
    setBusy(false);
    if (!result.ok) setError(result.error || "Could not send another code.");
    else setInfo("We sent another code to " + normalise(email) + ".");
  }

  const passwordField = (
    <label>
      New Password
      <span className="password-field">
        <input
          type={showPass ? "text" : "password"}
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setShowPass((value) => !value)}
          aria-label={showPass ? "Hide password" : "Show password"}
        >
          {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </span>
    </label>
  );

  const confirmField = (
    <label>
      Confirm Password
      <input
        type={showPass ? "text" : "password"}
        required
        minLength={8}
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
    </label>
  );

  const body = (
    <>
      <div className="auth-copy">
        <span className="eyebrow">{mode === "reset" ? "First sign-in" : "Larsa Engineering"}</span>
        <h1>{heading}</h1>
        <p>
          {mode === "signup"
            ? "Use your Larsa work email. We will send a code to confirm it is yours."
            : mode === "forgot"
              ? "Enter your work email and we will send a code so you can set a new password."
              : "For your first sign-in, choose a password only you know."}
        </p>
      </div>

      {stage === "details" ? (
        <form onSubmit={submitDetails}>
          {mode === "signup" && (
            <>
              <label>
                Full Name
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  placeholder="First and last name"
                />
              </label>
              <label>
                Phone (optional)
                <input
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  autoComplete="tel"
                  placeholder="+964 7XX XXX XXXX"
                />
              </label>
            </>
          )}

          <label>
            Work Email
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              readOnly={mode === "reset"}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="email"
              placeholder="name@larsaeng.com"
            />
          </label>

          {mode !== "forgot" && (
            <>
              {passwordField}
              {confirmField}
            </>
          )}

          {mode === "signup" && (
            <p className="auth-hint">
              Accounts on a larsaeng.com address go live as soon as you confirm your email. Any other address needs an
              administrator to approve it first.
            </p>
          )}

          <div className="auth-error" role="alert">{error}</div>
          {info ? <p className="auth-hint">{info}</p> : null}
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "Sending..." : mode === "signup" ? "Send Verification Code" : "Send Reset Code"}
          </button>

          {onCancel ? (
            <div className="rowActions" style={{ justifyContent: "center", marginTop: 10 }}>
              <button type="button" className="btn small" onClick={onCancel}>Back to sign in</button>
              {mode === "signup" && onSwitchMode ? (
                <button type="button" className="btn small" onClick={() => onSwitchMode("forgot", email)}>
                  Reset my password
                </button>
              ) : null}
            </div>
          ) : null}
        </form>
      ) : (
        <form onSubmit={submitCode}>
          <label>
            Verification Code
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              required
              value={code}
              onChange={(event) => setCode(stripSpaces(event.target.value))}
              placeholder="123456"
              autoFocus
            />
          </label>

          {mode === "forgot" && (
            <>
              {passwordField}
              {confirmField}
            </>
          )}

          <div className="auth-error" role="alert">{error}</div>
          {info ? <p className="auth-hint">{info}</p> : null}
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "Checking..." : mode === "signup" ? "Confirm and Create Account" : "Save New Password"}
          </button>
          <div className="rowActions" style={{ justifyContent: "center", marginTop: 10 }}>
            <button type="button" className="btn small" onClick={resend} disabled={busy}>Resend Code</button>
            {onCancel ? <button type="button" className="btn small" onClick={onCancel}>Cancel</button> : null}
          </div>
        </form>
      )}
    </>
  );

  /* The forced reset is the only one of the three that has to cover the app
     rather than sit inside the sign-in card, because by the time it runs the
     person is already signed in. */
  if (mode === "reset") {
    return (
      <div className="auth-layer">
        <section className="auth-card">
          <div className="auth-brand">
            <span><ShieldCheck size={18} /> Secure staff access</span>
          </div>
          {body}
        </section>
      </div>
    );
  }

  return body;
}
