/* Contract tests for the v4.0 accounting upgrade — source-level assertions in
 * the same style as v10-features.test.mjs. They pin the wiring: the engine
 * loads the new layers, the migrations define the authoritative schema, the
 * dangerous legacy behaviors are governed, and the service worker ships the
 * new files. The behavioral maths is covered by tests/accounting-core.test.mjs
 * (browser core) and tests/accounting-sql.test.sql (authoritative backend). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

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

test("dual control: new entries land as Pending Approval, never self-approved on entry", () => {
  assert.match(migrations, /create or replace function public\.acct_internal_op/);
  assert.match(migrations, /st := 'pending';\s*\n\s*forced_pending := true;/);
  assert.match(migrations, /'requested_status', requested_st, 'approval_policy', 'maker_checker'/);
  assert.match(migrations, /'entered_pending', forced_pending/);
  // Approval is a separate act by a different user holding 'approve':
  assert.match(migrations, /perform public\.acct_check_perm\(actor, 'approve'\);\s*\n\s*perform public\.acct_check_approver_scope/);
  assert.match(migrations, /ACCT_APPROVAL: you entered %/);
  const cloud = cloudNow();
  assert.match(cloud, /entered_pending/);
  assert.match(cloud, /Saved as PENDING APPROVAL/);
  assert.match(cloud, /acct_mkchk_hint/);
  assert.match(cloud, /pending: "Pending Approval"/);
});

test("dual control: approvers are assignable per area and per project; accountants per project", () => {
  assert.match(migrations, /add column if not exists area_approvers jsonb not null default '\{\}'::jsonb/);
  assert.match(migrations, /add column if not exists assigned_accountants jsonb not null default '\[\]'::jsonb/);
  assert.match(migrations, /add column if not exists assigned_approvers\s+jsonb not null default '\[\]'::jsonb/);
  assert.match(migrations, /acct_check_entry_scope/);
  assert.match(migrations, /acct_approver_scope_ok/);
  assert.match(migrations, /data entry for project "%" is assigned to/);
  assert.match(migrations, /approval for project "%" is assigned to/);
  assert.match(migrations, /approval for the % area is assigned to/);
  // All six areas are assignable, and assignment narrows but never grants:
  for (const kind of ["funding", "material", "labor", "expense", "revenue", "adjustment"]) {
    assert.ok(migrations.includes(`'${kind}'`), kind + " must be an assignable area");
  }
  const cloud = cloudNow();
  assert.match(cloud, /acct_prj_accountants/);
  assert.match(cloud, /acct_prj_approvers/);
  assert.match(cloud, /acct_area_/);   // per-area approver picker
  assert.match(cloud, /approverScope\(/);
  assert.match(cloud, /entryScopeOk\(/);
});

test("dual control: internal dual-controlled flows stay exempt via a transaction-local flag", () => {
  const decides = migrations.split("acct_decide_approval(").length - 1;
  assert.ok(decides >= 2, "acct_decide_approval must be redefined in 007");
  assert.match(migrations, /perform set_config\('acct\.internal_op', '1', true\);/);
  assert.match(migrations, /not public\.acct_internal_op\(\)/);
});

/* ============================================================
   Corrective pass: the construction accounting model, currency
   safety, approved/working totals, one authoritative source,
   the approval queue, the receipt, and production hygiene.
   ============================================================ */

test("client construction funding is never Larsa revenue or company profit", () => {
  // Backend: the two blocks exist and are computed from different inputs.
  assert.match(migrations, /create or replace function public\.acct_project_financials/);
  assert.match(migrations, /'client_funds', jsonb_build_object/);
  assert.match(migrations, /'company', jsonb_build_object/);
  assert.match(migrations, /larsa_rev_iqd := fee_all_iqd \+ eng_iqd \+ oth_rev_iqd/);
  assert.match(migrations, /co_net_iqd := larsa_rev_iqd - co_exp_iqd/);
  // Contractor accounting exists but only when explicitly selected.
  assert.match(migrations, /accounting_mode text not null default 'client_funded'/);
  assert.match(migrations, /check \(accounting_mode in \('client_funded','contractor'\)\)/);
  // A cost is the client's unless it says otherwise.
  assert.match(migrations, /acct_cost_bearer/);
  assert.match(migrations, /else 'client'/);
  // App shell: the old income = funding + fees + revenue is gone.
  assert.ok(!/const income = funding \+ fees \+ revenue/.test(page),
    "the app shell must not add client funding into income");
  assert.ok(!/net = income - cost/.test(page),
    "company profit must never be funding minus construction spending");
  assert.match(page, /const larsaRevenue = fees \+ revenue/);
  assert.match(page, /const companyNet = larsaRevenue - companyExpenses/);
  assert.match(page, /Client fund control/);
  assert.match(page, /Larsa company accounting/);
});

test("USD and IQD are never added, and exchange rates are never summed", () => {
  // The injected ledger totals row groups by currency and skips rate columns.
  assert.match(page, /larsaIsRateCol/);
  assert.match(page, /Exchange rates are per entry and are never added together/);
  assert.match(page, /larsaCur\s*=\s*function/);
  assert.match(page, /Currencies are totalled separately and never added together/);
  assert.ok(!/td\.textContent=larsaFmt\(sums\[index\]\)\s*;/.test(page),
    "the old single-currency total must be gone");
  // Backend keeps original-currency totals apart and converts at snapshots.
  assert.match(migrations, /'by_currency', by_cur/);
  assert.match(migrations, /gross_funding_approved/);
  assert.match(migrations, /never added/i);
});

test("approved and working totals are both reported, with a reason in words", () => {
  assert.match(migrations, /'approved', jsonb_build_object/);
  assert.match(migrations, /'working', jsonb_build_object/);
  assert.match(migrations, /'pending', jsonb_build_object/);
  assert.match(migrations, /Contains ' \|\| unapproved_count \|\| ' unapproved entr/);
  assert.match(migrations, /when needs_correction_count > 0 then 'red'/);
  assert.match(migrations, /when unapproved_count > 0 then 'yellow'/);
  const cloud = cloudNow();
  assert.match(cloud, /Approved Actual Cost/);
  assert.match(cloud, /Pending \/ Unapproved Cost/);
  assert.match(cloud, /Working Actual Cost/);
  assert.match(cloud, /Approved Remaining Client Balance/);
  assert.match(cloud, /Working Remaining Client Balance/);
  // Status is never colour alone.
  assert.match(cloud, /reliabilityBanner/);
  assert.match(cloud, /✔|⏳|✖/);
});

test("one authoritative calculation feeds every accounting surface", () => {
  // The long-standing summary is now a projection of the authoritative model.
  assert.match(migrations, /with f as \(select public\.acct_project_financials\(p_project_id\) as j\)/);
  assert.match(migrations, /acct_company_financials/);
  const cloud = cloudNow();
  // The engine's own totals read the server figures.
  assert.match(cloud, /window\.xTotals = function/);
  assert.match(cloud, /window\.totals = function/);
  assert.match(cloud, /_authoritative: true/);
  // The client statement is rebuilt from the same model.
  assert.match(cloud, /acctClientStatement/);
  assert.match(cloud, /Approved spending/);
  assert.match(cloud, /Working spending/);
  assert.match(cloud, /wrapClientStatement/);
  // The Construction Financials page reads the same backend function.
  assert.match(page, /acct_company_financials/);
  assert.match(page, /fromServerRow/);
});

test("consultancy fee has one source of truth and no duplicate zero field", () => {
  const cloud = cloudNow();
  assert.match(cloud, /wrapFundingSchema/);
  assert.match(cloud, /f\.k !== "consultancyRate"/);
  assert.match(cloud, /Effective rate/);
  assert.match(cloud, /Rule source/);
  assert.match(cloud, /Fee basis/);
  assert.match(cloud, /Accounting treatment/);
  assert.match(cloud, /acct_fee_amt/);
  assert.match(cloud, /acct_fee_net/);
  // Lifecycle stages stay distinct and projected is never called final.
  assert.match(migrations, /'initial_accrued_iqd'/);
  assert.match(migrations, /'estimated_refundable_iqd'/);
  assert.match(migrations, /'refunded_to_date_iqd'/);
  assert.match(migrations, /'current_recognised_iqd'/);
  assert.match(migrations, /'projected_after_full_refund_iqd'/);
  assert.match(migrations, /'final_settled_iqd'/);
  assert.match(migrations, /'is_final', settlements_executed|'is_final', settled_count > 0/);
});

test("a real Accounting Approval Queue exists beside the renamed risk queue", () => {
  assert.match(migrations, /create or replace function public\.acct_approval_queue/);
  for (const source of ["entries", "refunds", "protected"]) {
    assert.ok(migrations.includes(source + " as ("), source + " must feed the queue");
  }
  // Exactly one outstanding action per record.
  assert.match(migrations, /then 'approve_entry' else 'review_entry' end as action/);
  const cloud = cloudNow();
  assert.match(cloud, /Accounting Approval Queue/);
  assert.match(cloud, /Flags \/ Risk Reviews/);
  assert.match(cloud, /acctQueueFilter/);
  // Filterable by project, type, accountant, approver, age and status.
  const queueFilters = /var QF = \{([^}]*)\}/.exec(cloud);
  assert.ok(queueFilters, "the queue must declare its filter state");
  for (const filter of ["project", "kind", "accountant", "approver", "age", "status"]) {
    assert.ok(queueFilters[1].includes(filter + ":"), "queue must filter by " + filter);
  }
  // Self-approval stays blocked by default in the queue's own actions.
  assert.match(cloud, /You entered this/);
});

test("the funding receipt is a Larsa statement with the official logo", () => {
  const cloud = cloudNow();
  assert.match(cloud, /\/icons\/larsa-logo\.svg/);
  assert.ok(existsSync(new URL("../public/icons/larsa-logo.svg", import.meta.url)),
    "the official logo asset must exist in the repository");
  assert.match(cloud, /rc-logo/);
  assert.match(cloud, /Funding Receipt/);
  assert.match(cloud, /وصل استلام تمويل/);
  // Sectioned document, not one long table.
  for (const section of ["Document", "Client & Project", "Payment", "Amount",
    "Currency & Exchange Rate", "Amount in Words", "Handled By", "Notes & Verification"]) {
    assert.ok(cloud.includes(section), "receipt needs a " + section + " section");
  }
  assert.match(cloud, /@page\{size:A4/);
  assert.match(cloud, /rc-signs/);
  assert.match(cloud, /rc-stamp/);
  // Unapproved receipts are watermarked; the number never changes.
  assert.match(cloud, /rc-wm/);
  assert.match(cloud, /PENDING REVIEW · بانتظار المراجعة/);
  assert.match(cloud, /REPRINT — original receipt number preserved/);
  // Language + direction.
  assert.match(cloud, /receiptLang/);
  assert.match(cloud, /dir="' \+ dir \+ '"/);
});

test("legacy local-prototype settings cannot confuse or replace production data", () => {
  assert.match(page, /window\.__larsaProductionMode=true/);
  const cloud = cloudNow();
  assert.match(cloud, /stripLegacySettings/);
  assert.match(cloud, /supabase\\s\*sync/i);
  assert.match(cloud, /v35PullStateFromSupabase/);
  assert.match(cloud, /audit\\s\*trail/i);
  // Direct engine access never impersonates the production portal.
  assert.match(cloud, /direct-access guard/);
  assert.match(cloud, /window\.location\.replace\(target\)/);
  assert.match(cloud, /ISOLATED DEMO — not production/);
});

test("the permanent history is browsable and sample data is marked", () => {
  assert.match(migrations, /create or replace function public\.acct_audit_page/);
  assert.match(migrations, /'changed_fields'/);
  assert.match(migrations, /p_search/);
  const cloud = cloudNow();
  assert.match(cloud, /Permanent Accounting History/);
  assert.match(cloud, /acctHistFilter/);
  assert.match(cloud, /acctHistPage/);
  assert.match(cloud, /sampleBadge/);
  assert.match(cloud, /SAMPLE/);
  // Removal stays a single protected action that never reseeds.
  assert.match(cloud, /acctRemoveSamples/);
  assert.match(migrations, /never seeded again|sample_state = 'removed'|sample data is never seeded again/i);
});

test("the service worker ships the corrected engine and the logo", () => {
  /* Pinning one exact version made this fail on the next release that had to
     bump it, which is the opposite of what it is guarding. What matters is
     that the cache name is at or past the release that shipped the corrected
     engine, so an older cached copy cannot survive. */
  const version = /larsa-control-v(\d+)/.exec(sw);
  assert.ok(version && Number(version[1]) >= 17,
    "the service worker cache must be at or past v17");
  assert.match(sw, /\/icons\/larsa-logo\.svg/);
});

test("assigning accountants and approvers picks real accounts from a dropdown", () => {
  const cloud = cloudNow();
  // A roster is built from the signed-in staff list, with sane fallbacks.
  assert.match(cloud, /function acctRoster\(\)/);
  assert.match(cloud, /window\.__larsaAccountingRoster/);
  assert.match(cloud, /state\.users/);
  // The pickers are real selects, not free-text email boxes.
  assert.match(cloud, /function rosterPicker\(/);
  assert.match(cloud, /<details class="acct-dd"/);   // a dropdown, not a text box
  assert.match(cloud, /function readPicker\(/);
  assert.match(cloud, /rosterPicker\("acct_prj_accountants"/);
  assert.match(cloud, /rosterPicker\("acct_prj_approvers"/);
  assert.match(cloud, /rosterPicker\("acct_area_"/);
  assert.ok(!/id="acct_prj_accountants" placeholder/.test(cloud),
    "the assigned-accountants field must no longer be a typed email box");
  assert.ok(!/class="acct-area-approver"/.test(cloud),
    "area approvers must no longer be typed email boxes");
  // Choosing who to grant permissions to is also a person picker.
  assert.match(cloud, /Choose a person…/);
  // An existing assignment stays selectable even if the person left the roster.
  assert.match(cloud, /never silently dropped/);
  // The parent hands over the roster with email, name and accounting role.
  assert.match(page, /const accountingRoster = readStaffUsers\(\)/);
  assert.match(page, /role: accountingRole\(person\)/);
  assert.match(page, /window\.__larsaAccountingRoster=/);
});

test("a project page is a full workspace: add funding or any cost without leaving it", () => {
  const cloud = cloudNow();
  assert.match(cloud, /projectWorkspaceHTML/);
  assert.match(cloud, /Record in this project/);
  // Every ledger you can record into is present on the project page.
  const kinds = /var WORKSPACE_KINDS = \[([\s\S]*?)\n  \];/.exec(cloud);
  assert.ok(kinds, "the workspace must declare its ledgers");
  for (const coll of ["funding", "materials", "projectLabor", "expenses", "revenue"]) {
    assert.ok(kinds[1].includes(`coll: "${coll}"`), "workspace must include " + coll);
  }
  assert.match(cloud, /acctAddHere/);
  // Entries stay locked to the project and come back to the same page.
  assert.match(cloud, /addLinked310/);
  assert.match(cloud, /__larsaReturnProjectTab = "summary"/);
  // The engine's own tables are reused, so row actions, review chips and
  // receipt buttons all work inline.
  assert.match(cloud, /xExpenseTable/);
  assert.match(cloud, /xMaterialTable/);
  assert.match(cloud, /xLaborTable/);
  assert.match(cloud, /workspaceTable/);
});

test("the project form is simplified and keeps every stored value", () => {
  const cloud = cloudNow();
  assert.match(cloud, /function wrapProjectSchema/);
  const off = /var PROJECT_FIELDS_OFF = \[([\s\S]*?)\];/.exec(cloud);
  assert.ok(off, "the trimmed fields must be declared in one place");
  for (const field of ["code", "priority", "country", "teamLeader",
    "clickUpLink", "invoiceLink", "consultancyRate"]) {
    assert.ok(off[1].includes(`"${field}"`), field + " must be off the project form");
  }
  // Region survives — it is what the whole system runs on.
  assert.ok(!off[1].includes('"region"'), "region must stay on the form");
  // The responsible engineer and project manager stay; only team leader goes.
  assert.ok(!off[1].includes('"responsibleEngineer"'));
  assert.ok(!off[1].includes('"projectManager"'));
  // Nothing stored is deleted: the form is filtered, records are untouched.
  assert.match(cloud, /SCHEMA\.projects = SCHEMA\.projects\.filter/);
  assert.ok(!/delete .*\.priority|delete .*\.teamLeader/.test(cloud),
    "trimming the form must never delete stored values");
  // Documents still carry a project reference.
  assert.match(cloud, /function derivedProjectCode/);
  assert.match(cloud, /code: rec\.code \|\| derivedProjectCode/);
});

test("assigning people is a dropdown — many people, no modifier keys", () => {
  const cloud = cloudNow();
  /* Closed it is one line saying who is assigned; open it is tick boxes, so a
     second name is an ordinary click rather than a Ctrl/Cmd-click. */
  assert.match(cloud, /<details class="acct-dd"/);
  assert.match(cloud, /<summary class="acct-dd-head">/);
  assert.match(cloud, /type="checkbox" class="acct-person"/);
  assert.match(cloud, /function pickerSummary\(/);
  // The closed summary keeps up as boxes are ticked.
  assert.match(cloud, /function syncPickerLabel\(/);
  assert.match(cloud, /function watchPickers\(/);
  assert.match(cloud, /pickerStyles\(\);\s*\n\s*watchPickers\(\);/);
  // Nobody chosen still means anyone holding the permission.
  assert.match(cloud, /Anyone with the permission/);
  // The long instructions under every picker are gone.
  assert.ok(!/Tick everyone who should be assigned/.test(cloud),
    "the per-picker instructions should not be restated under each control");
  // Reading it back collects every ticked person.
  assert.match(cloud, /querySelectorAll\("\.acct-person"\)/);
  assert.match(cloud, /\.filter\(function \(b\) \{ return b\.checked; \}\)/);
  // Still used for both project roles and every accounting area.
  assert.match(cloud, /rosterPicker\("acct_prj_accountants"/);
  assert.match(cloud, /rosterPicker\("acct_prj_approvers"/);
  assert.match(cloud, /rosterPicker\("acct_area_"/);
});
