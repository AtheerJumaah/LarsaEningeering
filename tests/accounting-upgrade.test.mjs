/* Contract tests for the v4.0 accounting upgrade — source-level assertions in
 * the same style as v10-features.test.mjs. They pin the wiring: the engine
 * loads the new layers, the migrations define the authoritative schema, the
 * dangerous legacy behaviors are governed, and the service worker ships the
 * new files. The behavioral maths is covered by tests/accounting-core.test.mjs
 * (browser core) and tests/accounting-sql.test.sql (authoritative backend). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const engine = read("public/engines/accounting.html");
const core = read("public/engines/accounting-core.js");
const cloud = read("public/engines/accounting-cloud.js");
const page = read("app/page.tsx");
const sw = read("public/sw.js");
const migrations = readdirSync(new URL("../supabase/migrations", import.meta.url))
  .filter((f) => /^2026\d{4}_acct_/.test(f))
  .map((f) => read("supabase/migrations/" + f))
  .join("\n");

test("the accounting engine loads the v4.0 core and cloud layers", () => {
  assert.match(engine, /<script src="accounting-core\.js"><\/script>/);
  assert.match(engine, /<script src="accounting-cloud\.js"><\/script>/);
});

test("the parent app hands the engine the Supabase bridge config", () => {
  assert.match(page, /larsaSupabaseBridgeV1/);
  assert.match(cloud, /larsaSupabaseBridgeV1/);
});

test("the service worker ships and refreshes the new engine files", () => {
  assert.match(sw, /"\/engines\/accounting-core\.js"/);
  assert.match(sw, /"\/engines\/accounting-cloud\.js"/);
  assert.ok(!/larsa-control-v15/.test(sw), "the cache name must be bumped past v15");
});

test("migrations define the authoritative relational accounting store", () => {
  for (const table of [
    "acct_platform_settings", "acct_projects", "acct_transactions", "acct_fee_ledger",
    "acct_refund_settlements", "acct_progress_updates", "acct_approval_requests",
    "acct_audit", "acct_review_queue", "acct_archives",
  ]) {
    assert.match(migrations, new RegExp("create table if not exists public\\." + table), table);
  }
  // Precise numeric money types, never floats:
  assert.match(migrations, /original_amount\s+numeric\(18,2\)/);
  assert.match(migrations, /exchange_rate\s+numeric\(14,6\)/);
  assert.match(migrations, /default_fee_rate\s+numeric\(9,6\) not null default 0\.08/);
});

test("platform consultancy default is 8% and the hierarchy is resolved server-side", () => {
  assert.match(migrations, /default 0\.08/);
  assert.match(migrations, /transaction_override/);
  assert.match(migrations, /category_override/);
  assert.match(migrations, /project_default/);
  assert.match(migrations, /platform_default/);
});

test("clients cannot write accounting tables directly — RPCs only, RLS enforced", () => {
  assert.match(migrations, /enable row level security/);
  assert.match(migrations, /revoke insert, update, delete on public\.%I from anon, authenticated/);
  assert.match(migrations, /security definer/);
});

test("the audit table is append-only and backend-controlled with no app-level cap", () => {
  assert.match(migrations, /acct_audit is append-only/);
  assert.match(migrations, /before update or delete on public\.acct_audit/);
  assert.match(migrations, /before truncate on public\.acct_audit/);
  assert.ok(!/acct_audit.*limit 1000/.test(migrations), "no 1000-row cap on the authoritative audit");
});

test("fee idempotency is a database constraint, not an application promise", () => {
  assert.match(migrations, /create unique index if not exists acct_fee_source_uq/);
  assert.match(migrations, /where entry_type = 'fee' and status in \('estimated','posted','settled'\)/);
});

test("the Larsa refund rule is implemented verbatim — never a proportional substitute", () => {
  assert.match(migrations, /Unused Net Funding/);
  assert.match(migrations, /Refundable Consultancy\s+=|refundable_fee/i);
  assert.match(migrations, /retained_fee/);
  assert.match(core, /retained_fee_iqd: r2\(initialFee - refundableFee\)/);
  assert.match(core, /total_refund_iqd: r2\(want \+ refundableFee\)/);
});

test("protected actions demand reason + fresh emailed code + non-self platform-admin approval", () => {
  assert.match(migrations, /acct_consume_email_code/);
  assert.match(migrations, /self-approval is not permitted/);
  assert.match(migrations, /only the Platform Super Admin may decide/i);
  assert.match(cloud, /acct_request_protected/);
  assert.match(cloud, /acct_decide_approval/);
  assert.match(cloud, /verifyLocalPassword/);
});

test("sample data lifecycle: seeded once for an empty org, removed only via approval, never reseeded", () => {
  assert.match(migrations, /sample_state/);
  assert.match(migrations, /'never_seeded','seeded','removed'/);
  assert.match(migrations, /delete from public\.acct_transactions where is_sample/);
  assert.match(cloud, /acct_seed_sample_data/);
  assert.match(cloud, /remove_sample_data/);
  // The 1500/1600 historical-rate example ships inside the seed itself:
  assert.match(migrations, /'exchange_rate', 1500/);
  assert.match(migrations, /'exchange_rate', 1600/);
});

test("the engine governs deletion: drafts soft-delete with a reason, posted records go to the void workflow", () => {
  assert.match(cloud, /acct_soft_delete/);
  assert.match(cloud, /void_posted_transaction/);
  assert.match(cloud, /Posted accounting records are corrected by reversal\/replacement|use the void workflow/);
});

test("project workspace gains the required §4 financial summary and both progress indicators", () => {
  for (const label of [
    "Contract Value", "Approved Project Budget", "Gross Funding Received", "Initial Consultancy Fee",
    "Net Construction Funding", "Actual Construction Cost", "Total Used", "Remaining Unused Balance",
    "Refundable Consultancy Fee", "Total Refund Due to Client", "Final Consultancy Fee Retained",
    "Pending Commitments", "Cost Progress", "Schedule / Physical Progress",
  ]) assert.ok(cloud.includes(label), label + " must appear in the summary card");
  assert.match(cloud, /Not Available/);
  assert.match(cloud, /acct_record_progress/);
});

test("in-project actions stay in the project and never dump the accountant to a global list", () => {
  assert.match(cloud, /keepContext/);
  assert.match(cloud, /restoreContext/);
  assert.match(cloud, /openProjectDetail\(k\.project, k\.tab/);
  // Project locked + prefilled when adding from inside a project:
  assert.match(cloud, /data-acct-locked/);
  assert.match(cloud, /data-acct-prefill/);
});

test("legacy records migrate with a clearly identified Legacy Migrated Rate and a review queue", () => {
  assert.match(migrations, /legacy_migrated/);
  assert.match(migrations, /Legacy Migrated Rate/);
  assert.match(migrations, /acct_review_queue/);
  assert.match(cloud, /acct_import_legacy/);
});

test("timestamps are UTC timestamptz with a configured display timezone", () => {
  assert.match(migrations, /timestamptz/);
  assert.match(migrations, /display_timezone/);
});

test("clients, trainees, and interns are username-and-password accounts — no email ever required", () => {
  assert.match(page, /USERNAME_ONLY_PRESETS = \["Client", "Trainee", "Intern"\]/);
  // The admin editor accepts a missing email and optional PIN for them:
  assert.match(page, /Name and password are required\./);
  assert.match(page, /const usernameOnly = USERNAME_ONLY_PRESETS\.includes\(draft\.access \|\| ""\)/);
  // A blank email can never collide with another blank email:
  assert.match(page, /Boolean\(email\) &&\s*\n\s*\(user\.email\?\.trim\(\)\.toLowerCase\(\) === email\)/);
  // Usernames are generated and kept unique so username sign-in always works:
  assert.match(page, /username: uniqueUsername/);
  // The sign-in field accepts a bare username (no native email constraint):
  assert.match(page, /Email or Username<input type="text"/);
  // The verification gate only ever applies to accounts WITH an email:
  assert.match(page, /supabaseConfigured\(\) && refreshed\.email &&/);
});

test("trainee and intern presets: engineer-style basics, zero accounting access", () => {
  assert.match(page, /"Trainee",\s*\n\s*"Intern",/);
  assert.match(page, /preset === "Trainee" \|\| preset === "Intern"/);
  assert.match(page, /user\.access === "Trainee" \|\| user\.access === "Intern"\) return "Viewer"/);
  // Explicit EMPTY accounting-section sets so the Engineer fallback never
  // opens accounting screens for them:
  assert.match(page, /Trainee: new Set<string>\(\[\]\)/);
  assert.match(page, /Intern: new Set<string>\(\[\]\)/);
  // Their preset grants staff basics + portal view, never acc-* items:
  const traineeBranch = page.split('preset === "Trainee" || preset === "Intern"')[1]?.split("} else {")[0] || "";
  assert.ok(traineeBranch.includes('allow("staff-clock"'), "trainees can clock in");
  assert.ok(traineeBranch.includes('allow("project-portal", VIEW_ONLY)'), "trainees see assigned projects read-only");
  assert.ok(!/allow\("acc-/.test(traineeBranch), "no accounting screens in the trainee/intern preset");
});

test("the client portal shows each project's authoritative financial calculations", () => {
  assert.match(page, /function PortalFinancialSummary/);
  assert.match(page, /acct_project_summary/);
  assert.match(page, /<PortalFinancialSummary project=\{project\} viewer=\{viewer\} \/>/);
  // Clients see money only on their own projects; trainees/interns/engineers see none:
  assert.match(page, /\["Manager", "Accountant", "Team Leader", "Client"\]\.includes\(viewer\.access \|\| ""\)/);
  for (const label of ["Net Construction Funding", "Total Refund Due to Client", "Remaining Unused Balance", "Cost Progress"]) {
    assert.ok(page.includes(label), label + " must appear in the portal summary");
  }
});

test("portal progress edits append to the permanent accounting progress history", () => {
  assert.match(page, /acct_record_progress/);
  assert.match(page, /Updated from the Project Portal/);
  // And the engine mirrors the latest recorded progress back to the portal field:
  assert.match(cloud, /latestProgress\[ap\.id\]/);
});

/* ---- upgrade part 6: review workflow, receipts, statements, permissions ---- */

test("every entry carries a review status separate from its payment status", () => {
  assert.match(migrations, /review_status text not null default 'unreviewed'/);
  assert.match(migrations, /'unreviewed','pending_review','approved','needs_correction'/);
  assert.match(migrations, /acct_submit_for_review/);
  assert.match(migrations, /acct_review_entry/);
  assert.match(migrations, /a correction request requires a comment/i);
});

test("working totals include unapproved entries; approval changes reliability, never amounts", () => {
  assert.match(migrations, /acct_review_breakdown/);
  assert.match(migrations, /working_iqd/);
  assert.match(cloudNow(), /Working Totals — approval changes reliability, never the numbers|approval changes reliability/);
  assert.match(cloudNow(), /Contains Unapproved Accounting Entries/);
});

test("client funding receipts: immediate, immutable, numbered by the server, print history kept", () => {
  assert.match(migrations, /create table if not exists public\.acct_receipts/);
  assert.match(migrations, /create table if not exists public\.acct_receipt_prints/);
  assert.match(migrations, /acct_receipts are immutable/);
  assert.match(migrations, /acct_issue_receipt/);
  assert.match(migrations, /internal review never blocks proof that the money was received/i);
  assert.match(cloudNow(), /Payment Received — Pending Internal Review/);
  assert.match(cloudNow(), /acctPrintReceipt/);
  assert.match(cloudNow(), /Client \/ Payer Signature/);
  assert.match(cloudNow(), /Company Stamp/);
  assert.match(cloudNow(), /amountInWords/);
});

test("corrected receipts reference the original and never reuse its number", () => {
  assert.match(migrations, /CORRECTED receipt|corrects_receipt_id/);
  assert.match(migrations, /replacement_of/);
  assert.match(cloudNow(), /CORRECTED RECEIPT — replaces/);
});

test("the project funding statement stays complete and labels pending entries", () => {
  assert.match(migrations, /acct_funding_statement/);
  assert.match(migrations, /Contains Entries Pending Internal Approval/);
  assert.match(cloudNow(), /acctFundingStatementPrint/);
});

test("granular multi-accountant permissions with role defaults and RLS-backed writes", () => {
  assert.match(migrations, /create table if not exists public\.acct_permissions/);
  assert.match(migrations, /acct_role_default_perms/);
  for (const perm of ["edit_own_unapproved", "edit_any_unapproved", "submit_review", "reopen_approved",
    "print_receipts", "reprint_receipts", "post_refunds", "export_working", "self_approve"]) {
    assert.ok(migrations.includes(perm), perm + " must exist in the permission engine");
  }
  assert.match(migrations, /self-approval requires an explicit permission|SELF-APPROVED under explicit permission/);
  assert.match(cloudNow(), /acctSavePerms/);
});

test("status indicators use text and icon in addition to color", () => {
  assert.match(core, /Pending Review/);
  assert.match(core, /Needs Correction/);
  assert.match(core, /icon: "✔"/);
  assert.match(core, /aggregateStatus/);
});

function cloudNow() { return readFileSync(new URL("../public/engines/accounting-cloud.js", import.meta.url), "utf8"); }

test("the accounting identity gate is usable: confirm mode prefills the signed-in email and only locks a filled field", () => {
  const access = readFileSync(new URL("../app/AccountAccess.tsx", import.meta.url), "utf8");
  assert.match(access, /mode === "reset" \|\| mode === "confirm" \? String\(currentUser\?\.email \|\| ""\) : ""/);
  assert.match(access, /readOnly=\{\(mode === "reset" \|\| mode === "confirm"\) && Boolean\(currentUser\?\.email\)\}/);
  // Username-only accounts (no mailbox) skip the accounting email gate entirely:
  assert.match(page, /sessionUserRef\.current\.email && accountingNeedsVerification/);
});
