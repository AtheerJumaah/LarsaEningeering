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

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { getSupabaseClient, supabaseConfigured } from "../lib/supabase/client";
import { sendMail } from "../lib/supabase/mail"; import { hashPassword, hashPin, pinTakenByOther } from "../lib/password"; import { loadPolicy, DEFAULT_POLICY } from "../lib/verification";

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

export type AccessMode = "signup" | "forgot" | "forgotPin" | "reset" | "confirm";

const STORE_KEY = "larsaStaffV8";

/* Anyone with an address at one of these domains is a colleague, so their
   account goes live the moment they prove they can read that inbox. Everything
   else -- a personal Gmail, a contractor's own company -- is created but held
   disabled until an administrator approves it. Two people on the contact sheet
   already use outside addresses, so this cannot simply reject them. */
const COMPANY_DOMAINS = ["larsaeng.com", "larsaengineering.com"];

/* What a brand-new self-registered account can do until an admin grants it
   more: sign in, clock in and out, submit performance, see its own points.
   This is the default *requested* role for every public sign-up — the
   person can never choose a different one here, and an admin can still
   change it afterward. It is deliberately never "Viewer": Viewer is a
   distinct, admin-only, username+password client account with no self-
   registration path at all (see the Viewer Accounts tab in Users & Access),
   so it must never be reachable from this public form. */
const NEW_ACCOUNT_ACCESS = "Engineer";

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
  onResetComplete,  onConfirmed,
}: {
  mode: AccessMode;
  currentUser?: AccessUser | null;
  onCancel?: () => void;
  onSwitchMode?: (next: AccessMode, email?: string) => void;
  onResetComplete?: (user: AccessUser) => void;  onConfirmed?: () => void;
}) {
  const [stage, setStage] = useState<"details" | "code">("details"); const [policy, setPolicy] = useState(DEFAULT_POLICY); useEffect(() => { let alive = true; loadPolicy().then((next) => { if (alive) setPolicy(next); }); return () => { alive = false; }; }, []); const skipInitial = mode === "signup" && policy.initial_verification_required === false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [showPass, setShowPass] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  /* "confirm" (the accounting-area identity check) arrives with the signed-in
     user and its field is read-only — so it MUST be prefilled from that user,
     exactly like "reset". Before this, confirm mode started empty AND
     read-only: an untypeable blank email box that blocked the whole gate. */
  const [email, setEmail] = useState(mode === "reset" || mode === "confirm" ? String(currentUser?.email || "") : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  /* The quick-access PIN, chosen at sign-up like the password. PIN sign-in
     identifies the person BY the pin alone, so it must be unique across every
     account — validated below with the same check the admin editor uses. It is
     typed twice, exactly like the password, because a mistyped PIN locks the
     person out of the quick clock without them ever knowing what they saved. */
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [code, setCode] = useState("");

  /* Read once per mount rather than per keystroke. The duplicate check runs
     against this on submit; the list only changes if someone else signs up
     mid-session, which the next open picks up. */
  const users = useMemo(() => readStore().users, []);

  const heading =
    mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : mode === "forgotPin" ? "Reset your PIN" : mode === "confirm" ? "Confirm it is you" : "Choose a new password";

  function passwordProblem() {    if (mode === "confirm" || mode === "forgotPin") return "";
    if (password.length < 8) return "Use at least 8 characters for your password.";
    if (password !== confirm) return "The two passwords do not match.";
    return "";
  }

  async function submitDetails(event: FormEvent) {
    if (event) event.preventDefault();
    setError("");
    setInfo("");

    const address = normalise(email);
    if (address.indexOf("@") < 0) {
      setError("Enter a valid email address.");
      return;
    }

    if (mode === "signup") {
      if (policy.self_signup_enabled === false) { setError("Account creation is turned off. Ask an administrator to create your account."); return; }    if (!name.trim()) {
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
      if (!/^\d{4,8}$/.test(pin)) {
        setError("Choose an Employee PIN of 4 to 8 digits.");
        return;
      }
      if (pin !== confirmPin) {
        setError("The two PINs do not match.");
        return;
      }
      /* A duplicate PIN would sign one person in as another, since PIN sign-in
         takes the first match — so it is refused here, before any code is sent. */
      setBusy(true);
      const taken = await pinTakenByOther(users, pin, undefined);
      setBusy(false);
      if (taken) {
        setError("That PIN is already in use by another account. Choose a different one.");
        return;
      }
    }

    if ((mode === "forgot" || mode === "forgotPin") && !users.some((row) => normalise(row.email) === address)) {
      setError("No account found for that email address.");
      return;
    }

    if (mode === "reset" || String(mode) === "confirm") {
      const problem = passwordProblem();
      if (problem) {
        setError(problem);
        return;
      }
    }

    setBusy(true);
    const purpose = mode === "signup" || mode === "confirm" ? "verify" : "reset";
    if (skipInitial) { setBusy(false); await submitCode(); return; } const result = await callAuthCode({ op: "send", email: address, purpose, name: name || currentUser?.name });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || "Could not send the code. Try again.");
      return;
    }
    setStage("code");
    setInfo("Code sent to " + address + ". It expires in 10 minutes.");
  }

  async function submitCode(event?: FormEvent) {
    if (event) event.preventDefault();
    setError("");

    /* On the recovery flows the new secret is collected on this second screen,
       so a stranger who only knows someone's address cannot set a password —
       or a PIN — without also reading that inbox. */
    if (mode === "forgot") {
      const problem = passwordProblem();
      if (problem) {
        setError(problem);
        return;
      }
    }
    if (mode === "forgotPin") {
      if (!/^\d{4,8}$/.test(pin)) {
        setError("Choose an Employee PIN of 4 to 8 digits.");
        return;
      }
      if (pin !== confirmPin) {
        setError("The two PINs do not match.");
        return;
      }
      /* The new PIN must still be unique to this person — PIN sign-in
         identifies the account BY the pin alone. */
      const owner = users.find((row) => normalise(row.email) === normalise(email));
      if (await pinTakenByOther(users, pin, owner?.id)) {
        setError("That PIN is already in use by another account. Choose a different one.");
        return;
      }
    }

    const address = normalise(email);
    const purpose = mode === "signup" || mode === "confirm" ? "verify" : "reset";
    setBusy(true);
    const result = skipInitial ? { ok: true, error: undefined as string | undefined } : await callAuthCode({ op: "verify", email: address, purpose, code });
    if (!result.ok) {
      setBusy(false);
      setError(result.error || "That code was not accepted.");
      return;
    }

    if (mode === "confirm") { setBusy(false); if (onConfirmed) onConfirmed(); return; }    const store = readStore();
    const list = store.users;

    if (mode === "signup") {
      /* Re-checked against the freshly read list: somebody else can have signed
         up with the same PIN between the details screen and this code screen,
         and this is the moment the account is actually written. */
      if (await pinTakenByOther(list, pin, undefined)) {
        setBusy(false);
        setStage("details");
        setError("That PIN was just taken by another account. Choose a different one and try again.");
        return;
      }
      const company = isCompanyEmail(address);
      const created: AccessUser = {
        id: nextUserId(list),
        name: name.trim(),
        username: usernameFor(address, list),
        email: address,
        phone: phone.trim(),
        password: await hashPassword(password),
        pin: await hashPin(pin),
        access: NEW_ACCOUNT_ACCESS,
        role: "Staff",
        department: "Unassigned",
        enabled: company && policy.signup_requires_approval !== true,
        emailVerified: true,
        mustResetPassword: false,
        pendingApproval: !company || policy.signup_requires_approval === true,
        projectAccessMode: "none",
        projectIds: [],
        notes: company ? "" : "Self-registered from outside the company domain - awaiting approval.",
      };
      list.push(created);
      writeStore(store);
      setBusy(false);
      if (!company || policy.signup_requires_approval === true) {
        notifyAdminsOfPendingAccount(created, list);
        setStage("details");
        setInfo("");
        setError(
          "Your email is verified, but accounts outside the company domain need an administrator to approve them. We have let them know - you will be able to sign in once it is approved.",
        );
        return;
      }
      setInfo("Account ready. Sign in with your new password.");
      window.setTimeout(() => { if (onCancel) onCancel(); }, 2200);
      return;
    }

    /* forgot, forgotPin and reset all land here: the code proved the inbox,
       so the new secret can be written and the account marked verified. */
    const index = list.findIndex((row) =>
      mode === "reset" && currentUser ? row.id === currentUser.id : normalise(row.email) === address,
    );
    if (index < 0) {
      setBusy(false);
      setError("That account could no longer be found. Ask an administrator for help.");
      return;
    }
    if (mode === "forgotPin") {
      list[index] = { ...list[index], pin: await hashPin(pin), emailVerified: true };
    } else {
      list[index] = { ...list[index], password: await hashPassword(password), emailVerified: true, mustResetPassword: false };
    }
    writeStore(store);
    setBusy(false);

    if (mode === "reset" || String(mode) === "confirm") {
      if (onResetComplete) onResetComplete(list[index]);
      return;
    }
    setInfo(mode === "forgotPin" ? "PIN updated. Sign in with it now." : "Password updated. Sign in again.");
    window.setTimeout(() => { if (onCancel) onCancel(); }, 2000);
  }

  async function resend() {
    setBusy(true);
    setError("");
    const purpose = mode === "signup" || mode === "confirm" ? "verify" : "reset";
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
            ? "We will email you a code to confirm it is yours."
            : mode === "forgot"
              ? "We will email you a code to set a new password."
              : mode === "forgotPin"
                ? "We will email you a code to set a new Employee PIN."
                : mode === "confirm" ? "We will email you a code to confirm it is you." : "Choose a password only you know."}
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
                Phone <span className="optional">optional</span>
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
              readOnly={(mode === "reset" || mode === "confirm") && Boolean(currentUser?.email)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="email"
              placeholder="name@larsaeng.com"
            />
          </label>

          {mode !== "forgot" && mode !== "forgotPin" && mode !== "confirm" && (
            <>
              {passwordField}
              {confirmField}
            </>
          )}

          {mode === "signup" && (
            <>
              <label>
                Employee PIN
                <input
                  type={showPass ? "text" : "password"}
                  required
                  inputMode="numeric"
                  minLength={4}
                  maxLength={8}
                  pattern="\d{4,8}"
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                  autoComplete="off"
                  placeholder="4 to 8 digits"
                />
              </label>
              <label>
                Confirm PIN
                <input
                  type={showPass ? "text" : "password"}
                  required
                  inputMode="numeric"
                  minLength={4}
                  maxLength={8}
                  pattern="\d{4,8}"
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))}
                  autoComplete="off"
                  placeholder="Type it again"
                />
              </label>
            </>
          )}

          {mode === "signup" && (
            <p className="auth-hint">
              Your PIN is your quick sign-in for the clock and your own points — it must
              be different from everyone else&apos;s. A larsaeng.com address activates
              straight away. Anything else needs an administrator to approve it.
            </p>
          )}

          <div className="auth-error" role="alert">{error}</div>
          {info ? <p className="auth-hint">{info}</p> : null}
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "Sending..." : mode === "signup" ? "Send Verification Code" : mode === "confirm" ? "Email Me a Code" : "Send Reset Code"}
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

          {mode === "forgotPin" && (
            <>
              <label>
                New Employee PIN
                <input
                  type={showPass ? "text" : "password"}
                  required
                  inputMode="numeric"
                  minLength={4}
                  maxLength={8}
                  pattern="\d{4,8}"
                  value={pin}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
                  autoComplete="off"
                  placeholder="4 to 8 digits"
                />
              </label>
              <label>
                Confirm PIN
                <input
                  type={showPass ? "text" : "password"}
                  required
                  inputMode="numeric"
                  minLength={4}
                  maxLength={8}
                  pattern="\d{4,8}"
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))}
                  autoComplete="off"
                  placeholder="Type it again"
                />
              </label>
            </>
          )}

          <div className="auth-error" role="alert">{error}</div>
          {info ? <p className="auth-hint">{info}</p> : null}
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "Checking..." : mode === "signup" ? "Confirm and Create Account" : mode === "confirm" ? "Confirm" : mode === "forgotPin" ? "Save New PIN" : "Save New Password"}
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
  if (mode === "reset" || String(mode) === "confirm") {
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
