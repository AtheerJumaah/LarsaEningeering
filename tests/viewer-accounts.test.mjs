/* Larsa Control — Viewer accounts, front-end contract tests.
 *
 * The SQL suite (tests/viewer-accounts-sql.test.sql) proves the real
 * enforcement — RLS, the grants, the guard trigger. These tests are about
 * the surface the spec asked for by name: public sign-up can never become a
 * Viewer, an admin approving a request never sees a password field, Users &
 * Access is split into three tabs, deleting an account (either kind) always
 * confirms first, and the Auto Build meeting day is no longer hardcoded to
 * Monday.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("public Create Account can only ever become an email-based Engineer, never a Viewer", async () => {
  const access = await read("app/AccountAccess.tsx");
  assert.match(access, /const NEW_ACCOUNT_ACCESS = "Engineer";/);
  assert.doesNotMatch(access, /const NEW_ACCOUNT_ACCESS = "Viewer";/);
  // No role selector exists on the signup form at all — the person can
  // never choose, and Viewer specifically can never be an option.
  assert.doesNotMatch(access, /name="access"|<select[^>]*role/i);
  assert.match(access, /it must never be reachable from this public form/);
});

test("a company-domain signup auto-approves; anything else is created disabled and pending", async () => {
  const access = await read("app/AccountAccess.tsx");
  assert.match(access, /const COMPANY_DOMAINS = \["larsaeng\.com", "larsaengineering\.com"\];/);
  assert.match(access, /function isCompanyEmail\(email: string\) \{\s*return COMPANY_DOMAINS\.indexOf\(domainOf\(email\)\) >= 0;/);
  assert.match(access, /enabled: company && policy\.signup_requires_approval !== true,/);
  assert.match(access, /pendingApproval: !company \|\| policy\.signup_requires_approval === true,/);
  assert.match(access, /access: NEW_ACCOUNT_ACCESS,/);
  assert.match(access, /notifyAdminsOfPendingAccount\(created, list\);/);
});

test("signup asks for an Employee PIN, refuses duplicates, and stores it hashed", async () => {
  const access = await read("app/AccountAccess.tsx");
  // The field: required, digits only, 4 to 8 of them, never autofilled.
  assert.match(access, /Employee PIN/);
  assert.match(access, /pattern="\\d\{4,8\}"/);
  assert.match(access, /setPin\(event\.target\.value\.replace\(\/\\D\/g, ""\)\)/);
  // Format is validated before any code is emailed.
  assert.match(access, /if \(!\/\^\\d\{4,8\}\$\/\.test\(pin\)\) \{\s*setError\("Choose an Employee PIN of 4 to 8 digits\."\);/);
  // Uniqueness is checked twice — on the details screen, and again against a
  // freshly read list at the moment the account is written, because PIN
  // sign-in takes the first match and a duplicate signs one person in as
  // another.
  assert.match(access, /await pinTakenByOther\(users, pin, undefined\)/);
  assert.match(access, /if \(await pinTakenByOther\(list, pin, undefined\)\) \{/);
  // Stored only as a hash, exactly like the password beside it.
  assert.match(access, /pin: await hashPin\(pin\),/);
  assert.doesNotMatch(access, /pin: pin[,}]/);
  // Typed twice, like the password — a mistyped PIN would lock the person out
  // of the quick clock without them ever knowing what they saved.
  assert.match(access, /Confirm PIN/);
  assert.match(access, /if \(pin !== confirmPin\) \{\s*setError\("The two PINs do not match\."\);/);
});

test('PIN fields are masked with CSS, not type="password" — that combo ate Backspace on phone keyboards', async () => {
  const access = await read("app/AccountAccess.tsx");
  const page = await read("app/page.tsx");
  const css = await read("app/globals.css");
  // Pairing type="password" with inputMode="numeric" is what a phone user
  // actually hit: the numeric secure-entry keypad that combination triggers
  // on Android and iOS accepted new digits but silently refused
  // Backspace/Delete. Every PIN field keeps its numeric keypad and its
  // masked dots, but the masking now comes from CSS so the input itself
  // stays a plain, fully editable type="text" — only the two real
  // (alphabetic) password fields still switch native type on showPass.
  const passwordTypeSwitches = access.match(/type=\{showPass \? "text" : "password"\}/g) || [];
  assert.equal(passwordTypeSwitches.length, 2, "only New Password and Confirm Password should still switch native type");
  const pinMaskSwitches = access.match(/className=\{showPass \? undefined : "pin-mask"\}/g) || [];
  assert.equal(pinMaskSwitches.length, 4, "PIN and Confirm PIN should mask via CSS on both the signup and forgotPin screens");
  assert.match(page, /<label>Employee PIN<input type="text" className="pin-mask" required inputMode="numeric" value=\{loginPin\}/);
  assert.match(css, /\.pin-mask \{ -webkit-text-security: disc; \}/);
});

test("editing a user's ACCESS never demands their password or PIN — those belong to the person", async () => {
  const page = await read("app/page.tsx");
  // The save validation asks for a password only when CREATING a username-only
  // account; an existing account (with or without a stored PIN) saves freely.
  assert.match(page, /if \(!draft\.name\.trim\(\) \|\| \(isNew && !draft\.password\) \|\| \(!usernameOnly && !email\)\) \{/);
  assert.doesNotMatch(page, /Name, work email, password, and PIN are required\./);
  // And an empty secret is never hashed into a sign-in-able credential.
  assert.match(page, /password: !nextUser\.password \? "" :/);
});

test("a person changing their own PIN cannot take one already in use", async () => {
  const page = await read("app/page.tsx");
  // My Settings → Security runs the same uniqueness check as Create Account
  // and the admin editor, against every account.
  assert.match(page, /await pinTakenByOther\(everyone, secret\.pin, user\?\.id\)/);
});

test("PIN sign-in proves its inbox like email sign-in: first time, then per the configured period", async () => {
  const page = await read("app/page.tsx");
  const verification = await read("lib/verification.ts");
  const platform = await read("app/PlatformSettings.tsx");
  const policyFn = await read("supabase/functions/auth-policy/index.ts");
  const migration = await read("supabase/migrations/20260805_auth_026_pin_verification_policy.sql");
  // The gate in signIn: governed by the policy, weekly by default, and a
  // username-only account with no mailbox is never asked.
  assert.match(page, /loginMode === "pin" && supabaseConfigured\(\) && user\.email/);
  assert.match(page, /pinPolicy\.pin_verification_required !== false/);
  assert.match(page, /Number\(pinPolicy\.pin_hours\) \|\| 168/);
  // Finishing through the code screen keeps the PIN session's reduced surface.
  assert.match(page, /method\?: SignInMethod/);
  assert.match(page, /completeSignIn\(verifiedUser, rememberedMethod\)/);
  assert.match(page, /setVerifyStage\(\{ user, email: user\.email as string, method: "pin" \}\)/);
  // The knob and the switch, managed in Platform Settings like the email ones.
  assert.match(verification, /pin_verification_required: true, pin_hours: 168/);
  assert.match(platform, /PIN sign-in asks for an email code/);
  assert.match(platform, /pin_hours: Number\(e\.target\.value\) \|\| 168/);
  // Enforced end to end: the policy row stores it and the function serves it.
  assert.match(migration, /add column if not exists pin_verification_required boolean not null default true/);
  assert.match(policyFn, /pin_verification_required, pin_hours, interval_unit"\)/);
  assert.match(policyFn, /next\.pin_hours = Math\.max\(1, Number\(policy\.pin_hours\) \|\| 168\)/);
});

test("the domain check is exact-match, not a suffix match (anti-spoofing)", async () => {
  const access = await read("app/AccountAccess.tsx");
  assert.match(access, /function domainOf\(email: string\) \{\s*return normalise\(email\)\.split\("@"\)\[1\] \|\| "";\s*\}/);
  // indexOf on an exact-match array, not .endsWith()/.includes() against the
  // raw domain — "notlarsaeng.com" or "larsaeng.com.evil.tld" must not pass.
  assert.doesNotMatch(access, /domainOf\(email\)\.endsWith\(|domainOf\(email\)\.includes\(/);
});

test("Users & Access is split into Pending, Active, Viewer, and Offboarded tabs", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /const \[tab, setTab\] = useState<"pending" \| "active" \| "viewers" \| "offboarded" \| "recycled">\("active"\);/);
  assert.match(page, /const pendingUsers = users\.filter\(\(user\) => user\.pendingApproval === true && user\.offboarded !== true\);/);
  assert.match(page, /const activeUsers = users\.filter\(\(user\) => user\.pendingApproval !== true && user\.access !== "Client" && user\.offboarded !== true\);/);
  assert.match(page, /const offboardedUsers = users\.filter\(\(user\) => user\.offboarded === true && user\.recycled !== true\);/);
  assert.match(page, /const decidePending = async \(approve: boolean\) => \{/);
  assert.match(page, /<ViewerAccountsPanel/);
});

test("approving or rejecting a pending request never touches password or PIN", async () => {
  const page = await read("app/page.tsx");
  const decideBlock = page.slice(page.indexOf("const decidePending"), page.indexOf("const decidePending") + 600);
  assert.doesNotMatch(decideBlock, /password|\bpin\b/i);
  assert.match(decideBlock, /pendingApproval: false/);
});

test("the account editor only ever shows password/PIN fields for username-only roles", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /const USERNAME_ONLY_PRESETS = \["Client", "Trainee", "Intern"\];/);
  assert.match(page, /USERNAME_ONLY_PRESETS\.includes\(draft\.access \|\| ""\)/);
  assert.match(page, /Password and PIN are never shown or set here/);
});

test("a staff record can never be given a read-only client role — that lives in Viewer Accounts", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /const LEGACY_CLIENT_PRESETS = \["Client", "Viewer"\];/);
  assert.match(page, /\.\.\.ROLE_PRESETS\.filter\(\(role\) => !LEGACY_CLIENT_PRESETS\.includes\(role\)\),/);
  // An account created before the split still shows its own role rather than
  // silently rendering as whatever option happens to come first.
  assert.match(page, /\.\.\.\(draft\.access && LEGACY_CLIENT_PRESETS\.includes\(draft\.access\) \? \[draft\.access\] : \[\]\),/);
});

test("a brand-new email-based account cannot be created directly by an admin", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /New email-based accounts are created by the person themselves via Create Account\./);
});

test("removing an account always asks for confirmation first — employee or Viewer", async () => {
  const page = await read("app/page.tsx");
  /* Employees are OFFBOARDED, never deleted: the confirmation says so, in the
     app's own dialog. Viewers remain a真 deletion (a separate Supabase Auth
     identity with no work history), and their warning still says so. */
  assert.match(page, /await dialog\.confirm\(`Offboard \$\{target\.name\}\? They lose access immediately, all their history stays viewable, and the account can be restored any time from the Offboarded tab\.`\)/);
  assert.match(page, /await dialog\.confirm\(`Delete the Viewer account for \$\{draft\.displayName \|\| draft\.username\}\? They will immediately lose access, and this cannot be undone\.`\)/);
});

test("offboarding keeps everything and can be undone; the Offboarded tab shows the history", async () => {
  const page = await read("app/page.tsx");
  // Nothing is spliced out of the directory any more — the record is flagged.
  assert.match(page, /offboarded: true,\s*\n\s*enabled: false,\s*\n\s*pendingApproval: false,\s*\n\s*offboardedAt: new Date\(\)\.toISOString\(\),\s*\n\s*offboardedBy: actor\.name,/);
  assert.doesNotMatch(page, /store\.users\.splice\(existingIndex, 1\);/);
  // Schedule and approval-flow config are no longer thrown away on removal.
  assert.doesNotMatch(page, /if \(store\.schedule\) delete store\.schedule\[target\.id\];/);
  // The way back, gated and audited like the way out.
  assert.match(page, /const restoreAccessUser = async \(target: StaffUser, historyMode\?: "all" \| "current" \| "from", historyFrom\?: string\)/);
  assert.match(page, /logAccountEvent\(actor, "account\.offboarded", target\.id, target\.name/);
  assert.match(page, /logAccountEvent\(actor, "account\.reactivated", target\.id, target\.name/);
  // The tab, its restore button, and the viewable history.
  assert.match(page, /setTab\("offboarded"\)/);
  assert.match(page, /Reactivate account/);
  assert.match(page, /View history/);
  // Offboarded people never appear in the active or pending lists.
  assert.match(page, /user\.pendingApproval !== true && user\.access !== "Client" && user\.offboarded !== true/);
});

test("a forgotten PIN is reset exactly like a forgotten password: emailed code, then a new unique PIN", async () => {
  const page = await read("app/page.tsx");
  const access = await read("app/AccountAccess.tsx");
  // The entry point on the PIN sign-in tab.
  assert.match(page, /setAccessMode\("forgotPin"\)/);
  assert.match(page, /Forgot PIN\?/);
  // The flow: email first, the new PIN only after the code proves the inbox.
  assert.match(access, /"signup" \| "forgot" \| "forgotPin" \| "reset" \| "confirm"/);
  assert.match(access, /\(mode === "forgot" \|\| mode === "forgotPin"\) && !users\.some/);
  /* The reset also stamps touchedAt + pinChangedAt now — the recency marks
     that keep a stale copy of the record from dragging the old PIN back. */
  assert.match(access, /if \(mode === "forgotPin"\) \{[\s\S]{0,600}?list\[index\] = \{ \.\.\.list\[index\], pin: await hashPin\(pin\), emailVerified: true, touchedAt: serverNowIso\(\), pinChangedAt: serverNowIso\(\) \};/);
  // Uniqueness holds on this path too, excluding the account being reset.
  assert.match(access, /await pinTakenByOther\(users, pin, owner\?\.id\)/);
});

test("every account-lifecycle action is logged, and the log never carries a secret", async () => {
  const page = await read("app/page.tsx");
  const migration = await read("supabase/migrations/20260803_acct_016_viewer_accounts.sql");
  assert.match(page, /function logAccountChanges\(/);
  assert.match(page, /account\.approved|account\.rejected/);
  assert.match(page, /account\.role_changed/);
  assert.match(page, /account\.permissions_changed/);
  assert.match(migration, /Never stores a password, PIN, hash,\s*\n--\s*or reset token/);
  const edgeFn = await read("supabase/functions/viewer-admin/index.ts");
  assert.match(edgeFn, /Never log the password itself — only that a reset happened\./);
});

test("Viewer accounts are created only by an admin — username and password, no email", async () => {
  const edgeFn = await read("supabase/functions/viewer-admin/index.ts");
  assert.match(edgeFn, /const WRITE_ROLES = \["Super Admin", "Admin", "Admin HR"\];/);
  assert.match(edgeFn, /function usernameProblem\(username: string\)/);
  assert.match(edgeFn, /function passwordProblem\(password: string, confirm: string\)/);
  assert.doesNotMatch(edgeFn, /requires?\s+an?\s+email/i);
});

test("a Viewer's project scope is enforced server-side, never fetched-all-then-hidden", async () => {
  const page = await read("app/page.tsx");
  // The portal queries acct_projects/acct_progress_updates directly and
  // calls the gated RPC for numbers — never accountingSnapshot, the
  // client-side-filtered, everyone-signed-in-can-read local cache the rest
  // of the app uses.
  const portal = page.slice(page.indexOf("function ViewerPortal("), page.indexOf("function AccessCenter("));
  assert.match(portal, /\.from\("acct_projects"\)/);
  assert.match(portal, /\.from\("acct_progress_updates"\)/);
  assert.match(portal, /\.rpc\("viewer_project_summary"/);
  assert.doesNotMatch(portal, /accountingSnapshot/);
});

test("a Viewer never reaches the staff app shell", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /if \(viewerSession\) \{\s*return <ViewerPortal session=\{viewerSession\} onSignOut=\{viewerSignOut\} \/>;/);
});

test("Viewer sign-in is tried only after the employee lookup has already failed, using the same box", async () => {
  const page = await read("app/page.tsx");
  const block = page.slice(page.indexOf("const credentialOk = user"), page.indexOf("const credentialOk = user") + 900);
  assert.match(block, /if \(!user \|\| !credentialOk\) \{/);
  assert.match(block, /const viewerResult = await tryViewerSignIn\(enteredLocal, enteredPass\);/);
  assert.match(block, /if \(viewerResult === "signed-in"\) return;/);
});

test("Viewer sign-in uses Supabase Auth directly, never larsaStaffV8", async () => {
  const page = await read("app/page.tsx");
  const fn = page.slice(page.indexOf("const tryViewerSignIn"), page.indexOf("const tryViewerSignIn") + 1400);
  assert.match(fn, /client\.auth\.signInWithPassword\(\{/);
  assert.match(fn, /email: `\$\{uname\}@\$\{VIEWER_EMAIL_DOMAIN\}`,/);
  assert.doesNotMatch(fn, /larsaStaffV8/);
});

test("the Auto Build team meeting day is configurable, not hardcoded to Monday", async () => {
  const page = await read("app/page.tsx");
  assert.doesNotMatch(page, /mondayMeeting/);
  assert.match(page, /teamMeetingDay: string/);
  assert.match(page, /teamMeetingDay: "Monday",/); // the default still matches old behaviour
  assert.match(page, /if \(settings\.teamMeetingDay && day === settings\.teamMeetingDay\)/);
  assert.match(page, /\{OFFICE_WEEK\.map\(\(day\) => <option key=\{day\} value=\{day\}>\{day\}<\/option>\)\}/);
});

test("the team meeting time is chosen too, not fixed at 16:00", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /teamMeetingStart: string;/);
  assert.match(page, /teamMeetingEnd: string;/);
  // Two real time pickers, not a hardcoded string in the copy.
  assert.match(page, /<label>Meeting starts\s*\n\s*<input type="time" value=\{meetingStart\}/);
  assert.match(page, /<label>Meeting ends\s*\n\s*<input type="time" value=\{meetingEnd\}/);
  assert.doesNotMatch(page, /16:00 team meeting is mandatory/);
  // Empty means "leave what the office already runs alone", so an office that
  // had already corrected the meeting hours by hand keeps them.
  assert.match(page, /teamMeetingStart: "",\s*\n\s*teamMeetingEnd: "",/);
  assert.match(page, /const meetingStart = build\.teamMeetingStart \|\| savedMeetingHours\[0\] \|\| "16:00";/);
});

test("choosing the meeting hours corrects the shift catalogue, so the legend cannot drift", async () => {
  const page = await read("app/page.tsx");
  const build = page.slice(page.indexOf("const autoBuildWeek"), page.indexOf("const saveShiftColours"));
  assert.match(build, /if \(settings\.teamMeetingDay && meetingStart && meetingEnd\) \{/);
  assert.match(build, /code: "MON",/);
  assert.match(build, /time: `\$\{meetingStart\} – \$\{meetingEnd\}`,/);
  // The catalogue is corrected BEFORE the roster is written, so the entries
  // pick the new hours up through the ordinary shiftTimesFor lookup.
  assert.ok(build.indexOf('code: "MON",') < build.indexOf("const times = shiftTimesFor(code, store);"));
});

test("a meeting that ends before it starts cannot be built", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /const meetingHoursBackwards = Boolean\(meetingStart && meetingEnd && meetingEnd <= meetingStart\);/);
  assert.match(page, /disabled=\{meetingHoursBackwards\}/);
  assert.match(page, /The meeting ends before it starts\./);
});

test("the shift legend no longer names Monday specifically", async () => {
  const page = await read("app/page.tsx");
  assert.doesNotMatch(page, /"Monday meeting"/);
  assert.match(page, /label: "Team meeting"/);
});
