/* Larsa Control — My Pay contract.
 *
 * The behavioural maths lives in tests/accounting-payroll-sql.test.sql, which
 * runs the real functions against a real Postgres. These pin the wiring the
 * SQL cannot see: that the screen exists inside the existing shell rather
 * than beside it, that it reads the authoritative store rather than the
 * browser blob, that a pending amount can never be dressed up as paid, and
 * that the six Home work-area cards were left alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const page = read("app/page.tsx");
const pass = read("app/visual-pass.css");
const cloud = read("public/engines/accounting-cloud.js");
const sql = readdirSync(new URL("../supabase/migrations", import.meta.url))
  .filter((f) => /^2026\d{4}_acct_/.test(f))
  .map((f) => read("supabase/migrations/" + f))
  .join("\n");
const payroll = read("supabase/migrations/20260803_acct_009_payroll.sql");

test("My Pay lives inside the existing shell, not beside it", () => {
  assert.match(page, /\|\s*"myPay"/);
  assert.match(page, /const MY_PAY_ITEM: Item = \{/);
  assert.match(page, /id: "my-pay"/);
  assert.match(page, /label: "My Pay"/);
  assert.match(page, /description: "Salary, commissions, and payment history"/);
  assert.match(page, /labelAr: "رواتبي ومستحقاتي"/);
  // Registered where every other item is registered, so navigation, deep
  // links and the permission editor all see it.
  assert.match(page, /PRESENCE_ITEM, MY_PAY_ITEM(?:, PAYROLL_PORTAL_ITEM)?\]/);
  assert.match(page, /active\.native === "myPay" \? "native active" : "native"/);
  assert.match(page, /<MyPay viewer=\{sessionUser\} active=\{active\.native === "myPay"\} \/>/);
  // It uses the shell's own header, sidebar and theme: no second shell.
  assert.ok(!/MyPay[\s\S]{0,4000}?signOut|MyPay[\s\S]{0,4000}?setDark\(/.test(page)
    || !/function MyPay\([\s\S]*?<header className="topbar"/.test(page),
    "My Pay must not build its own header, theme switch or sign-out");
});

test("the six Home work-area cards are untouched", () => {
  for (const title of ["Time & Attendance", "Performance", "Engineering Management",
    "HR & Skills", "Accounting", "Administration"]) {
    assert.ok(page.includes(`title: "${title}"`), title + " must remain a work-area card");
  }
  // My Pay is reachable without taking a row in the sidebar: a personal
  // control in the bar, a Home quick action, and an entry beside the portal
  // that produces it. Never a seventh large card, and never a nav row.
  assert.match(page, /"quick-clock",\s*"my-pay",/);
  assert.match(page, /className="theme pay-button"/);
  assert.match(page, /aria-label="My Pay — salary, commissions, and payment history"/);
  assert.match(page, /items: \["payroll-portal", "my-pay",/);
  assert.ok(!/title: "My Pay"/.test(page), "My Pay must not become a seventh work-area card");
  const homeGroup = /label: "Home",\s*\n\s*items: \[([\s\S]*?)\n  \},/.exec(page);
  assert.ok(homeGroup && !homeGroup[1].includes("my-pay"),
    "My Pay must not take a row in the sidebar");
});

test("your own pay is yours; anybody else's is a backend permission", () => {
  assert.match(page, /if \(item\.id === "my-pay"\) return true;/);
  // The screen never asks for another person's record.
  assert.match(page, /p_employee_email: null/);
  // And the server decides who the caller is allowed to resolve to.
  assert.match(payroll, /create or replace function public\.pay_resolve_subject/);
  assert.match(payroll, /if not public\.pay_can_view_all\(actor\) then\s*\n\s*--[\s\S]*?\n\s*return a_email;/);
  assert.match(payroll, /payroll_view_all/);
});

test("payroll tables cannot be read directly by any client", () => {
  // This is the whole privacy story: not a hidden screen, an absent grant.
  assert.match(payroll, /revoke all on public\.%I from anon, authenticated/);
  assert.ok(!/create policy "acct read" on public\.pay_/.test(payroll),
    "payroll tables must not get the permissive read policy the acct_ tables use");
  for (const table of ["pay_employees", "pay_periods", "pay_items", "pay_commissions", "pay_payments"]) {
    assert.ok(payroll.includes(`'${table}'`), table + " must be in the lockdown loop");
  }
  // Reading somebody else's pay is written down every time.
  assert.match(payroll, /'Employee Pay Viewed'/);
  assert.match(payroll, /'Payslip Downloaded'/);
});

test("a salary is a company expense exactly once", () => {
  // The link is a constraint, not an intention.
  assert.match(payroll, /create unique index if not exists pay_items_txn_uq/);
  // Approval posts only items that have no ledger entry yet.
  assert.match(payroll, /and status = 'approved' and txn_id is null/);
  assert.match(payroll, /and public\.pay_item_is_cost\(item_type\)/);
  // Deductions and advance repayments are not costs of their own.
  assert.match(payroll, /select p_type in \('base_salary','commission','bonus','allowance','reimbursement'\)/);
  // The cost lands on Larsa, never inside a client's fund control.
  assert.match(payroll, /'cost_bearer', 'larsa'/);
  assert.match(payroll, /'payment_source', 'Larsa Operating'/);
  // Pre-existing salary expenses are queued, never duplicated.
  assert.match(payroll, /create table if not exists public\.pay_mapping_queue/);
  assert.match(payroll, /not exists \(select 1 from public\.pay_items i where i\.txn_id = t\.id\)/);
});

test("separation of duties is enforced on both axes", () => {
  assert.match(payroll, /you submitted % — a different authorised user must approve it/);
  assert.match(payroll, /includes your own pay — a different authorised user must approve it/);
  assert.match(payroll, /is your own commission — a different authorised user must decide it/);
  // A Payroll Accountant prepares and pays, and cannot approve.
  const role = /when p_role = 'Payroll Accountant' then([\s\S]*?)when p_role in \('Project Manager'/.exec(payroll);
  assert.ok(role, "the Payroll Accountant role must still be defined");
  // The granted array, not the comment above it.
  const granted = /array\[([\s\S]*?)\]/.exec(role[1])[1];
  assert.ok(granted.includes("payroll_manage") && granted.includes("payroll_pay"));
  assert.ok(!granted.includes("payroll_approve"), "a Payroll Accountant must not approve payroll");
  // Managers and engineers get nothing by default.
  assert.match(payroll, /when p_role in \('Project Manager','Construction Engineer'\) then\s*\n\s*array\['view'\]/);
});

test("a pending amount is never presented as paid", () => {
  // Separate totals, separate cards, and the words to go with them.
  assert.match(payroll, /'pending_commission_iqd', pend_row\.pending_iqd/);
  assert.match(payroll, /'approved_commission_iqd', pend_row\.approved_iqd/);
  assert.match(page, /label="Pending commissions"[\s\S]*?tone="pending"/);
  assert.match(page, /Not yet approved — not money you have been paid\./);
  assert.match(page, /label="Approved, not yet paid"/);
  // The payslip refuses to imply a completed payment.
  assert.match(payroll, /'payment_state', case when paid_iqd <= 0 then 'approved_unpaid'/);
  assert.match(page, /"Approved — Not Yet Paid"/);
  // Only published runs reach an employee at all.
  assert.match(payroll, /where p\.published_at is not null/);
});

test("status is never colour alone", () => {
  assert.match(page, /const PAY_STATUS: Record<string, \{ label: string; tone: string; icon: LucideIcon \}>/);
  // The chip carries the icon and the words together, not a bare colour.
  assert.match(page, /const Icon = payStatus\(latestStatus\)\.icon; return <Icon size=\{14\} \/>;/);
  assert.match(page, /\{payStatus\(latestStatus\)\.label\}/);
  assert.match(page, /<span className=\{`pay-status is-\$\{meta\.tone\}`\}><Icon size=\{13\} \/>\{meta\.label\}<\/span>/);
  for (const tone of ["is-paid", "is-approved", "is-pending", "is-partial", "is-rejected", "is-draft"]) {
    assert.ok(pass.includes(`.pay-status.${tone}`), tone + " needs a defined treatment");
    assert.ok(pass.includes(`.unified-app.dark .pay-status.${tone}`), tone + " needs a night treatment");
  }
});

test("currencies are reported apart, never added", () => {
  assert.match(payroll, /by_cur := by_cur \|\| jsonb_build_object\(cur_row\.cur/);
  assert.match(page, /shown separately, never added together/);
  // Every amount keeps the rate that produced it.
  for (const column of ["exchange_rate", "rate_direction", "rate_date", "rate_source", "amount_iqd", "amount_usd"]) {
    assert.ok(payroll.includes(column), column + " must be snapshotted on payroll rows");
  }
  assert.match(payroll, /rate_direction    text not null default 'USD_TO_IQD'/);
  // And a commission keeps the rule that produced it.
  assert.match(payroll, /rule_snapshot     jsonb not null default '\{\}'::jsonb/);
});

test("the period filters exist and are driven by the employment start date", () => {
  for (const label of ["This month", "Last month", "Last 3 months", "Last 6 months",
    "Year to date", "This calendar year", "Since joining Larsa", "All history", "Custom range"]) {
    assert.ok(page.includes(`label: "${label}"`), label + " must be offered");
  }
  assert.match(page, /case "joining": return \{ from: joined \|\| null/);
  // A missing start date opens the range rather than guessing one.
  assert.match(payroll, /Employment start date is not recorded — showing all available payroll history\./);
  assert.match(payroll, /create table if not exists public\.pay_hr_queue/);
  assert.match(payroll, /'employment_start_missing'/);
});

test("charts are honest and degrade to a real empty state", () => {
  // The stack shows components; the total is never stacked with its parts.
  assert.match(page, /Monthly earnings, by component/);
  assert.match(page, /Net earnings trend/);
  assert.match(page, /Paid against approved/);
  assert.match(page, /Nothing to chart for this period yet/);
  assert.match(page, /role="img"\s*\n?\s*aria-label=/);
  for (const cls of ["i.is-base", "i.is-comm", "i.is-bonus", "i.is-net", "i.is-paid", "i.is-due"]) {
    assert.ok(pass.includes(cls), cls + " needs a colour");
    assert.ok(pass.includes(`.unified-app.dark ${cls}`), cls + " needs a night colour");
  }
});

test("the payslip is a document, not a screenshot of the app", () => {
  assert.match(page, /id="larsa-payslip"/);
  assert.match(page, /src="\/icons\/larsa-logo\.svg"/);
  for (const field of ["Employee ID", "Position", "Department", "Pay period", "Payment date",
    "Gross earnings", "Net pay", "Amount paid", "Outstanding", "Approved by"]) {
    assert.ok(page.includes(field), "the payslip needs " + field);
  }
  // Account details are masked before they leave the server.
  assert.match(payroll, /repeat\('•', greatest\(length\(emp\.payment_ref\) - 4, 0\)\) \|\| right\(emp\.payment_ref, 4\)/);
  assert.match(page, /payment_ref_masked/);
  // Internal notes never reach it.
  assert.ok(!/slip[\s\S]{0,200}?\bnote\b/.test(/function PaySlip[\s\S]*?^}/m.exec(page)?.[0] || ""),
    "internal notes must not appear on a payslip");
  // It prints white, on A4, without the app around it.
  assert.match(pass, /@media print \{[\s\S]*?\.pay-slip \{ border: 0; padding: 0; \}/);
  assert.match(pass, /@page \{ size: A4; margin: 14mm; \}/);
  // A later download reproduces the same figures: they are stored, not recomputed.
  assert.match(payroll, /select coalesce\(jsonb_agg\(jsonb_build_object\(\s*\n\s*'item_type', i\.item_type/);
});

test("the accountant side writes to the same store", () => {
  assert.match(cloud, /var PAY = \{ on: false/);
  assert.match(cloud, /rpc\("pay_admin_overview"/);
  assert.match(cloud, /rpc\("pay_upsert_employee"/);
  assert.match(cloud, /rpc\("pay_open_period"/);
  assert.match(cloud, /rpc\("pay_add_item"/);
  assert.match(cloud, /rpc\("pay_record_commission"/);
  assert.match(cloud, /rpc\("pay_link_transaction"/);
  // Re-saving a row updates rather than duplicates.
  assert.match(cloud, /if \(row\.serverPeriodId\) \{ if \(done\) done\(null\); return; \}/);
  assert.match(cloud, /if \(row\.serverCommissionId\) \{ if \(done\) done\(null\); return; \}/);
  // Components are sent apart, not pre-summed into one figure.
  assert.match(cloud, /\["base_salary",[\s\S]*?\["bonus",[\s\S]*?\["allowance",[\s\S]*?\["deduction",[\s\S]*?\["reimbursement",/);
  // The mapping queue is wired into the payroll screen.
  assert.match(cloud, /function payMappingCardHTML/);
  assert.match(cloud, /window\.acctPayMap = function/);
  assert.match(cloud, /wrapPayrollSave\(\);\s*\n\s*wrapPayrollView\(\);/);
});

test("nothing that already existed was taken away", () => {
  // The migration is additive: no drops of the tables, columns or functions
  // the rest of the system depends on.
  assert.ok(!/drop table/i.test(payroll), "no table may be dropped");
  assert.ok(!/drop column/i.test(payroll), "no column may be dropped");
  assert.ok(!/drop function/i.test(payroll), "no function may be dropped");
  assert.ok(!/truncate/i.test(payroll), "nothing may be truncated");
  assert.ok(!/delete from public\.acct_/i.test(payroll), "no accounting row may be deleted");
  // The two functions it replaces are replaced with supersets.
  assert.match(payroll, /create or replace function public\.acct_role_default_perms/);
  assert.match(payroll, /create or replace function public\.acct_get_my_permissions/);
  assert.match(payroll, /\|\| public\.pay_permission_keys\(\)/);
  // The existing accounting suites still describe the same system.
  assert.match(sql, /create table if not exists public\.acct_transactions/);
  assert.match(sql, /create table if not exists public\.acct_audit/);
});

test("My Pay is responsive and readable at night", () => {
  assert.match(pass, /@media \(max-width: 760px\) \{[\s\S]*?\.pay-period-head \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(pass, /\.pay-cards \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(178px, 1fr\)\)/);
  assert.match(pass, /\.unified-app\.dark \.pay-range button\.is-on/);
  assert.match(pass, /\.unified-app\.dark \.pay-card\.is-good b/);
  // Cards use the same rounding tokens as the rest of the app.
  assert.match(pass, /\.pay-card \{[\s\S]*?border-radius: var\(--radius-tile\)/);
  assert.match(pass, /\.pay-period \{ border: 1px solid var\(--line\); border-radius: var\(--radius-panel\)/);
});

test("pay notifications exist and never leak a figure", () => {
  for (const id of ["pay.published", "pay.paid", "pay.commission"]) {
    assert.ok(page.includes(`id: "${id}"`), id + " must be in the notification catalogue");
  }
  assert.match(page, /function announcePayChanges/);
  assert.match(page, /itemId: "my-pay"/);
  // The body says what happened, never how much.
  const bodies = [...page.matchAll(/raise\("pay\.[a-z]+", "[^"]+", `([^`]+)`\)/g)].map((m) => m[1]);
  assert.ok(bodies.length >= 3, "each pay event needs a message");
  for (const body of bodies) {
    assert.ok(!/\$\{[^}]*(?:iqd|usd|amount|net|paid_)/i.test(body),
      "a notification preview must not carry a salary figure: " + body);
  }
  // It only speaks about a change it has not already announced.
  assert.match(page, /const PAY_SEEN_KEY = "larsa-control-pay-seen";/);
  assert.match(page, /if \(seen\[key\] === stamp\)/);
});

test("Payroll & People is one portal over the same records", () => {
  const portal = read("supabase/migrations/20260803_acct_010_payroll_portal.sql");
  // One screen, in the accounting channel, behind the payroll permission.
  assert.match(page, /\| "payrollPortal";/);
  assert.match(page, /const PAYROLL_PORTAL_ITEM: Item = \{/);
  assert.match(page, /id: "payroll-portal"/);
  assert.match(page, /labelAr: "الرواتب والموظفون"/);
  assert.match(page, /active\.native === "payrollPortal" \? "native active" : "native"/);
  assert.match(page, /if \(item\.id === "sales-commissions" \|\| item\.id === "payroll-portal"\) return "accounting";/);
  // It leads the Payroll & People group; the older entries stay reachable.
  assert.match(page, /items: \["payroll-portal", "my-pay", "acc-payroll", "sales-commissions", "acc-employees", "acc-refs"\]/);

  // The whole cycle is on one page, in the order the work happens.
  for (const action of ["pay_open_period", "pay_add_item", "pay_submit_period", "pay_decide_period",
    "pay_publish_period", "pay_record_payment", "pay_reverse_payment", "pay_upsert_employee",
    "pay_decide_commission", "pay_schedule_commission", "pay_link_transaction", "pay_scan_unlinked_salary"]) {
    assert.ok(page.includes(`"${action}"`), "the portal must be able to " + action);
  }
  assert.match(page, /Submit for approval/);
  assert.match(page, /Publish payslips/);
  assert.match(page, /Visible in My Pay/);

  // Same store as My Pay — the portal reads a detail view of the same rows.
  assert.match(portal, /create or replace function public\.pay_period_detail/);
  assert.match(portal, /perform public\.acct_check_perm\(actor, 'payroll_view_all'\)/);
  // Currencies stay apart in a run too.
  assert.match(portal, /by_cur := by_cur \|\| jsonb_build_object\(cur_row\.cur/);
  assert.match(page, /reported apart, never added/);
  // The one-entry rule is visible on screen, not just enforced underneath.
  assert.match(portal, /'posted_items', count\(\*\) filter \(where i\.txn_id is not null\)/);
  assert.match(page, /\{line\.posted_items\} posted/);
  // Additive: 010 changes nothing from 009.
  assert.ok(!/drop (table|function|column)/i.test(portal), "010 must not drop anything");
});
