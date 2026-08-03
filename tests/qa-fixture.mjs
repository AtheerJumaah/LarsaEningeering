/* ============================================================
 * "Larsa Functional QA" — the isolated QA fixture.
 *
 * Every record here is marked: ids start with zz-qa-, names start
 * with "QA ", emails end in @larsaeng.test, and engine rows carry
 * isTest: true. Nothing in this file ever touches production data:
 * the fixture is seeded into localStorage inside throwaway Playwright
 * browser contexts against a local dev server, and into a throwaway
 * PostgreSQL cluster for the SQL checks. The production database and
 * the real larsaeng.app records are never written.
 *
 * The numbers are the controlled examples from the QA specification:
 *   - 09:00–17:00 must read 8.00 h in every view
 *   - 22:00–02:00 crosses midnight and must land 2 h + 2 h
 *   - a 48 h open session is stale: flagged, never auto-closed,
 *     never silently included in totals
 *   - performance: draft 5 / submitted 10 / approved 15 / returned 8 /
 *     rejected 12 → official score 15, progress 15 of 50 = 30%
 *   - project: budget 120,000,000 · funding 100,000,000 · fee 8% =
 *     8,000,000 · materials 20,000,000 · labor 10,000,000 · pending
 *     5,000,000 → net funding 92,000,000 · actual 30,000,000 ·
 *     used 38,000,000 · remaining 62,000,000 · progress 25%
 *   - USD history: 1,000 @ 1500 + 1,000 @ 1600 → $2,000 / IQD 3,100,000
 *   - payroll: 2,000,000 + 500,000 + 200,000 − 100,000 →
 *     gross 2,700,000 · net 2,600,000
 * ============================================================ */

export const QA_PASSWORD = "QA-fixture-2026!";
export const QA_PIN = "7431";

/* The ten roles the audit exercises. `access` is the shell's role preset. */
export const QA_USERS = [
  { id: "zz-qa-super", name: "QA Super Admin", email: "qa.super@larsaeng.test", access: "Super Admin", role: "Super Admin" },
  { id: "zz-qa-admin", name: "QA Org Admin", email: "qa.admin@larsaeng.test", access: "Admin", role: "Organization Admin" },
  { id: "zz-qa-acct", name: "QA Accountant", email: "qa.accountant@larsaeng.test", access: "Accountant", role: "Accountant" },
  { id: "zz-qa-payadm", name: "QA Payroll Admin", email: "qa.payroll@larsaeng.test", access: "Admin HR", role: "Payroll Admin" },
  { id: "zz-qa-hr", name: "QA HR Admin", email: "qa.hr@larsaeng.test", access: "Admin HR", role: "HR Admin" },
  { id: "zz-qa-mgr", name: "QA Manager", email: "qa.manager@larsaeng.test", access: "Manager", role: "Manager" },
  { id: "zz-qa-pm", name: "QA Project Manager", email: "qa.pm@larsaeng.test", access: "Team Leader", role: "Project Manager" },
  { id: "zz-qa-emp", name: "QA Employee One", email: "qa.employee@larsaeng.test", access: "Engineer", role: "Engineer", manager: "QA Manager", pin: QA_PIN },
  { id: "zz-qa-view", name: "QA Read Only", email: "qa.viewer@larsaeng.test", access: "Viewer", role: "Viewer" },
  { id: "zz-qa-nopay", name: "QA NoPayroll", access: "Intern", role: "Intern" },
  /* Scenario-isolation accounts, one per attendance edge case so the
     controlled numbers never contaminate each other. */
  { id: "zz-qa-stale", name: "QA Stale Session", email: "qa.stale@larsaeng.test", access: "Engineer", role: "Engineer" },
  { id: "zz-qa-dupe", name: "QA Duplicate Punch", email: "qa.dupe@larsaeng.test", access: "Engineer", role: "Engineer" },
  { id: "zz-qa-year", name: "QA Year Boundary", email: "qa.year@larsaeng.test", access: "Engineer", role: "Engineer" },
  { id: "zz-qa-early", name: "QA Early Bird", email: "qa.early@larsaeng.test", access: "Engineer", role: "Engineer" },
];

/* Runs INSIDE the page (addInitScript), before the shell boots, so all
 * wall-clock times are built in the browser context's own timezone —
 * the same clock the person filing 09:00–17:00 would be on. */
export function qaSeedShell(cfg) {
  const iso = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0).toISOString();
  /* Per-role permission profiles, mirroring presetPermissionProfile in the
   * shell so the QA accounts walk the same permission path as accounts
   * created through the Access screen. */
  const FULL = ["view", "add", "edit", "delete", "approve", "export", "manage"];
  const VE = ["view", "export"];
  const BASIC = ["view", "add", "edit"];
  const ACC_EDIT = ["view", "add", "edit", "approve", "export"];
  const ACC_ALL = ["acc-dashboard", "acc-funding", "acc-expenses", "acc-materials", "acc-labor", "acc-clients", "acc-projects", "acc-boq", "acc-refs", "acc-reports", "acc-review", "acc-payroll", "acc-employees"];
  const profile = (preset, scope, pairs) => ({
    version: 1, preset, scope,
    grants: Object.fromEntries(pairs.map(([id, actions]) => [
      id, Object.fromEntries([...new Set(["view", ...actions])].map((a) => [a, true])),
    ])),
  });
  const STAFF_FULL = ["staff-dashboard", "staff-clock", "staff-live", "staff-schedule", "staff-performance", "staff-performance-review", "staff-performance-targets", "performance-center", "staff-development", "performance-history", "staff-timesheet", "staff-approvals", "staff-reports"];
  const PROFILES = {
    "Super Admin": profile("Super Admin", "company", []),
    Admin: profile("Admin", "company", [
      ["access", FULL], ["staff-people", FULL], ["staff-rules", FULL], ["staff-backup", FULL],
      ["admin-notifications", FULL], ["data", FULL], ["staff-dashboard", FULL],
      ["staff-approvals", ["view", "approve", "manage"]], ["performance-center", VE],
      ["staff-development", FULL], ["performance-history", VE], ["hr-dashboard", VE],
      ["hr-people", FULL], ["hr-matrix", FULL], ["hr-reports", VE],
    ]),
    Manager: profile("Manager", "company", [
      ...STAFF_FULL.map((id) => [id, FULL]),
      ["hr-dashboard", VE], ["hr-people", VE], ["hr-matrix", VE], ["hr-reports", VE],
      ...ACC_ALL.map((id) => [id, ["view", "approve", "export"]]),
      ["construction-financials", ["view", "approve", "export"]], ["project-portal", ["view", "approve", "export"]],
    ]),
    Accountant: profile("Accountant", "department", [
      ...ACC_ALL.map((id) => [id, ACC_EDIT]),
      ["construction-financials", ACC_EDIT], ["project-portal", ACC_EDIT],
      ["staff-clock", BASIC], ["staff-live", BASIC], ["staff-schedule", BASIC],
      ["staff-performance", BASIC], ["staff-timesheet", VE],
    ]),
    "Admin HR": profile("Admin HR", "department", [
      ["hr-dashboard", FULL], ["hr-people", FULL], ["hr-matrix", FULL], ["hr-reports", FULL],
      ["access", FULL], ["staff-people", FULL], ["staff-rules", FULL], ["admin-notifications", FULL],
      ["staff-approvals", ["view", "approve", "manage"]], ["staff-dashboard", FULL],
      ["staff-clock", BASIC], ["staff-live", FULL], ["staff-schedule", ["view", "add", "edit", "approve"]],
      ["staff-performance", ["view", "approve", "export"]], ["performance-center", VE],
      ["staff-development", FULL], ["performance-history", VE], ["staff-timesheet", VE], ["staff-reports", VE],
      ...["acc-dashboard", "acc-payroll", "acc-employees", "acc-reports", "acc-review"].map((id) => [id, ACC_EDIT]),
    ]),
    "Team Leader": profile("Team Leader", "team", [
      ...STAFF_FULL.map((id) => [id, FULL]),
      ["hr-dashboard", VE], ["hr-reports", VE],
      ...["acc-dashboard", "acc-funding", "acc-expenses", "acc-materials", "acc-labor", "acc-clients", "acc-projects", "acc-boq", "acc-refs", "acc-reports", "acc-review"].map((id) => [id, ACC_EDIT]),
      ["construction-financials", VE],
    ]),
    Engineer: profile("Engineer", "own", [
      ["staff-clock", BASIC], ["staff-live", ["view"]], ["staff-schedule", ["view", "add"]],
      ["staff-performance", ["view", "add", "edit"]], ["performance-center", VE],
      ["staff-development", ["view", "edit"]], ["performance-history", ["view"]], ["staff-timesheet", VE],
      ...["acc-dashboard", "acc-projects", "acc-materials", "acc-labor", "acc-boq", "acc-review"].map((id) => [id, BASIC]),
    ]),
    Viewer: profile("Viewer", "own", [
      ...["staff-dashboard", "staff-live", "staff-schedule", "performance-center", "staff-development", "performance-history", "staff-timesheet", "staff-reports", "hr-dashboard", "hr-reports", "acc-dashboard", "acc-reports"].map((id) => [id, VE]),
    ]),
    Intern: profile("Intern", "own", [
      ["staff-clock", BASIC], ["staff-live", ["view"]], ["staff-schedule", ["view", "add"]],
      ["staff-performance", ["view", "add"]], ["performance-center", ["view"]],
      ["staff-development", ["view", "edit"]], ["performance-history", ["view"]],
      ["staff-timesheet", ["view"]], ["project-portal", ["view"]],
    ]),
  };
  /* This browser context is a trusted, freshly-verified device for every QA
   * account, so sign-in exercises the password path rather than stalling on
   * the emailed-code screen (there is no inbox in a QA context). */
  const nowIso = new Date().toISOString();
  localStorage.setItem("larsaDeviceId", "zz-qa-device");
  const qaDevice = { id: "zz-qa-device", label: "QA Test Device", firstSeen: nowIso, lastSeen: nowIso, lastVerified: nowIso, lastAccountingVerified: nowIso };
  const users = cfg.users.map((u) => ({
    ...u,
    department: "QA Fixture",
    enabled: true,
    active: true,
    emailVerified: true,
    isTest: true,
    password: cfg.password,
    devices: [qaDevice],
    permissionProfile: PROFILES[u.access] || PROFILES.Engineer,
  }));
  let n = 0;
  const log = (uid, status, at, type = "Office") => ({ id: `zz-qa-l${n++}`, uid, type, status, time: at, note: "QA fixture", active: true });
  const now = Date.now();
  const logs = [
    // The exact-8-hours day: 2026-07-20 (Mon) 09:00–17:00 local.
    log("zz-qa-emp", "In", iso(2026, 7, 20, 9, 0)),
    log("zz-qa-emp", "Out", iso(2026, 7, 20, 17, 0)),
    // The midnight crossing: 21st 22:00 → 22nd 02:00 (4 h, expected 2 + 2).
    log("zz-qa-emp", "In", iso(2026, 7, 21, 22, 0)),
    log("zz-qa-emp", "Out", iso(2026, 7, 22, 2, 0)),
    // Break day: 09:00–17:00 with a 12:00–13:00 break → 7.00 net / 8.00 presence.
    log("zz-qa-emp", "In", iso(2026, 7, 23, 9, 0)),
    log("zz-qa-emp", "Break Start", iso(2026, 7, 23, 12, 0)),
    log("zz-qa-emp", "Break End", iso(2026, 7, 23, 13, 0)),
    log("zz-qa-emp", "Out", iso(2026, 7, 23, 17, 0)),
    // A one-hour session "today" so the live tiles have something bounded.
    log("zz-qa-emp", "In", new Date(now - 3 * 3600000).toISOString()),
    log("zz-qa-emp", "Out", new Date(now - 2 * 3600000).toISOString()),
    // The stale session: open for 72 hours and counting. Its own account.
    log("zz-qa-stale", "In", new Date(now - 72 * 3600000).toISOString()),
    // The double clock-in: In 10:00, In again 10:05, Out 11:00.
    log("zz-qa-dupe", "In", iso(2026, 7, 24, 10, 0)),
    log("zz-qa-dupe", "In", iso(2026, 7, 24, 10, 5)),
    log("zz-qa-dupe", "Out", iso(2026, 7, 24, 11, 0)),
    // The year boundary: Dec 31 22:00 → Jan 1 01:00 (3 h across the year line).
    log("zz-qa-year", "In", iso(2025, 12, 31, 22, 0)),
    log("zz-qa-year", "Out", iso(2026, 1, 1, 1, 0)),
    // The small-hours session: 00:30–06:30 LOCAL on July 25. In Baghdad that
    // starts on July 24 UTC — the hours must still land on the 25th.
    log("zz-qa-early", "In", iso(2026, 7, 25, 0, 30)),
    log("zz-qa-early", "Out", iso(2026, 7, 25, 6, 30)),
    // A session by an account that no longer exists — the name must not
    // fall back to the raw id.
    log("zz-qa-ghost", "In", iso(2026, 7, 19, 8, 0)),
    log("zz-qa-ghost", "Out", iso(2026, 7, 19, 9, 0)),
  ];

  /* The same ISO-week label the shell computes. */
  const weekOf = (date) => {
    const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  };
  const today = new Date();
  const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const thisWeek = weekOf(today);
  const lastWeek = weekOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7));

  const perfRow = (id, submitted, approved, status) => ({
    id: `zz-qa-${id}`,
    Week: thisWeek,
    Date: dateKey(today),
    Engineer: "QA Employee One",
    Department: "QA Fixture",
    "Job Number": `QA-JOB-${id}`,
    "Client Code": "QA",
    "Work Category": "Design",
    Discipline: "Structural",
    "Assigned By": "",
    Reviewer: "",
    "Hours Spent": 0,
    "Assigned Points": submitted,
    "Submitted Points": submitted,
    "Approved Points": approved,
    Status: status,
    Notes: "QA fixture",
    uid: "zz-qa-emp",
  });
  const performance = [
    perfRow("draft", 5, 0, "Draft"),
    perfRow("submitted", 10, 0, "Submitted"),
    perfRow("approved", 15, 15, "Approved"),
    perfRow("returned", 8, 0, "Returned"),
  ];

  const approvals = [
    { id: "zz-qa-leave1", type: "Leave", uid: "zz-qa-emp", requestType: "Annual", date: "2026-07-26", from: "2026-07-26", to: "2026-07-28", reason: "QA fixture leave", status: "Approved", flow: ["zz-qa-mgr"], step: 1, history: [], createdAt: iso(2026, 7, 24, 9, 0), decidedBy: "QA Manager", decidedAt: iso(2026, 7, 24, 10, 0) },
    // The three-hour correction: date + times. Must never display as zero.
    { id: "zz-qa-corr1", type: "Missed Clock", uid: "zz-qa-emp", requestType: "Office", date: "2026-07-27", from: "09:00", to: "12:00", reason: "QA fixture correction", status: "Pending", flow: ["zz-qa-mgr"], step: 0, history: [], createdAt: iso(2026, 7, 27, 13, 0) },
    // The rejected 12 points: rejected work must not join the official score.
    {
      id: "zz-qa-rej1", type: "Points Unlock", uid: "zz-qa-emp", requestType: lastWeek, week: lastWeek,
      entry: { ...perfRow("rejected", 12, 0, "Pending approval"), Week: lastWeek },
      date: dateKey(today), reason: "QA fixture late entry", status: "Rejected", flow: ["zz-qa-mgr"], step: 1, history: [], createdAt: iso(2026, 7, 27, 9, 0), decidedBy: "QA Manager",
    },
  ];

  const store = {
    users,
    logs,
    performance,
    approvals,
    schedule: { "zz-qa-emp": { Monday: [{ start: "09:00", end: "17:00", code: "M", instance: "zz-qa-shift1" }] } },
    weekLocks: { [lastWeek]: { week: lastWeek, lockedBy: "QA Super Admin", lockedAt: iso(2026, 7, 27, 8, 0), note: "QA locked week" } },
    flowConfig: { "zz-qa-emp": { Leave: ["zz-qa-mgr"], Schedule: ["zz-qa-mgr"], Performance: ["zz-qa-mgr"] } },
  };
  localStorage.setItem("larsaStaffV8", JSON.stringify(store));
  localStorage.setItem("larsaStaffGrowthV1", JSON.stringify({ version: 1, pointTargets: { "zz-qa-emp": 50 }, development: [] }));
  if (cfg.sessionUser) {
    const found = users.find((u) => u.id === cfg.sessionUser);
    const safe = { ...found };
    delete safe.password; delete safe.pin;
    sessionStorage.setItem("larsa-control-session", JSON.stringify({ user: safe, method: cfg.method || "email" }));
  }
}

/* Engine fixture for /engines/accounting.html?demo=1 — the engine's own
 * isolated demo mode, which never signs into production and shows the
 * ISOLATED DEMO banner. Seeded into the v3.4+ store key before boot. */
export function qaSeedEngine() {
  const mark = { isTest: true };
  const state = {
    settings: { language: "en", theme: "dark", rate: 1310, consultancyRate: 0, company: "Larsa Engineering", initialized: true },
    users: [
      { id: "zz-qa-owner", name: "QA Owner", email: "qa.owner@larsaeng.test", pass: "qa-owner-pass-2026", role: "Owner / Super Admin", region: "Iraq", active: true, ...mark },
      { id: "zz-qa-eng", name: "QA Engine Engineer", email: "qa.engineer@larsaeng.test", pass: "qa-eng-pass-2026", role: "Engineer", region: "Iraq", active: true, ...mark },
    ],
    projects: [
      { id: "zz-qa-prj1", code: "ZZ-QA-2026-001", name: "QA Fixture Construction", region: "Iraq", client: "QA Client", type: "Construction", status: "Active", contractValue: 120000000, currency: "IQD", consultancyRate: 0.08, created: "2026-07-01", ...mark },
      { id: "zz-qa-prj2", code: "ZZ-QA-2026-002", name: "QA FX Fixture", region: "USA", client: "QA US Client", type: "Design / Engineering", status: "Active", contractValue: 4000, currency: "USD", consultancyRate: 0, created: "2026-07-01", ...mark },
    ],
    funding: [
      { id: "zz-qa-f1", date: "2026-07-05", projectId: "zz-qa-prj1", type: "Construction Funding", description: "QA funding fixture", amount: 100000000, currency: "IQD", method: "Bank Transfer", status: "Received", consultancyRate: 0.08, consultancyFee: 8000000, waived: false, netConstruction: 92000000, fxRate: 1500, ...mark },
      { id: "zz-qa-f2", date: "2026-07-06", projectId: "zz-qa-prj2", type: "Design Fee", description: "QA USD payment one", amount: 1000, currency: "USD", method: "Bank Transfer", status: "Received", consultancyRate: 0, consultancyFee: 0, waived: false, netConstruction: 1000, fxRate: 1500, ...mark },
      { id: "zz-qa-f3", date: "2026-07-20", projectId: "zz-qa-prj2", type: "Design Fee", description: "QA USD payment two", amount: 1000, currency: "USD", method: "Bank Transfer", status: "Received", consultancyRate: 0, consultancyFee: 0, waived: false, netConstruction: 1000, fxRate: 1600, ...mark },
    ],
    revenue: [],
    expenses: [
      { id: "zz-qa-e1", date: "2026-07-10", projectId: "zz-qa-prj1", category: "Site works", description: "QA pending expense", amount: 5000000, currency: "IQD", paymentSource: "Client Funding", status: "Pending Approval", fxRate: 1500, ...mark },
    ],
    materials: [
      { id: "zz-qa-m1", date: "2026-07-08", projectId: "zz-qa-prj1", description: "QA rebar", amount: 20000000, currency: "IQD", paymentSource: "Client Funding", status: "Approved", fxRate: 1500, ...mark },
    ],
    projectLabor: [
      { id: "zz-qa-lab1", date: "2026-07-09", projectId: "zz-qa-prj1", workforceId: "", trade: "QA crew", quantity: 100, unit: "day", rate: 100000, total: 10000000, currency: "IQD", paymentSource: "Client Funding", status: "Approved", fxRate: 1500, ...mark },
    ],
    operating: [],
    employees: [
      { id: "zz-qa-payemp", name: "QA Payroll Person", email: "qa.pay@larsaeng.test", position: "QA Engineer", department: "QA Fixture", region: "Iraq", status: "Active", ...mark },
    ],
    payroll: [
      /* The spec's exact pay: base 2,000,000 + commission 500,000 (bonus
       * field) + allowance 200,000 − deduction 100,000. The engine derives
       * grossPay/netPay from these fields. */
      { id: "zz-qa-pay1", employeeId: "zz-qa-payemp", employee: "QA Payroll Person", period: "2026-07", date: "2026-07-31", payDate: "2026-07-31", baseSalary: 2000000, regularHours: 0, regularRate: 0, overtimeHours: 0, overtimeRate: 0, bonus: 500000, allowances: 200000, reimbursement: 0, federalWithholding: 0, socialSecurityEmployee: 0, medicareEmployee: 0, stateTaxEmployee: 0, otherEmployeeDeductions: 100000, currency: "IQD", status: "Approved", region: "Iraq", ...mark },
    ],
    commissions: [], suppliers: [], workforce: [], boqItems: [], documents: [],
    reviewQueue: [], audit: [],
  };
  const json = JSON.stringify(state);
  localStorage.setItem("larsa_enterprise_v3_new_account_20260630_v34_clean", json);
  localStorage.setItem("larsa_enterprise_v3_new_account_20260630", json);
}

/* The controlled expectations, in one place so every suite asserts the
 * same numbers the specification states. */
export const QA_EXPECT = {
  fullDayHours: 8, midnightTotal: 4, midnightSplit: [2, 2], breakDayNet: 7, breakDayPresence: 8,
  staleAfterHours: 48,
  officialPoints: 15, weekTarget: 50, progressPct: 30,
  budget: 120000000, funding: 100000000, fee: 8000000, netFunding: 92000000,
  materials: 20000000, labor: 10000000, pending: 5000000,
  actualCost: 30000000, totalUsed: 38000000, remaining: 62000000, costProgressPct: 25,
  fxUsd: 2000, fxIqd: 3100000,
  payGross: 2700000, payNet: 2600000,
};
