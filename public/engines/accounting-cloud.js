/* ============================================================
   Larsa Control — Accounting Cloud Layer (v4.0)

   Connects the accounting engine to the authoritative relational
   accounting store in Supabase (acct_* tables + SECURITY DEFINER
   RPCs), replacing the serialized-blob as the accounting system of
   record while leaving every non-accounting module untouched.

   Additive, like every earlier vNN patch layer in accounting.html:
   nothing existing is edited, functions are wrapped. If Supabase is
   not configured (no bridge config in localStorage) this whole layer
   is inert and the engine behaves exactly as before (local-first).

   What runs through the backend when connected:
     * every funding / material / labor / expense / revenue entry
       (kind-mapped into ONE acct_transactions ledger — a material or
       labor entry is never re-entered under general Expenses)
     * exchange-rate hierarchy (platform → project → transaction)
       with permanent per-transaction snapshots
     * the consultancy-fee engine (8% platform default, per-project
       rules, bases, treatments, incremental idempotent posting)
     * schedule/physical progress history
     * refund settlements under the Larsa unused-funding rule
     * protected destructive actions (fresh password + emailed code,
       Platform Super Admin approval, no self-approval)
     * the append-only accounting audit history
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- direct-access guard ----------------
     The Accounting portal is reached through the authenticated Larsa
     Control work area, which loads this engine in a frame and injects
     the signed-in identity. Opening /engines/accounting.html directly
     bypasses that, so it must never look like the real portal: it is
     sent back to Larsa Control to sign in. ?demo=1 keeps a clearly
     labelled, isolated preview for development. */
  try {
    var framed = window.top !== window.self;
    var wantsDemo = /[?&]demo=1\b/.test(window.location.search);
    if (!framed && !wantsDemo && /\/engines\/accounting\.html/i.test(window.location.pathname)) {
      var target = window.location.origin + "/";
      document.documentElement.innerHTML =
        '<body style="margin:0;font-family:system-ui,Segoe UI,Arial,sans-serif;background:#0f1115;color:#e8eaed;' +
        'display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">' +
        "<div><h1 style=\"font-size:18px;margin:0 0 8px\">Larsa Control — Accounting</h1>" +
        '<p style="color:#9aa0a6;font-size:13px;margin:0 0 14px">The Accounting portal opens inside Larsa Control.<br>' +
        "Taking you to sign in…</p>" +
        '<a href="' + target + '" style="color:#8ab4f8;font-size:13px">Continue to Larsa Control</a></div></body>';
      window.location.replace(target);
      return;
    }
    if (!framed && wantsDemo) {
      window.__larsaIsolatedDemo = true;
      document.addEventListener("DOMContentLoaded", function () {
        var bar = document.createElement("div");
        bar.setAttribute("role", "status");
        bar.style.cssText = "position:sticky;top:0;z-index:99999;background:#7a2e00;color:#fff;padding:7px 12px;" +
          "font:600 12px/1.4 system-ui,Segoe UI,Arial,sans-serif;letter-spacing:.02em;text-align:center";
        bar.textContent = "ISOLATED DEMO — not production. No Larsa Control account is signed in and nothing here is the real accounting ledger.";
        if (document.body) document.body.insertBefore(bar, document.body.firstChild);
      });
    }
  } catch (e) { /* cross-origin frame checks can throw; the engine still gates itself */ }

  var BRIDGE_KEY = "larsaSupabaseBridgeV1";
  var Core = window.LarsaAcctCore;
  if (!Core) { console.warn("[acct-cloud] accounting-core.js missing — layer off"); return; }

  function TT(en, ar) {
    try { return typeof isAR === "function" && isAR() ? ar : en; } catch (e) { return en; }
  }
  function esc4(v) {
    return String(v == null ? "" : v).replace(/[&<>'"]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[m];
    });
  }
  function nmoney(v, cur) {
    try { return fmt(v, cur); } catch (e) {
      return (cur === "IQD" ? "" : "$") + new Intl.NumberFormat("en-US", { maximumFractionDigits: cur === "IQD" ? 0 : 2 }).format(Number(v) || 0) + (cur === "IQD" ? " IQD" : "");
    }
  }
  function toast4(msg) {
    try { toast(msg); } catch (e) { try { alert(msg); } catch (_) {} }
  }
  function uuid4() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ---------------- Supabase REST bridge ---------------- */
  var cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(BRIDGE_KEY) || "null"); } catch (e) { cfg = null; }
  if (!cfg || !cfg.url || !cfg.anonKey) {
    console.log("[acct-cloud] no Supabase bridge config — accounting stays local-only on this device");
    return;
  }

  function sessionToken() {
    try {
      var ref = String(cfg.url).replace(/^https?:\/\//, "").split(".")[0];
      var raw = localStorage.getItem("sb-" + ref + "-auth-token");
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) parsed = parsed[0];
        var tok = parsed && (parsed.access_token || (parsed.currentSession && parsed.currentSession.access_token));
        if (tok) return tok;
      }
    } catch (e) { /* fall through to anon key */ }
    return cfg.anonKey;
  }

  function rpc(name, args) {
    return fetch(cfg.url + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        apikey: cfg.anonKey,
        Authorization: "Bearer " + sessionToken(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args || {}),
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (!res.ok) {
          var msg = (body && (body.message || body.error || body.hint)) || ("HTTP " + res.status);
          throw new Error(String(msg).replace(/^ACCT_[A-Z]+: /, ""));
        }
        return body;
      });
    });
  }

  function edgeFn(name, payload) {
    return fetch(cfg.url + "/functions/v1/" + name, {
      method: "POST",
      headers: {
        apikey: cfg.anonKey,
        Authorization: "Bearer " + sessionToken(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    }).then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: "network" }; });
  }

  /* ---------------- store ---------------- */
  var ACCT = window.ACCT = {
    on: false,
    settings: null, projects: [], txns: [], fees: [], refunds: [],
    progress: [], approvals: [], review: [], audit: [], archives: [],
    receipts: [], permissions: [], myPerms: null,
    isPlatformAdmin: false,
    lastError: "",
  };
  function myPerm(p) {
    if (ACCT.myPerms && Object.prototype.hasOwnProperty.call(ACCT.myPerms, p)) return ACCT.myPerms[p] === true;
    // Fallback before permissions load: mirror the server's role defaults.
    var role = (engineUser() || {}).role || "";
    if (["Owner / Super Admin", "Management"].indexOf(role) !== -1) return p !== "self_approve" && p !== "manage_permissions";
    if (role === "Accountant") return ["view", "create", "edit_own_unapproved", "submit_review", "print_receipts", "reprint_receipts", "post_refunds", "export_working"].indexOf(p) !== -1;
    return p === "view";
  }

  function engineUser() {
    try { return (typeof currentUser !== "undefined" && currentUser) ? currentUser : {}; } catch (e) { return {}; }
  }
  function actor() {
    var u = engineUser();
    return { email: u.email || "", name: u.name || "", role: u.role || "" };
  }
  var WRITER_ROLES = ["Owner / Super Admin", "Management", "Accountant"];
  function canWriteAcct() { return myPerm("create"); }

  /* Dual-control scope: per-project assigned accountants/approvers and
     per-area (funding/material/labor/expense/revenue/adjustment)
     assigned approvers. Empty assignment = access decides. */
  function emailList(j) {
    if (!Array.isArray(j)) return [];
    return j.map(function (x) { return String(x || "").toLowerCase().trim(); }).filter(Boolean);
  }
  function myEmailLc() { return String((actor() || {}).email || "").toLowerCase(); }
  function approverScope(pid, kind) {
    var me = myEmailLc();
    var proj = projectRow(pid);
    var pl = proj ? emailList(proj.assigned_approvers) : [];
    if (pl.length && pl.indexOf(me) === -1) return { ok: false, who: pl.join(", "), what: TT("this project", "هذا المشروع") };
    var aa = (ACCT.settings || {}).area_approvers || {};
    var al = emailList(aa[kind]);
    if (al.length && al.indexOf(me) === -1) return { ok: false, who: al.join(", "), what: TT("this area", "هذا القسم") };
    return { ok: true };
  }
  /* ---------------- who can be assigned ----------------
     Assignments name a real account, never a typed-in address. The
     roster comes from the signed-in Larsa Control staff list when the
     engine runs inside the work area, and falls back to the engine's
     own user list so the dropdowns still work standalone. */
  function acctRoster() {
    var seen = {}, out = [];
    var add = function (email, name, role) {
      var e = String(email || "").toLowerCase().trim();
      if (!e || e.indexOf("@") < 0 || seen[e]) return;
      seen[e] = true;
      out.push({ email: e, name: name || e, role: role || "" });
    };
    try {
      (window.__larsaAccountingRoster || []).forEach(function (p) { add(p.email, p.name, p.role); });
    } catch (e) {}
    try {
      (state.users || []).forEach(function (u) {
        if (u && u.active !== false) add(u.email, u.name, u.role);
      });
    } catch (e) {}
    // Anyone already granted explicit accounting permissions stays selectable
    // even if they are no longer in the roster, so an existing assignment is
    // never silently dropped when the form is reopened.
    (ACCT.permissions || []).forEach(function (p) { add(p.email, p.email, ""); });
    ACCT.projects.forEach(function (p) {
      emailList(p.assigned_accountants).concat(emailList(p.assigned_approvers))
        .forEach(function (e) { add(e, e, ""); });
    });
    out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    return out;
  }

  /* A multi-select of people. Empty selection keeps the existing meaning:
     anyone who holds the permission. */
  function rosterPicker(id, selected, emptyLabel) {
    var chosen = emailList(selected);
    var people = acctRoster();
    if (!people.length) {
      return '<input id="' + id + '" value="' + esc4(chosen.join(", ")) + '" placeholder="name@larsaeng.com">' +
        '<span class="muted small">' + TT("No staff accounts found — enter emails separated by commas.",
          "لا توجد حسابات موظفين — أدخل البريد مفصولاً بفواصل.") + "</span>";
    }
    return '<select id="' + id + '" multiple size="' + Math.min(5, Math.max(3, people.length)) + '" style="min-height:74px">' +
      people.map(function (p) {
        return '<option value="' + esc4(p.email) + '"' + (chosen.indexOf(p.email) !== -1 ? " selected" : "") + ">" +
          esc4(p.name) + (p.role ? " — " + esc4(p.role) : "") + "</option>";
      }).join("") + "</select>" +
      '<span class="muted small">' + esc4(emptyLabel || TT("Select none = anyone with the permission. Ctrl/Cmd-click to choose several.",
        "بدون اختيار = أي شخص لديه الصلاحية. اضغط Ctrl/Cmd للاختيار المتعدد.")) + "</span>";
  }
  /* Reads either the multi-select or the plain-text fallback. */
  function readPicker(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    if (el.tagName === "SELECT") {
      return Array.prototype.slice.call(el.selectedOptions || [])
        .map(function (o) { return String(o.value || "").toLowerCase().trim(); })
        .filter(function (v) { return v.indexOf("@") > 0; });
    }
    return String(el.value || "").split(/[,;\s]+/)
      .map(function (x) { return x.trim().toLowerCase(); })
      .filter(function (x) { return x.indexOf("@") > 0; });
  }

  function entryScopeOk(pid) {
    var proj = projectRow(pid);
    if (!proj) return true;
    var accs = emailList(proj.assigned_accountants);
    if (!accs.length) return true;
    var me = myEmailLc();
    return accs.indexOf(me) !== -1 || emailList(proj.assigned_approvers).indexOf(me) !== -1
      || (actor() || {}).role === "Owner / Super Admin";
  }

  var COLL_KIND = { funding: "funding", materials: "material", projectLabor: "labor", expenses: "expense", revenue: "revenue" };
  var KIND_COLL = { funding: "funding", material: "materials", labor: "projectLabor", expense: "expenses", revenue: "revenue" };
  var STATUS_TO_LEGACY = {
    draft: "Draft", pending: "Pending Approval", approved: "Approved", posted: "Approved",
    received: "Received", paid: "Paid", rejected: "Rejected", void: "Void", reversed: "Reversed",
  };
  var LEGACY_TO_STATUS = {
    Draft: "draft", Expected: "pending", Pending: "pending", "Pending Approval": "pending",
    Requested: "pending", Ordered: "pending", "Partially Paid": "pending",
    Approved: "approved", Received: "received", Paid: "paid", Refunded: "paid",
    Rejected: "rejected", Void: "void",
  };

  /* ---------------- relational → legacy mirrors ----------------
     The old renderers keep working unchanged: state.funding /
     state.materials / state.projectLabor / state.expenses /
     state.revenue become read-mirrors of acct_transactions.
     Records are tagged _acctManaged so legacy recompute paths
     (deriveRecord/xFunding) leave the server snapshots alone. */
  function feeForTxnId(id) {
    for (var i = 0; i < ACCT.fees.length; i++) {
      var f = ACCT.fees[i];
      if (f.source_txn_id === id && f.entry_type === "fee" && (f.status === "posted" || f.status === "settled" || f.status === "estimated")) return f;
    }
    return null;
  }

  function mirrorTxn(t) {
    var fee = feeForTxnId(t.id);
    var base = {
      id: t.id, _acctManaged: true, _acct: t,
      projectId: t.project_id,
      date: t.txn_date,
      status: STATUS_TO_LEGACY[t.status] || t.status,
      currency: t.original_currency,
      fxRate: Number(t.exchange_rate) || 0,
      rateSource: t.rate_source,
      txnNo: t.txn_no,
      receiptNo: t.receipt_no,
      reviewStatus: t.review_status || "unreviewed",
      reviewComment: t.review_comment || "",
      notes: t.description || "",
      description: t.description || "",
      category: t.category || "",
      paymentSource: t.payment_source || "",
      invoiceNumber: t.external_ref || "",
      isSample: !!t.is_sample,
      createdBy: t.created_by_email || "",
    };
    if (t.kind === "funding") {
      base.amount = Number(t.original_amount);
      base.consultancyRate = fee ? Number(fee.fee_rate || 0) : Number((t.fee_rule || {}).rate || 0);
      base.consultancyFee = fee && (fee.status === "posted" || fee.status === "settled") ? Number(fee.fee_amount) : 0;
      base.waived = !!(t.fee_rule && t.fee_rule.waived);
      base.netConstruction = Core.round2(base.amount - ((fee && fee.treatment === "deduct_from_funding") ? base.consultancyFee : 0));
      base.fundingSource = t.category || "Client Payment";
    } else if (t.kind === "material") {
      base.amount = Number(t.original_amount);
      base.itemName = t.description || "";
      base.materialCategory = t.category || "";
      base.quantity = Number(t.quantity || 0);
      base.unit = t.unit || "";
      base.unitPrice = base.quantity > 0 ? Core.round2(base.amount / base.quantity) : base.amount;
      base.supplier = t.supplier || "";
    } else if (t.kind === "labor") {
      base.total = Number(t.original_amount);
      base.amount = base.total;
      base.trade = t.category || "";
      base.quantity = Number(t.quantity || 0);
      base.unit = t.unit || "";
      base.rate = base.quantity > 0 ? Core.round2(base.total / base.quantity) : base.total;
    } else {
      base.amount = Number(t.original_amount);
      base.expenseType = t.category || "";
    }
    return base;
  }

  function applyMirrors() {
    try { if (typeof state === "undefined" || !state) return; } catch (e) { return; }
    var buckets = { funding: [], materials: [], projectLabor: [], expenses: [], revenue: [] };
    ACCT.txns.forEach(function (t) {
      if (t.deleted_at) return;
      var coll = KIND_COLL[t.kind];
      if (!coll) return; // refunds/adjustments/reversals live in the summary + history, not the entry ledgers
      buckets[coll].push(mirrorTxn(t));
    });
    Object.keys(buckets).forEach(function (coll) {
      buckets[coll].sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
      state[coll] = buckets[coll];
    });
    // Latest schedule progress per project — kept in step with the portal's
    // progress field so every surface reports the same number.
    var latestProgress = {};
    ACCT.progress.forEach(function (pr) {
      var cur = latestProgress[pr.project_id];
      if (!cur || String(pr.update_date) > String(cur.update_date)
        || (String(pr.update_date) === String(cur.update_date) && String(pr.created_at) > String(cur.created_at))) {
        latestProgress[pr.project_id] = pr;
      }
    });
    // Projects: merge relational accounting fields into the blob records
    // (kept for org/permissions), and surface server-only projects.
    var byId = {};
    (state.projects || []).forEach(function (p) { byId[p.id] = p; });
    ACCT.projects.forEach(function (ap) {
      var p = byId[ap.id];
      if (!p) { p = { id: ap.id }; state.projects.push(p); }
      p.code = ap.code || p.code; p.name = ap.name || p.name;
      p.clientName = ap.client || p.clientName;
      p.region = ap.region || p.region; p.type = ap.type || p.type;
      p.status = p.status || ap.status;
      p.currency = ap.currency || p.currency;
      p.contractValue = ap.contract_value != null ? Number(ap.contract_value) : p.contractValue;
      p.approvedBudget = ap.approved_budget != null ? Number(ap.approved_budget) : p.approvedBudget;
      p.budgetCurrency = ap.budget_currency || p.budgetCurrency;
      p.defaultFxRate = ap.default_exchange_rate != null ? Number(ap.default_exchange_rate) : null;
      p.consultancyRate = ap.fee_inherit ? Number((ACCT.settings || {}).default_fee_rate || 0) : Number(ap.fee_rate || 0);
      p.consultancyRateConfirmed = true;
      if (latestProgress[ap.id]) p.progress = Number(latestProgress[ap.id].percent) || 0;
      p._acct = ap;
      p.isSample = !!ap.is_sample;
    });
    try { if (typeof save === "function") save(); } catch (e) { /* blob cache only */ }
  }

  function projectRow(id) {
    for (var i = 0; i < ACCT.projects.length; i++) if (ACCT.projects[i].id === id) return ACCT.projects[i];
    return null;
  }
  function resolvedRateFor(projectId) {
    return Core.resolveRate(ACCT.settings || {}, projectRow(projectId) || {}, null);
  }
  function resolvedFeeRuleFor(projectId, kind, category) {
    return Core.resolveFeeRule(ACCT.settings || {}, projectRow(projectId) || {}, kind, category, null);
  }

  /* ---------------- boot / refresh ---------------- */
  var currentSectionKeeper = null;
  function keepContext() {
    currentSectionKeeper = {
      section: typeof activeSection !== "undefined" ? activeSection : null,
      project: window.xProject || null,
      tab: window.xTab || null,
    };
  }
  function restoreContext() {
    var k = currentSectionKeeper;
    try {
      if (k && k.project && typeof window.openProjectDetail === "function"
        && (typeof activeSection === "undefined" || activeSection === "projects" || k.section === "projects")) {
        window.openProjectDetail(k.project, k.tab || "summary");
      } else if (typeof render === "function") render();
    } catch (e) { try { render(); } catch (_) {} }
  }

  var bootDone = false;
  /* ============================================================
     THE authoritative financial model (backend migration 008).

     One backend calculation feeds every accounting surface. The
     engine's own xTotals() and totals() are replaced by thin
     readers over the cached server figures, so the project
     summary, project cards, client statement, funding statement,
     reports, dashboard, charts, receipts and every export can no
     longer disagree with each other.

     Two things this fixes, precisely:
       * Client construction funding is money held FOR the project.
         It is never Larsa revenue, and company profit is never
         "funding minus construction spending".
       * "Actual spending" is the project's real construction cost.
         It no longer depends on a payment-source label that
         server-side records do not carry, which is why the client
         statement used to read 0 while approved spending existed.
     ============================================================ */
  var FIN = { byProject: {}, company: null, loadedAt: 0 };
  ACCT.fin = FIN;

  function loadFinancials(then) {
    return rpc("acct_company_financials", { p_project_ids: null, p_region: null })
      .then(function (co) {
        if (!co) return;
        FIN.company = co;
        FIN.byProject = {};
        (co.rows || []).forEach(function (row) { FIN.byProject[row.project_id] = row; });
        FIN.loadedAt = Date.now();
        if (then) then();
      })
      .catch(function (e) { console.warn("[acct-cloud] financials:", e); });
  }
  ACCT.reloadFinancials = loadFinancials;

  function finFor(pid) { return FIN.byProject[pid] || null; }
  /* The engine holds money in USD internally. Each *_usd figure is the
     sum of per-entry USD snapshots taken at that entry's own historical
     rate, which is exactly what the engine's usd(amount,cur,fxRate)
     produced — so nothing downstream needs to change. */
  function finUsd(node, key) {
    if (!node) return 0;
    var v = node[key + "_usd"];
    return typeof v === "number" ? v : Number(v || 0);
  }
  function finIqd(node, key) {
    if (!node) return 0;
    var v = node[key + "_iqd"];
    return typeof v === "number" ? v : Number(v || 0);
  }

  /* Replace the engine's per-project totals with the server's. Every
     field the old function returned is still returned, plus the
     approved/working pair the corrected model requires. */
  var origXTotals = null;
  function wrapTotals() {
    if (origXTotals || typeof window.xTotals !== "function") return;
    origXTotals = window.xTotals;
    window.xTotals = function (pid) {
      var base = origXTotals.apply(this, arguments);
      var row = ACCT.on ? finFor(pid) : null;
      if (!row) return base;
      var cf = row.client_funds || {}, ap = cf.approved || {}, wk = cf.working || {},
          pn = cf.pending || {}, co = row.company || {};
      var approvedCost = finUsd(ap, "construction_cost");
      var workingCost = finUsd(wk, "construction_cost");
      var out = Object.assign({}, base, {
        // ---- client fund control (held for the project) ----
        gross: finUsd(ap, "gross_funding"),
        fee: finUsd(ap, "initial_fee"),
        netFunding: finUsd(ap, "net_construction_funding"),
        mat: finUsd(ap, "materials"),
        lab: finUsd(ap, "labor"),
        exp: finUsd(ap, "other_costs"),
        total: approvedCost,
        clientSpent: approvedCost,
        pending: finUsd(pn, "construction_cost"),
        balance: finUsd(ap, "remaining_balance"),
        // ---- approved vs working, both always available ----
        approvedCost: approvedCost,
        workingCost: workingCost,
        pendingCost: finUsd(pn, "construction_cost"),
        approvedBalance: finUsd(ap, "remaining_balance"),
        workingBalance: finUsd(wk, "remaining_balance"),
        // ---- Larsa company accounting (kept strictly apart) ----
        larsaRevenue: finUsd(co, "larsa_revenue"),
        companyNet: finUsd(co, "company_net_profit"),
        companyExpenses: finUsd(co, "company_expenses"),
        // `result` used to mean "funding-side profit". It is now the
        // company result on the authoritative definition.
        result: finUsd(co, "company_net_profit"),
        reliability: (row.review || {}).status || "green",
        reliabilityLabel: (row.review || {}).label || "",
        unapprovedEntries: (row.review || {}).unapproved_entries || 0,
        _authoritative: true,
        _iqd: {
          gross: finIqd(ap, "gross_funding"), fee: finIqd(ap, "initial_fee"),
          netFunding: finIqd(ap, "net_construction_funding"),
          approvedCost: finIqd(ap, "construction_cost"),
          workingCost: finIqd(wk, "construction_cost"),
          pendingCost: finIqd(pn, "construction_cost"),
          approvedBalance: finIqd(ap, "remaining_balance"),
          workingBalance: finIqd(wk, "remaining_balance"),
          larsaRevenue: finIqd(co, "larsa_revenue"),
          companyNet: finIqd(co, "company_net_profit"),
        },
      });
      return out;
    };
  }

  /* Company-wide totals: client funds held are reported as client
     funds, never folded into revenue or profit. */
  var origCompanyTotals = null;
  function wrapCompanyTotals() {
    if (origCompanyTotals || typeof window.totals !== "function") return;
    origCompanyTotals = window.totals;
    window.totals = function () {
      var base = origCompanyTotals.apply(this, arguments);
      var co = ACCT.on ? FIN.company : null;
      if (!co) return base;
      var cf = co.client_funds || {}, k = co.company || {};
      var rate = Number((ACCT.settings || {}).default_exchange_rate) || 1310;
      var toUsd = function (iqd) { return rate > 0 ? Core.round2(Number(iqd || 0) / rate) : 0; };
      return Object.assign({}, base, {
        fees: toUsd(k.consultancy_fee_revenue_iqd),
        rev: toUsd(k.engineering_revenue_iqd) + toUsd(k.other_revenue_iqd),
        realRevenue: toUsd(k.larsa_revenue_iqd),
        larsaCosts: toUsd(k.company_expenses_iqd),
        net: toUsd(k.company_net_profit_iqd),
        // Client construction funds — held, not earned.
        fundingGross: toUsd(cf.gross_funding_iqd),
        netConstruction: toUsd(cf.net_construction_funding_iqd),
        constructionSpend: toUsd(cf.construction_cost_approved_iqd),
        constructionSpendWorking: toUsd(cf.construction_cost_working_iqd),
        fundsHeld: toUsd(cf.remaining_balance_approved_iqd),
        fundsHeldWorking: toUsd(cf.remaining_balance_working_iqd),
        reliability: (co.review || {}).status || "green",
        reliabilityLabel: (co.review || {}).label || "",
        _authoritative: true,
      });
    };
  }

  function bootstrap(then) {
    rpc("acct_get_bootstrap", { p_audit_limit: 300 }).then(function (b) {
      if (!b) throw new Error("empty bootstrap");
      ACCT.settings = b.settings || null;
      ACCT.projects = b.projects || [];
      ACCT.txns = b.transactions || [];
      ACCT.fees = b.fee_ledger || [];
      ACCT.refunds = b.refund_settlements || [];
      ACCT.progress = b.progress || [];
      ACCT.approvals = b.approvals || [];
      ACCT.review = b.review_queue || [];
      ACCT.audit = b.audit_recent || [];
      ACCT.archives = b.archives || [];
      ACCT.receipts = b.receipts || [];
      ACCT.permissions = b.permissions || [];
      ACCT.on = true;
      ACCT.lastError = "";
      applyMirrors();
      loadFinancials();
      var email = (actor().email || "").toLowerCase();
      if (email) {
        rpc("acct_is_platform_admin", { admin_email: email })
          .then(function (v) { ACCT.isPlatformAdmin = v === true; })
          .catch(function () {});
        rpc("acct_get_my_permissions", { p_email: email, p_role: actor().role || "" })
          .then(function (p) { if (p) ACCT.myPerms = p; })
          .catch(function () {});
      }
      if (!bootDone) { bootDone = true; maybeSeedOrImport(); }
      if (then) then();
      else { try { render(); } catch (e) {} }
    }).catch(function (err) {
      ACCT.lastError = String(err && err.message || err);
      console.warn("[acct-cloud] bootstrap failed — engine stays on local cache:", err);
    });
  }

  function refresh(keep) {
    if (keep !== false) keepContext();
    bootstrap(function () { restoreContext(); });
  }

  function blobHasAccountingData() {
    try {
      return ["funding", "materials", "projectLabor", "expenses", "revenue"].some(function (c) {
        return (state[c] || []).some(function (r) { return !r._acctManaged; });
      }) && (state.projects || []).length > 0;
    } catch (e) { return false; }
  }

  function maybeSeedOrImport() {
    var s = ACCT.settings || {};
    var empty = ACCT.projects.length === 0 && ACCT.txns.length === 0;
    if (!empty) return;
    if (blobHasAccountingData()) {
      // Real local records exist that never reached the relational store —
      // preserve them (Legacy Migrated Rate; ambiguous ones go to review).
      var tryImport = function () {
        if (!canWriteAcct()) return; // retried on next boot with a writer signed in
        var payload = {
          settings: { rate: (state.settings || {}).rate || 1310 },
          projects: state.projects || [],
          funding: (state.funding || []).filter(function (r) { return !r._acctManaged; }),
          materials: (state.materials || []).filter(function (r) { return !r._acctManaged; }),
          projectLabor: (state.projectLabor || []).filter(function (r) { return !r._acctManaged; }),
          expenses: (state.expenses || []).filter(function (r) { return !r._acctManaged; }),
          revenue: (state.revenue || []).filter(function (r) { return !r._acctManaged; }),
        };
        rpc("acct_import_legacy", { actor: actor(), blob: payload }).then(function (r) {
          toast4(TT("Existing accounting records migrated to the shared ledger", "تم ترحيل السجلات المحاسبية الحالية إلى السجل المشترك") +
            (r && r.review ? " — " + r.review + TT(" sent to review", " أُرسلت للمراجعة") : ""));
          refresh();
        }).catch(function (e) { console.warn("[acct-cloud] legacy import:", e); });
      };
      setTimeout(tryImport, 2500); // give the parent time to inject currentUser
      return;
    }
    if (s.sample_state === "never_seeded") {
      rpc("acct_seed_sample_data", { actor: actor() }).then(function (r) {
        if (r && r.ok) { refresh(); }
      }).catch(function (e) { console.warn("[acct-cloud] sample seed:", e); });
    }
  }

  /* ---------------- protected-action + code modal ---------------- */
  function b64bytes(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function bytesb64(a) { return btoa(String.fromCharCode.apply(null, a)); }
  function verifyLocalPassword(password) {
    var email = (actor().email || "").toLowerCase();
    var rows = [];
    try { rows = rows.concat((state.users || [])); } catch (e) {}
    try {
      var staff = JSON.parse(localStorage.getItem("larsaStaffV8") || "null");
      if (staff && Array.isArray(staff.users)) rows = rows.concat(staff.users);
    } catch (e) {}
    var row = rows.filter(function (u) { return String(u.email || "").toLowerCase() === email; })[0];
    if (!row) return Promise.resolve(null); // unverifiable locally → email code remains the enforced factor
    if (row.passHash && row.passSalt && window.crypto && crypto.subtle) {
      return crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"])
        .then(function (key) {
          return crypto.subtle.deriveBits(
            { name: "PBKDF2", hash: "SHA-256", salt: b64bytes(row.passSalt), iterations: Number(row.passIterations) || 210000 },
            key, 256);
        })
        .then(function (bits) { return bytesb64(new Uint8Array(bits)) === row.passHash; })
        .catch(function () { return null; });
    }
    var plain = row.pass || row.password;
    if (plain) return Promise.resolve(String(plain) === String(password));
    return Promise.resolve(null);
  }

  /* The full §15 workflow: reason → fresh password → emailed code →
     pending approval request for the Platform Super Admin. */
  function protectedActionModal(action, title, projectId, payload, impactHint) {
    var root = document.getElementById("modalRoot");
    if (!root) return;
    var a = actor();
    root.innerHTML =
      '<div class="modal-back" onclick="if(event.target===this)closeEditor()"><div class="modal">' +
      '<div class="modal-head"><h3>' + esc4(title) + "</h3><button class=\"mini\" onclick=\"closeEditor()\">✕</button></div>" +
      '<div class="modal-body">' +
      '<p class="muted small">' + TT("This is a protected accounting action. It needs your password, a fresh code emailed to ", "هذا إجراء محاسبي محمي. يتطلب كلمة المرور ورمزاً جديداً يُرسل إلى ") + esc4(a.email) +
      TT(", and Platform Super Admin approval before anything is executed.", "، وموافقة مشرف المنصة قبل تنفيذ أي شيء.") + "</p>" +
      (impactHint ? '<div class="preview">' + impactHint + "</div>" : "") +
      '<div class="form-grid">' +
      '<div class="field wide"><label>' + TT("Reason (required)", "السبب (إلزامي)") + '</label><textarea id="acct_reason"></textarea></div>' +
      '<div class="field"><label>' + TT("Your password", "كلمة المرور") + '</label><input id="acct_pw" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label>' + TT("Email code", "رمز البريد") + '</label><div style="display:flex;gap:6px"><input id="acct_code" inputmode="numeric" maxlength="8" placeholder="——————">' +
      '<button class="btn sm ghost" id="acct_sendcode" type="button">' + TT("Send code", "إرسال الرمز") + "</button></div></div>" +
      '</div><div id="acct_prot_msg" class="muted small"></div></div>' +
      '<div class="modal-foot"><button class="btn ghost" onclick="closeEditor()">' + TT("Cancel", "إلغاء") + "</button>" +
      '<button class="btn" id="acct_prot_go">' + TT("Submit for approval", "إرسال للموافقة") + "</button></div></div></div>";
    document.body.classList.add("modal-open");
    var msg = function (t) { var el = document.getElementById("acct_prot_msg"); if (el) el.textContent = t; };
    document.getElementById("acct_sendcode").onclick = function () {
      msg(TT("Sending code to ", "جارٍ إرسال الرمز إلى ") + a.email + "…");
      edgeFn("auth-code", { op: "send", email: a.email, purpose: "verify", name: a.name }).then(function (r) {
        msg(r && r.ok ? TT("Code sent — check your inbox.", "تم إرسال الرمز — تفقد بريدك.") : String((r && r.error) || TT("Could not send the code.", "تعذر إرسال الرمز.")));
      });
    };
    document.getElementById("acct_prot_go").onclick = function () {
      var reason = (document.getElementById("acct_reason").value || "").trim();
      var pw = document.getElementById("acct_pw").value || "";
      var code = (document.getElementById("acct_code").value || "").trim();
      if (!reason) { msg(TT("A reason is required.", "السبب إلزامي.")); return; }
      if (!code) { msg(TT("Enter the emailed code.", "أدخل الرمز المُرسل بالبريد.")); return; }
      verifyLocalPassword(pw).then(function (ok) {
        if (ok === false) { msg(TT("That password does not match your account.", "كلمة المرور غير مطابقة.")); return; }
        msg(TT("Submitting…", "جارٍ الإرسال…"));
        rpc("acct_request_protected", {
          actor: a, p_code: code, p_action: action,
          p_project_id: projectId || null, p_payload: payload || {}, p_reason: reason,
        }).then(function (r) {
          try { closeEditor(); } catch (e) {}
          toast4(TT("Request submitted — awaiting Platform Super Admin approval.", "تم إرسال الطلب — بانتظار موافقة مشرف المنصة."));
          refresh();
        }).catch(function (e) { msg(String(e.message || e)); });
      });
    };
  }
  window.acctProtectedAction = protectedActionModal;

  function approvalCodeModal(req, approve) {
    var root = document.getElementById("modalRoot");
    if (!root) return;
    var a = actor();
    root.innerHTML =
      '<div class="modal-back" onclick="if(event.target===this)closeEditor()"><div class="modal">' +
      '<div class="modal-head"><h3>' + (approve ? TT("Approve", "الموافقة على") : TT("Reject", "رفض")) + " — " + esc4(req.action) + "</h3><button class=\"mini\" onclick=\"closeEditor()\">✕</button></div>" +
      '<div class="modal-body"><div class="preview"><b>' + TT("Requested by", "مقدم الطلب") + ":</b> " + esc4(req.requester_email) +
      "<br><b>" + TT("Reason", "السبب") + ":</b> " + esc4(req.reason || "") +
      "<br><b>" + TT("Impact", "الأثر") + ":</b> <code style=\"font-size:11px\">" + esc4(JSON.stringify(req.impact || {})) + "</code></div>" +
      '<div class="form-grid"><div class="field"><label>' + TT("Email code", "رمز البريد") + '</label><div style="display:flex;gap:6px"><input id="acct_ap_code" maxlength="8">' +
      '<button class="btn sm ghost" id="acct_ap_send" type="button">' + TT("Send code", "إرسال الرمز") + '</button></div></div>' +
      '<div class="field wide"><label>' + TT("Note", "ملاحظة") + '</label><input id="acct_ap_note"></div></div>' +
      '<div id="acct_ap_msg" class="muted small"></div></div>' +
      '<div class="modal-foot"><button class="btn ghost" onclick="closeEditor()">' + TT("Cancel", "إلغاء") + "</button>" +
      '<button class="btn" id="acct_ap_go">' + (approve ? TT("Approve & Execute", "موافقة وتنفيذ") : TT("Reject", "رفض")) + "</button></div></div></div>";
    document.body.classList.add("modal-open");
    var msg = function (t) { var el = document.getElementById("acct_ap_msg"); if (el) el.textContent = t; };
    document.getElementById("acct_ap_send").onclick = function () {
      msg(TT("Sending code…", "جارٍ إرسال الرمز…"));
      edgeFn("auth-code", { op: "send", email: a.email, purpose: "verify", name: a.name }).then(function (r) {
        msg(r && r.ok ? TT("Code sent.", "تم الإرسال.") : String((r && r.error) || "error"));
      });
    };
    document.getElementById("acct_ap_go").onclick = function () {
      var code = (document.getElementById("acct_ap_code").value || "").trim();
      if (!code) { msg(TT("Enter the emailed code.", "أدخل الرمز.")); return; }
      msg(TT("Working…", "جارٍ التنفيذ…"));
      rpc("acct_decide_approval", {
        actor: a, p_code: code, p_request_id: req.id, p_approve: !!approve,
        p_note: document.getElementById("acct_ap_note").value || null,
      }).then(function (r) {
        try { closeEditor(); } catch (e) {}
        toast4(r && r.status === "executed" ? TT("Approved and executed.", "تمت الموافقة والتنفيذ.")
          : r && r.status === "rejected" ? TT("Rejected.", "تم الرفض.")
          : TT("Finished with status: ", "انتهى بحالة: ") + ((r && r.status) || "?"));
        refresh();
      }).catch(function (e) { msg(String(e.message || e)); });
    };
  }
  window.acctDecide = function (reqId, approve) {
    var req = ACCT.approvals.filter(function (x) { return x.id === reqId; })[0];
    if (req) approvalCodeModal(req, approve);
  };

  /* ---------------- write interception ---------------- */
  function readModalTxn(coll) {
    var g = function (k) { var el = document.getElementById("ed_" + k); return el ? (el.type === "checkbox" ? el.checked : el.value) : null; };
    var n = function (k) { var v = g(k); return v == null || v === "" ? null : Number(v); };
    var kind = COLL_KIND[coll];
    var qty = n("quantity");
    var amount;
    if (coll === "materials") amount = (qty && n("unitPrice")) ? Core.round2(qty * n("unitPrice")) : (n("unitPrice") || n("amount"));
    else if (coll === "projectLabor") amount = (qty && n("rate")) ? Core.round2(qty * n("rate")) : (n("rate") || n("amount"));
    else amount = n("amount");
    var status = LEGACY_TO_STATUS[g("status")] || "pending";
    var fxEl = document.getElementById("ed_fxRate");
    var fxVal = fxEl ? Number(fxEl.value) : null;
    var prefilled = fxEl ? Number(fxEl.getAttribute("data-acct-prefill") || "0") : 0;
    var txn = {
      project_id: g("projectId"),
      kind: kind,
      category: g("materialCategory") || g("category") || g("expenseType") || g("fundingSource") || g("trade") || null,
      description: g("itemName") || g("description") || g("notes") || null,
      supplier: null,
      quantity: qty,
      unit: g("unit"),
      amount: amount,
      currency: (g("currency") || "IQD").toUpperCase(),
      date: g("date") || null,
      status: status,
      payment_source: g("paymentSource") || null,
      external_ref: g("invoiceNumber") || g("referenceNumber") || null,
      client_key: uuid4(),
    };
    try {
      var supEl = document.getElementById("ed_supplierId");
      if (supEl && supEl.selectedIndex >= 0) txn.supplier = supEl.options[supEl.selectedIndex].text;
    } catch (e) {}
    // Exchange-rate: only an actual change from the prefilled default is an override.
    if (fxVal && fxVal > 0 && (!prefilled || Math.abs(fxVal - prefilled) > 1e-9)) txn.exchange_rate = fxVal;
    // Fee override panel (authorized users only; rendered by decorateModal).
    var ovOn = document.getElementById("acct_fee_ov_on");
    if (ovOn && ovOn.checked) {
      var method = (document.getElementById("acct_fee_method") || {}).value || "percentage";
      txn.fee_override = {
        method: method,
        rate: Number((document.getElementById("acct_fee_rate") || {}).value || 0) / 100,
        fixed: Number((document.getElementById("acct_fee_fixed") || {}).value || 0),
        treatment: (document.getElementById("acct_fee_treatment") || {}).value || undefined,
        waiver_reason: (document.getElementById("acct_fee_waiver") || {}).value || "",
      };
    } else if (coll === "funding" && g("waived") === true) {
      txn.fee_override = { method: "waived", waived: true, waiver_reason: g("notes") || "waived from funding form" };
    }
    return txn;
  }

  var origSaveEditor = null;
  function wrapSaveEditor() {
    if (origSaveEditor) return;
    origSaveEditor = window.saveEditor;
    window.saveEditor = function () {
      var coll = null;
      try { coll = typeof coll0 !== "undefined" ? coll0 : null; } catch (e) {}
      if (!ACCT.on || !coll || !COLL_KIND[coll]) {
        var out = origSaveEditor.apply(this, arguments);
        if (ACCT.on && coll === "projects") setTimeout(pushProjectAccounting, 50);
        return out;
      }
      var editingId = null;
      try { editingId = (typeof id0 !== "undefined" && id0) ? id0 : null; } catch (e) {}
      var txn = readModalTxn(coll);
      if (!txn.project_id) { toast4(TT("Choose a project first.", "اختر المشروع أولاً.")); return; }
      if (!txn.amount || txn.amount <= 0) { toast4(TT("Enter a positive amount.", "أدخل مبلغاً موجباً.")); return; }
      if (!entryScopeOk(txn.project_id)) {
        var pAcc = projectRow(txn.project_id);
        toast4(TT("Data entry for this project is assigned to: ", "إدخال بيانات هذا المشروع مُسنَد إلى: ")
          + emailList(pAcc && pAcc.assigned_accountants).join(", "));
        return;
      }
      keepContext();
      var done = function (msg) {
        try { closeEditor(); } catch (e) {}
        if (msg) toast4(msg);
        refresh(false);
      };
      if (editingId) {
        var existing = ACCT.txns.filter(function (t) { return t.id === editingId; })[0];
        if (existing && ["posted", "received", "paid", "void", "reversed"].indexOf(existing.status) !== -1) {
          toast4(TT("Posted accounting records are corrected by reversal/replacement — use the void workflow.", "السجلات المرحّلة تُصحّح بالعكس/الاستبدال — استخدم مسار الإلغاء المحمي."));
          return;
        }
        rpc("acct_update_transaction", { actor: actor(), p_txn_id: editingId, changes: txn })
          .then(function () {
            var newStatus = txn.status;
            if (existing && newStatus && newStatus !== existing.status) {
              return rpc("acct_set_txn_status", { actor: actor(), p_txn_id: editingId, p_status: newStatus, p_note: null });
            }
          })
          .then(function () { done(TT("Saved to the shared accounting ledger", "تم الحفظ في السجل المحاسبي المشترك")); })
          .catch(function (e) { toast4(String(e.message || e)); });
      } else {
        rpc("acct_post_transaction", { actor: actor(), txn: txn })
          .then(function (r) {
            var fee = r && r.fee;
            if (coll === "funding" && r && r.receipt) {
              try { closeEditor(); } catch (e) {}
              refresh(false);
              receiptModal(r.receipt, r.txn);   // client-ready proof, printable immediately
              return;
            }
            // Maker-checker: the server stores every new entry as PENDING
            // APPROVAL regardless of the status picked — say so plainly.
            if (r && r.entered_pending) {
              done(TT("Saved as PENDING APPROVAL — the assigned approver (a different user) approves it before it counts.",
                "حُفظ بانتظار الاعتماد — يعتمده المعتمِد المخوّل (مستخدم آخر) قبل أن يُحتسب."));
              return;
            }
            done(fee && fee.fee_amount ? TT("Saved — consultancy fee ", "تم الحفظ — أتعاب استشارية ") + nmoney(Number(fee.fee_amount), fee.currency) + " (" + fee.status + ")"
              : TT("Saved to the shared accounting ledger", "تم الحفظ في السجل المحاسبي المشترك"));
          })
          .catch(function (e) { toast4(String(e.message || e)); });
      }
    };
  }

  function pushProjectAccounting() {
    // After the legacy project editor saves the blob record, mirror the
    // accounting configuration into the relational registry.
    try {
      var pid = window.__acctLastProjectId || null;
      var rec = pid ? (state.projects || []).filter(function (p) { return p.id === pid; })[0]
        : (state.projects || [])[0];
      if (!rec) return;
      var payload = {
        id: rec.id, code: rec.code || null, name: rec.name || null, client: rec.clientName || null,
        region: rec.region || null, type: rec.type || null, status: rec.status || null,
        currency: rec.currency || null, contract_value: rec.contractValue != null ? rec.contractValue : null,
        approved_budget: rec.approvedBudget != null ? rec.approvedBudget : null,
        budget_currency: rec.budgetCurrency || null,
      };
      var fxEl = document.getElementById("acct_prj_fx");
      // Project-level accounting fields from the injected panel, when present.
      ["acct_prj_fx", "acct_prj_budget", "acct_prj_budget_cur", "acct_prj_fee_inherit", "acct_prj_fee_method",
        "acct_prj_fee_rate", "acct_prj_fee_fixed", "acct_prj_fee_basis", "acct_prj_fee_treatment"].forEach(function () {});
      if (document.getElementById("acct_prj_panel_present")) {
        payload.default_exchange_rate = Number((document.getElementById("acct_prj_fx") || {}).value || "") || null;
        payload.approved_budget = Number((document.getElementById("acct_prj_budget") || {}).value || "") || payload.approved_budget;
        payload.budget_currency = (document.getElementById("acct_prj_budget_cur") || {}).value || payload.budget_currency;
        var inh = document.getElementById("acct_prj_fee_inherit");
        payload.fee_inherit = inh ? !!inh.checked : undefined;
        if (inh && !inh.checked) {
          payload.fee_method = (document.getElementById("acct_prj_fee_method") || {}).value || "percentage";
          payload.fee_rate = Number((document.getElementById("acct_prj_fee_rate") || {}).value || 0) / 100;
          payload.fee_fixed = Number((document.getElementById("acct_prj_fee_fixed") || {}).value || 0);
          payload.fee_basis = (document.getElementById("acct_prj_fee_basis") || {}).value || "funding";
          payload.fee_treatment = (document.getElementById("acct_prj_fee_treatment") || {}).value || "deduct_from_funding";
        }
        var accs = readPicker("acct_prj_accountants");
        var apprs = readPicker("acct_prj_approvers");
        if (accs !== null) payload.assigned_accountants = accs;
        if (apprs !== null) payload.assigned_approvers = apprs;
      } else if (rec.consultancyRate != null && rec.consultancyRate !== "") {
        payload.fee_inherit = false;
        payload.fee_method = "percentage";
        payload.fee_rate = Number(rec.consultancyRate) || 0;
        payload.fee_basis = "funding";
        payload.fee_treatment = "deduct_from_funding";
      }
      rpc("acct_upsert_project", { actor: actor(), p: payload })
        .then(function () { refresh(); })
        .catch(function (e) { console.warn("[acct-cloud] project push:", e); });
    } catch (e) { console.warn(e); }
  }

  /* One consultancy-fee source of truth. The funding form used to carry
     a second, legacy "Consultancy %" box that sat at 0 and had no say in
     the posted fee — two visible rates for one number. The field is
     removed; the resolved rule panel below the form is the only place a
     rate is shown or overridden. */
  function wrapFundingSchema() {
    try {
      if (typeof SCHEMA === "undefined" || !SCHEMA || !SCHEMA.funding) return;
      SCHEMA.funding = SCHEMA.funding.filter(function (f) {
        return !f || f.k !== "consultancyRate";
      });
    } catch (e) { /* engine not ready; the fee panel still governs */ }
  }

  var origOpenEditor = null;
  function wrapOpenEditor() {
    if (origOpenEditor) return;
    origOpenEditor = window.openEditor;
    window.openEditor = function (coll, id, seed) {
      var out = origOpenEditor.apply(this, arguments);
      try { window.__acctLastProjectId = coll === "projects" ? id : window.__acctLastProjectId; } catch (e) {}
      if (ACCT.on) setTimeout(function () { decorateModal(coll, id); }, 60);
      return out;
    };
  }

  function decorateModal(coll, id) {
    var body = document.querySelector("#modalRoot .modal-body");
    if (!body) return;
    if (COLL_KIND[coll]) {
      var pid = window.__larsaReturnProjectId || (document.getElementById("ed_projectId") || {}).value || "";
      // Project-locked context: preselect + lock, prefill date/currency/rate/fee.
      var pj = document.getElementById("ed_projectId");
      if (pj && window.__larsaReturnProjectId) {
        pj.value = window.__larsaReturnProjectId;
        pj.setAttribute("data-acct-locked", "1");
        pj.disabled = true;
        pid = window.__larsaReturnProjectId;
      }
      var d = document.getElementById("ed_date");
      if (d && !d.value) { try { d.value = today(); } catch (e) {} }
      var proj = projectRow(pid);
      var cur = document.getElementById("ed_currency");
      if (cur && proj && !id) cur.value = proj.currency || cur.value;
      var fx = document.getElementById("ed_fxRate");
      var rr = resolvedRateFor(pid);
      if (fx) {
        if (!fx.value || Number(fx.value) <= 0) fx.value = rr.rate;
        if (!id) fx.setAttribute("data-acct-prefill", String(rr.rate));
      }
      // Maker-checker: entry and approval are two different people.
      // Hide the counted statuses this actor cannot lawfully set on this
      // record (the server enforces the same rule regardless).
      try {
        var stSel = document.getElementById("ed_status");
        if (stSel && stSel.options) {
          var editingRec = id ? ACCT.txns.filter(function (t) { return t.id === id; })[0] : null;
          var mineRec = !id || !editingRec || String(editingRec.created_by_email || "").toLowerCase() === myEmailLc();
          var mayCount = myPerm("approve") && (!mineRec || myPerm("self_approve"))
            && approverScope(pid, COLL_KIND[coll]).ok;
          if (!mayCount) {
            for (var oi = stSel.options.length - 1; oi >= 0; oi--) {
              var mappedSt = LEGACY_TO_STATUS[stSel.options[oi].value] || "draft";
              if (["approved", "posted", "received", "paid"].indexOf(mappedSt) !== -1) stSel.remove(oi);
            }
            if (!stSel.options.length) {
              var dOpt = document.createElement("option");
              dOpt.value = "Pending Approval"; dOpt.text = TT("Pending Approval", "بانتظار الاعتماد");
              stSel.add(dOpt);
            }
            // New entries default to Pending Approval — entered by one
            // person, approved by another (Draft stays available for
            // deliberately unfinished work).
            if (!id) {
              for (var qi = 0; qi < stSel.options.length; qi++) {
                if (stSel.options[qi].value === "Pending Approval" || stSel.options[qi].value === "Pending") {
                  stSel.value = stSel.options[qi].value;
                  break;
                }
              }
            }
            if (!document.getElementById("acct_mkchk_hint")) {
              var hint = document.createElement("p");
              hint.id = "acct_mkchk_hint";
              hint.className = "muted small";
              hint.textContent = TT("Entries are saved as Pending Approval — the assigned approver (a different user) reviews and approves them before they count.",
                "القيود تُحفظ بانتظار الاعتماد — يراجعها ويعتمدها المعتمِد المخوّل (مستخدم آخر) قبل أن تُحتسب.");
              var hostEl = (stSel.closest && stSel.closest(".field")) || stSel.parentNode;
              if (hostEl && hostEl.appendChild) hostEl.appendChild(hint);
            }
          }
        }
      } catch (e) {}
      // Fee panel: resolved rule + authorized transaction-level override.
      if (!document.getElementById("acct_fee_panel")) {
        var kind = COLL_KIND[coll];
        var catEl = document.getElementById("ed_materialCategory") || document.getElementById("ed_category") || document.getElementById("ed_expenseType");
        var rule = resolvedFeeRuleFor(pid, kind, catEl ? catEl.value : null);
        var eligible = Core.feeEligible(kind, catEl ? catEl.value : null, rule);
        var ruleText = rule.method === "percentage"
          ? (Core.round2(rule.rate * 100)) + "% · " + rule.basis + " · " + rule.treatment
          : rule.method + " · " + rule.basis + " · " + rule.treatment;
        var div = document.createElement("div");
        div.id = "acct_fee_panel";
        div.className = "preview";
        // The single fee source of truth, stated in full: what rate applies,
        // where the rate comes from, what it is charged on, how it is
        // treated, and — live as the amount is typed — the fee and the net
        // construction funding that results.
        var RULE_SOURCE_TEXT = {
          transaction_override: TT("this entry's override", "تجاوز خاص بهذا القيد"),
          category_override: TT("category rule", "قاعدة البند"),
          project_default: TT("project default", "افتراضي المشروع"),
          platform_default: TT("platform default", "افتراضي المنصة"),
        };
        div.innerHTML =
          "<b>" + TT("Consultancy fee rule", "قاعدة أتعاب الاستشارة") + "</b>" +
          '<div class="form-grid" style="margin-top:4px">' +
          '<div class="field"><label class="small">' + TT("Effective rate", "النسبة الفعلية") + "</label><div><b>" +
            esc4(rule.method === "percentage" ? Core.round2(rule.rate * 100) + "%" : (rule.method === "waived" ? TT("Waived", "معفاة") : nmoney(rule.fixed || 0, (proj || {}).currency || "IQD"))) + "</b></div></div>" +
          '<div class="field"><label class="small">' + TT("Rule source", "مصدر القاعدة") + "</label><div>" +
            esc4(RULE_SOURCE_TEXT[rule.source] || rule.source || "—") + "</div></div>" +
          '<div class="field"><label class="small">' + TT("Fee basis", "أساس الاحتساب") + "</label><div>" + esc4(rule.basis || "—") + "</div></div>" +
          '<div class="field"><label class="small">' + TT("Accounting treatment", "المعالجة المحاسبية") + "</label><div>" + esc4(rule.treatment || "—") + "</div></div>" +
          '<div class="field"><label class="small">' + TT("Fee amount", "مبلغ الأتعاب") + '</label><div><b id="acct_fee_amt">—</b></div></div>' +
          '<div class="field"><label class="small">' + TT("Net construction funding", "صافي أموال التنفيذ") + '</label><div><b id="acct_fee_net">—</b></div></div>' +
          "</div>" +
          (eligible ? "" : '<p class="muted small">' + TT("This fee rule does not apply to this entry.", "لا تنطبق قاعدة الأتعاب على هذا القيد.") + "</p>") +
          (canWriteAcct()
            ? '<label class="small" style="display:block;margin-top:6px"><input type="checkbox" id="acct_fee_ov_on"> ' + TT("Override for this transaction only", "تجاوز لهذه الحركة فقط") + "</label>" +
              '<div id="acct_fee_ov" style="display:none;margin-top:6px" class="form-grid">' +
              '<div class="field"><label>' + TT("Method", "الطريقة") + '</label><select id="acct_fee_method"><option value="percentage">Percentage</option><option value="fixed_per_transaction">Fixed per transaction</option><option value="fixed_per_project">Fixed per project</option><option value="waived">Waived</option></select></div>' +
              '<div class="field"><label>' + TT("Rate %", "النسبة %") + '</label><input id="acct_fee_rate" type="number" step="0.1" value="' + Core.round2(rule.rate * 100) + '"></div>' +
              '<div class="field"><label>' + TT("Fixed amount", "مبلغ ثابت") + '</label><input id="acct_fee_fixed" type="number" value="' + (rule.fixed || 0) + '"></div>' +
              '<div class="field"><label>' + TT("Treatment", "المعالجة") + '</label><select id="acct_fee_treatment">' +
              ["deduct_from_funding", "project_expense", "larsa_revenue", "custom"].map(function (t) { return '<option value="' + t + '"' + (t === rule.treatment ? " selected" : "") + ">" + t + "</option>"; }).join("") +
              "</select></div>" +
              '<div class="field wide"><label>' + TT("Waiver reason (required when waiving)", "سبب الإعفاء (إلزامي عند الإعفاء)") + '</label><input id="acct_fee_waiver"></div>' +
              "</div>"
            : "");
        body.appendChild(div);
        var ov = document.getElementById("acct_fee_ov_on");
        if (ov) ov.onchange = function () {
          var p = document.getElementById("acct_fee_ov");
          if (p) p.style.display = ov.checked ? "" : "none";
          recalcFeePreview();
        };
        var recalcFeePreview = function () {
          var amtEl = document.getElementById("ed_amount");
          var curEl = document.getElementById("ed_currency");
          var amt = amtEl ? Number(amtEl.value || 0) : 0;
          var c = (curEl ? curEl.value : (proj || {}).currency) || "IQD";
          var live = rule;
          var ovOnEl = document.getElementById("acct_fee_ov_on");
          if (ovOnEl && ovOnEl.checked) {
            live = {
              method: (document.getElementById("acct_fee_method") || {}).value || "percentage",
              rate: Number((document.getElementById("acct_fee_rate") || {}).value || 0) / 100,
              fixed: Number((document.getElementById("acct_fee_fixed") || {}).value || 0),
              treatment: (document.getElementById("acct_fee_treatment") || {}).value || rule.treatment,
              basis: rule.basis,
            };
          }
          var feeAmt = 0;
          if (eligible && amt > 0) {
            if (live.method === "percentage") feeAmt = Core.round2(amt * Number(live.rate || 0));
            else if (live.method === "fixed_per_transaction") feeAmt = Core.round2(Number(live.fixed || 0));
            else if (live.method === "fixed_per_project") feeAmt = Core.round2(Number(live.fixed || 0));
          }
          var feeEl = document.getElementById("acct_fee_amt");
          var netEl = document.getElementById("acct_fee_net");
          if (feeEl) feeEl.textContent = amt > 0 ? nmoney(feeAmt, c) : "—";
          if (netEl) {
            netEl.textContent = amt > 0
              ? nmoney(Core.round2(amt - (live.treatment === "deduct_from_funding" ? feeAmt : 0)), c)
              : "—";
          }
        };
        ["ed_amount", "ed_currency", "acct_fee_rate", "acct_fee_fixed", "acct_fee_method", "acct_fee_treatment"]
          .forEach(function (elId) {
            var el = document.getElementById(elId);
            if (el) { el.addEventListener("input", recalcFeePreview); el.addEventListener("change", recalcFeePreview); }
          });
        recalcFeePreview();
      }
    }
    if (coll === "projects" && !document.getElementById("acct_prj_panel_present")) {
      var ap = id ? projectRow(id) : null;
      var s = ACCT.settings || {};
      var inherit = !ap || ap.fee_inherit !== false;
      var wrap = document.createElement("div");
      wrap.id = "acct_prj_panel_present";
      wrap.className = "preview";
      wrap.innerHTML =
        "<b>" + TT("Accounting defaults (this project)", "الإعدادات المحاسبية الافتراضية (هذا المشروع)") + "</b>" +
        '<div class="form-grid" style="margin-top:6px">' +
        '<div class="field"><label>' + TT("Approved project budget", "الموازنة المعتمدة للمشروع") + '</label><input id="acct_prj_budget" type="number" value="' + (ap && ap.approved_budget != null ? ap.approved_budget : "") + '"></div>' +
        '<div class="field"><label>' + TT("Budget currency", "عملة الموازنة") + '</label><select id="acct_prj_budget_cur"><option value="">' + TT("Project currency", "عملة المشروع") + "</option>" +
        ["IQD", "USD"].map(function (c) { return '<option value="' + c + '"' + (ap && ap.budget_currency === c ? " selected" : "") + ">" + c + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>' + TT("Default exchange rate (1 USD = X IQD)", "سعر الصرف الافتراضي (١ دولار = X دينار)") + '</label><input id="acct_prj_fx" type="number" placeholder="' + esc4(TT("Inherit platform: ", "وراثة المنصة: ") + (s.default_exchange_rate || "")) + '" value="' + (ap && ap.default_exchange_rate != null ? ap.default_exchange_rate : "") + '"></div>' +
        '<div class="field"><label><input type="checkbox" id="acct_prj_fee_inherit"' + (inherit ? " checked" : "") + "> " + TT("Inherit platform consultancy fee", "وراثة أتعاب الاستشارة من المنصة") + " (" + Core.round2((s.default_fee_rate || 0) * 100) + "%)</label></div>" +
        '<div id="acct_prj_fee_cfg" class="form-grid wide" style="' + (inherit ? "display:none" : "") + '">' +
        '<div class="field"><label>' + TT("Method", "الطريقة") + '</label><select id="acct_prj_fee_method">' +
        ["percentage", "fixed_per_project", "fixed_per_transaction", "waived"].map(function (m) { return '<option value="' + m + '"' + (ap && ap.fee_method === m ? " selected" : "") + ">" + m + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>' + TT("Rate %", "النسبة %") + '</label><input id="acct_prj_fee_rate" type="number" step="0.1" value="' + (ap && ap.fee_rate != null ? Core.round2(ap.fee_rate * 100) : 8) + '"></div>' +
        '<div class="field"><label>' + TT("Fixed amount", "مبلغ ثابت") + '</label><input id="acct_prj_fee_fixed" type="number" value="' + (ap && ap.fee_fixed != null ? ap.fee_fixed : 0) + '"></div>' +
        '<div class="field"><label>' + TT("Calculation basis", "أساس الاحتساب") + '</label><select id="acct_prj_fee_basis">' +
        ["funding", "income", "total_expenses", "materials_only", "labor_only", "expense_categories", "custom"].map(function (b) { return '<option value="' + b + '"' + (ap && ap.fee_basis === b ? " selected" : "") + ">" + b + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>' + TT("Accounting treatment", "المعالجة المحاسبية") + '</label><select id="acct_prj_fee_treatment">' +
        ["deduct_from_funding", "project_expense", "larsa_revenue", "custom"].map(function (t) { return '<option value="' + t + '"' + (ap && ap.fee_treatment === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div>" +
        "</div></div>" +
        '<div class="form-grid" style="margin-top:6px">' +
        '<div class="field wide"><label>' + TT("Assigned accountants — who enters data", "المحاسبون المكلفون — من يُدخل البيانات") + "</label>" +
        rosterPicker("acct_prj_accountants", ap && ap.assigned_accountants) + "</div>" +
        '<div class="field wide"><label>' + TT("Assigned approvers — who reviews and approves", "المعتمِدون المكلفون — من يراجع ويعتمد") + "</label>" +
        rosterPicker("acct_prj_approvers", ap && ap.assigned_approvers) + "</div>" +
        "</div>" +
        '<p class="muted small">' + TT("The person who enters an entry never approves it — entries wait as Pending Approval for the assigned approver (self-approval only via the explicit permission).", "من يُدخل القيد لا يعتمده — تبقى القيود بانتظار الاعتماد للمعتمِد المكلف (الاعتماد الذاتي فقط عبر الصلاحية الصريحة).") + "</p>" +
        '<p class="muted small">' + TT("Changing these defaults affects FUTURE entries only. Historical transactions keep their permanent rate and fee snapshots.", "تغيير هذه الافتراضيات يخص القيود المستقبلية فقط. القيود التاريخية تحتفظ بلقطاتها الدائمة للسعر والأتعاب.") + "</p>";
      body.appendChild(wrap);
      var inhEl = document.getElementById("acct_prj_fee_inherit");
      if (inhEl) inhEl.onchange = function () {
        var cfgEl = document.getElementById("acct_prj_fee_cfg");
        if (cfgEl) cfgEl.style.display = inhEl.checked ? "none" : "";
      };
    }
  }

  var origDelRec = null;
  function wrapDelRec() {
    if (origDelRec) return;
    origDelRec = window.delRec;
    window.delRec = function (coll, id) {
      if (!ACCT.on || !COLL_KIND[coll]) return origDelRec.apply(this, arguments);
      var txnRow = ACCT.txns.filter(function (t) { return t.id === id; })[0];
      if (!txnRow) return origDelRec.apply(this, arguments);
      if (["posted", "received", "paid"].indexOf(txnRow.status) !== -1) {
        protectedActionModal("void_posted_transaction",
          TT("Void posted transaction ", "إلغاء حركة مرحّلة ") + txnRow.txn_no, txnRow.project_id,
          { txn_id: id },
          TT("Posted records are never erased — this voids ", "السجلات المرحّلة لا تُمحى أبداً — سيتم إلغاء ") + esc4(txnRow.txn_no) +
          " (" + nmoney(Number(txnRow.original_amount), txnRow.original_currency) + ")" +
          TT(" and reverses its consultancy fee. Restorable later.", " مع عكس أتعابها الاستشارية. قابل للاسترجاع لاحقاً."));
        return;
      }
      var reason = prompt(TT("Reason for deleting this draft (kept in the audit history):", "سبب حذف هذه المسودة (يُحفظ في سجل التدقيق):"));
      if (reason == null) return;
      if (!String(reason).trim()) { toast4(TT("A reason is required.", "السبب إلزامي.")); return; }
      keepContext();
      rpc("acct_soft_delete", { actor: actor(), p_txn_id: id, p_reason: reason })
        .then(function () { toast4(TT("Moved to deleted (restorable) records.", "نُقل إلى السجلات المحذوفة (قابلة للاسترجاع).")); refresh(false); })
        .catch(function (e) { toast4(String(e.message || e)); });
    };
  }

  var origXApprove = null;
  function wrapApprove() {
    if (origXApprove) return;
    origXApprove = window.xApprove;
    if (typeof origXApprove !== "function") return;
    window.xApprove = function (coll, id) {
      if (!ACCT.on || !COLL_KIND[coll]) return origXApprove.apply(this, arguments);
      var t = ACCT.txns.filter(function (x) { return x.id === id; })[0];
      if (!t) return origXApprove.apply(this, arguments);
      // Maker-checker guard (the server enforces the same rules):
      if (!myPerm("approve")) {
        toast4(TT("Your permissions do not include approving entries.", "صلاحياتك لا تشمل اعتماد القيود."));
        return;
      }
      var scope = approverScope(t.project_id, t.kind);
      if (!scope.ok) {
        toast4(TT("Approval for ", "الاعتماد لـ") + scope.what + TT(" is assigned to: ", " مُسنَد إلى: ") + scope.who);
        return;
      }
      if (String(t.created_by_email || "").toLowerCase() === myEmailLc() && !myPerm("self_approve")) {
        toast4(TT("You entered this record — a different authorized user must approve it.",
          "أنت من أدخل هذا القيد — يجب أن يعتمده مستخدم آخر مخوّل."));
        return;
      }
      keepContext();
      var target = t.kind === "funding" ? "received" : "approved";
      rpc("acct_set_txn_status", { actor: actor(), p_txn_id: id, p_status: target, p_note: null })
        .then(function () { refresh(false); })
        .catch(function (e) { toast4(String(e.message || e)); });
    };
  }

  /* ---------------- project workspace: §4 summary + progress + refunds ---------------- */
  function pct(v) { return v == null ? TT("Not Available", "غير متاح") : (Core.round2(v) + "%"); }
  function iqd(v) { return nmoney(Core.round2(v), "IQD"); }

  function kindReviewInfo(pid, kinds) {
    var statuses = [], pending = 0, correction = 0, working = 0, approved = 0;
    ACCT.txns.forEach(function (t) {
      if (t.project_id !== pid || t.deleted_at) return;
      if (["void", "reversed", "rejected"].indexOf(t.status) !== -1) return;
      if (kinds.indexOf(t.kind) === -1) return;
      statuses.push(t.review_status);
      working = Core.round2(working + Number(t.amount_iqd || 0));
      if (t.review_status === "approved") approved = Core.round2(approved + Number(t.amount_iqd || 0));
      else if (t.review_status === "needs_correction") correction = Core.round2(correction + Number(t.amount_iqd || 0));
      else pending = Core.round2(pending + Number(t.amount_iqd || 0));
    });
    return { status: Core.aggregateStatus(statuses), working: working, approved: approved, pending: pending, correction: correction };
  }
  function statusDot(st) {
    if (!st) return "";
    var color = st === "green" ? "#1a7f37" : st === "yellow" ? "#b58900" : "#c62828";
    var label = st === "green" ? TT("Approved", "مُعتمد") : st === "yellow" ? TT("Pending review", "قيد المراجعة") : TT("Needs correction", "يحتاج تصحيحاً");
    return ' <span title="' + label + '" style="color:' + color + '">●</span>';
  }
  /* Sample records are marked wherever they appear, so a demonstration
     figure is never mistaken for a real one. */
  function sampleBadge(isSample) {
    return isSample
      ? ' <span class="acct-sample-badge" title="' + TT("Demonstration record — removable through the protected action in Settings", "سجل تجريبي — يُزال عبر الإجراء المحمي في الإعدادات") +
        '" style="display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.05em;padding:1px 5px;border-radius:3px;background:#eef2ff;color:#3949ab;border:1px solid #c5cae9;vertical-align:middle">' +
        TT("SAMPLE", "تجريبي") + "</span>"
      : "";
  }

  function summaryCardHTML(p) {
    var s = Core.projectSummary(p._acct || { id: p.id, currency: p.currency, approved_budget: p.approvedBudget, budget_currency: p.budgetCurrency, contract_value: p.contractValue }, ACCT.txns, ACCT.fees, ACCT.progress);
    var fin = finFor(p.id);
    if (fin) return authoritativeSummaryHTML(p, fin, s);
    var rv = {
      funding: kindReviewInfo(p.id, ["funding"]),
      material: kindReviewInfo(p.id, ["material"]),
      labor: kindReviewInfo(p.id, ["labor"]),
      expense: kindReviewInfo(p.id, ["expense"]),
      cost: kindReviewInfo(p.id, ["material", "labor", "expense"]),
      all: kindReviewInfo(p.id, ["funding", "material", "labor", "expense", "revenue", "refund"]),
    };
    var row = function (label, val, cls) {
      return '<tr><td>' + label + '</td><td class="right ' + (cls || "") + '">' + val + "</td></tr>";
    };
    var budgetTxt = s.approved_budget
      ? nmoney(s.approved_budget, s.budget_currency)
      : TT("Not Available", "غير متاح");
    var costTxt = s.cost_progress_pct == null
      ? TT("Not Available (no approved budget)", "غير متاح (لا توجد موازنة معتمدة)")
      : Core.round2(s.cost_progress_pct) + "% — " +
        (s.budget_currency === "IQD" ? iqd(s.actual_construction_cost_iqd) : nmoney(s.actual_construction_cost_usd, "USD")) +
        TT(" of ", " من ") + nmoney(s.approved_budget, s.budget_currency);
    var schedTxt = s.schedule_progress_pct == null
      ? TT("No updates yet", "لا توجد تحديثات بعد")
      : Core.round2(s.schedule_progress_pct) + "% · " + esc4(s.schedule_progress_date || "") +
        (s.schedule_progress_by ? " · " + esc4(s.schedule_progress_by) : "");
    return (
      '<div class="card" id="acct_summary_card"><h3>' + TT("Project Financial Summary (authoritative ledger)", "الملخص المالي للمشروع (السجل المعتمد)") + "</h3>" +
      '<div class="table-wrap"><table><tbody>' +
      row(TT("Contract Value", "قيمة العقد"), s.contract_value != null ? nmoney(s.contract_value, p.currency || "IQD") : "—") +
      row(TT("Approved Project Budget", "الموازنة المعتمدة"), budgetTxt) +
      row(TT("Gross Funding Received", "إجمالي التمويل المستلم") + statusDot(rv.funding.status), iqd(s.gross_funding_iqd) + ' <span class="muted small">/ ' + nmoney(s.gross_funding_usd, "USD") + "</span>") +
      row(TT("Initial Consultancy Fee", "أتعاب الاستشارة الأولية"), iqd(s.initial_fee_iqd)) +
      row(TT("Net Construction Funding", "صافي تمويل التنفيذ"), iqd(s.net_construction_funding_iqd)) +
      row(TT("Materials", "المواد") + statusDot(rv.material.status), iqd(s.materials_iqd)) +
      row(TT("Labor", "العمالة") + statusDot(rv.labor.status), iqd(s.labor_iqd)) +
      row(TT("Other Project Expenses", "مصاريف المشروع الأخرى") + statusDot(rv.expense.status), iqd(s.other_expenses_iqd)) +
      row("<b>" + TT("Actual Construction Cost", "كلفة التنفيذ الفعلية") + "</b>" + statusDot(rv.cost.status), "<b>" + iqd(s.actual_construction_cost_iqd) + "</b>") +
      row(TT("Total Used", "إجمالي المستخدم"), iqd(s.total_used_iqd)) +
      row(TT("Remaining Unused Balance", "الرصيد غير المستخدم"), iqd(s.remaining_unused_iqd)) +
      row(TT("Refundable Consultancy Fee", "أتعاب الاستشارة القابلة للإرجاع"), iqd(s.refundable_fee_iqd)) +
      row("<b>" + TT("Total Refund Due to Client", "إجمالي المسترجع المستحق للعميل") + "</b>", "<b>" + iqd(s.total_refund_due_iqd) + "</b>") +
      row(TT("Final Consultancy Fee Retained by Larsa", "أتعاب الاستشارة النهائية المحتفظ بها"), iqd(s.final_fee_retained_iqd)) +
      row(TT("Fee recorded as separate Larsa revenue", "أتعاب مسجلة كإيراد منفصل لـ لارسا"), iqd(s.fee_as_larsa_revenue_iqd)) +
      row(TT("Pending Commitments", "الالتزامات المعلقة"), iqd(s.pending_commitments_iqd)) +
      row(TT("Refunded so far (principal)", "المسترجع حتى الآن (أصل)"), iqd(s.refunded_principal_iqd)) +
      row("<b>" + TT("Cost Progress", "التقدم الكلفوي") + "</b>" + statusDot(rv.cost.status), costTxt) +
      row("<b>" + TT("Schedule / Physical Progress", "التقدم الزمني/الفعلي") + "</b>", schedTxt) +
      "</tbody></table></div>" +
      (rv.all.status && rv.all.status !== "green"
        ? '<p class="muted small" style="color:' + (rv.all.status === "red" ? "#c62828" : "#b58900") + '">' +
          (rv.all.correction > 0 ? TT("Contains ", "يحتوي ") + iqd(rv.all.correction) + TT(" needing correction. ", " بحاجة إلى تصحيح. ") : "") +
          (rv.all.pending > 0 ? TT("Contains ", "يحتوي ") + iqd(rv.all.pending) + TT(" pending approval.", " بانتظار الموافقة.") : "") +
          " " + TT("Amounts are complete Working Totals — approval changes reliability, never the numbers.",
            "المبالغ إجماليات عمل كاملة — الاعتماد يغيّر الموثوقية لا الأرقام.") + "</p>"
        : "") +
      '<div class="rpt-actions" style="margin-top:8px">' +
      (canWriteAcct() || engineUser().role === "Project Manager" || engineUser().role === "Construction Engineer"
        ? '<button class="btn sm" onclick="acctUpdateProgress(\'' + p.id + '\')">' + TT("Update Progress", "تحديث التقدم") + "</button>" : "") +
      (canWriteAcct() && s.total_refund_due_iqd > 0
        ? '<button class="btn sm ghost" onclick="acctRefundModal(\'' + p.id + '\')">' + TT("Refund unused funding…", "إرجاع التمويل غير المستخدم…") + "</button>" : "") +
      '<button class="btn sm ghost" onclick="acctFundingStatementPrint(\'' + p.id + '\')">' + TT("Funding Statement", "كشف التمويل") + "</button>" +
      '<button class="btn sm ghost" onclick="acctShowHistory(\'' + p.id + '\')">' + TT("Accounting History", "السجل المحاسبي") + "</button>" +
      "</div></div>"
    );
  }

  /* ---------------- the authoritative project summary card ----------------
     Two clearly separated blocks. Client construction funds are money
     held and managed for the project; Larsa company accounting is what
     the company actually earned. Approved and Working figures are shown
     side by side — approval changes reliability, never the amount. */
  function reliabilityBanner(review) {
    var st = (review || {}).status || "green";
    if (st === "green") {
      return '<p class="small" style="color:#1a7f37;margin:6px 0 0">✔ ' +
        TT("All entries approved.", "جميع القيود معتمدة.") + "</p>";
    }
    var icon = st === "red" ? "✖" : "⏳";
    var color = st === "red" ? "#c62828" : "#b58900";
    return '<p class="small" style="color:' + color + ';margin:6px 0 0">' + icon + " " +
      esc4((review || {}).label || "") + " — " +
      TT("Working Totals include every saved entry. Approval changes reliability, never the amounts.",
        "الإجماليات العملية تشمل كل قيد محفوظ. الاعتماد يغيّر الموثوقية لا المبالغ.") + "</p>";
  }

  function authoritativeSummaryHTML(p, fin, s) {
    var cf = fin.client_funds || {}, ap = cf.approved || {}, wk = cf.working || {},
        pn = cf.pending || {}, co = fin.company || {}, rev = fin.review || {};
    var rv = {
      funding: kindReviewInfo(p.id, ["funding"]),
      material: kindReviewInfo(p.id, ["material"]),
      labor: kindReviewInfo(p.id, ["labor"]),
      expense: kindReviewInfo(p.id, ["expense"]),
      cost: kindReviewInfo(p.id, ["material", "labor", "expense"]),
    };
    var row = function (label, val, cls) {
      return "<tr><td>" + label + '</td><td class="right ' + (cls || "") + '">' + val + "</td></tr>";
    };
    var pair = function (label, approvedVal, workingVal, dot) {
      return "<tr><td>" + label + (dot || "") + '</td><td class="right">' + approvedVal +
        '<div class="muted small">' + TT("working: ", "عملي: ") + workingVal + "</div></td></tr>";
    };
    var grp = function (title) {
      return '<tr class="grp-row"><td colspan="2"><b>' + title + "</b></td></tr>";
    };
    var costTxt = fin.cost_progress_pct == null
      ? TT("Not Available (no approved budget)", "غير متاح (لا توجد موازنة معتمدة)")
      : Core.round2(fin.cost_progress_pct) + "% — " + iqd(ap.construction_cost_iqd) +
        TT(" of ", " من ") + nmoney(fin.approved_budget, fin.budget_currency || p.currency || "IQD");
    var schedTxt = fin.schedule_progress_pct == null
      ? TT("No updates yet", "لا توجد تحديثات بعد")
      : Core.round2(fin.schedule_progress_pct) + "% · " + esc4(fin.schedule_progress_date || "") +
        (fin.schedule_progress_by ? " · " + esc4(fin.schedule_progress_by) : "");
    var byCur = fin.by_currency || {};
    var curLine = Object.keys(byCur).length > 1
      ? '<p class="muted small">' + TT("Original-currency totals (never added together): ", "الإجماليات بالعملة الأصلية (لا تُجمع معاً): ") +
        Object.keys(byCur).map(function (c) {
          return "<b>" + esc4(c) + "</b> " + nmoney(byCur[c].gross_funding_working, c);
        }).join(" · ") + "</p>"
      : "";

    return (
      '<div class="card" id="acct_summary_card"><h3>' +
        TT("Project Financial Summary (authoritative ledger)", "الملخص المالي للمشروع (السجل المعتمد)") +
        sampleBadge(fin.is_sample) + "</h3>" +
      '<p class="muted small">' +
        TT("Client construction funds are held and managed for the project. They are not Larsa revenue.",
          "أموال تنفيذ العميل محتجزة ومُدارة للمشروع، وليست إيراداً لـ لارسا.") + "</p>" +
      '<div class="table-wrap"><table><tbody>' +
      row(TT("Contract Value", "قيمة العقد"), fin.contract_value != null ? nmoney(fin.contract_value, p.currency || "IQD") : "—") +
      row(TT("Approved Project Budget", "الموازنة المعتمدة"),
        fin.approved_budget ? nmoney(fin.approved_budget, fin.budget_currency || p.currency || "IQD") : TT("Not Available", "غير متاح")) +

      grp(TT("A · Client Fund Control", "أ · حسابات أموال العميل")) +
      row(TT("Gross Client Funding", "إجمالي تمويل العميل") + statusDot(rv.funding.status), iqd(ap.gross_funding_iqd)) +
      row(TT("Initial Consultancy Fee", "أتعاب الاستشارة الأولية"), iqd(ap.initial_fee_iqd)) +
      row("<b>" + TT("Net Construction Funding", "صافي تمويل التنفيذ") + "</b>", "<b>" + iqd(ap.net_construction_funding_iqd) + "</b>") +
      row(TT("Materials", "المواد") + statusDot(rv.material.status), iqd(ap.materials_iqd)) +
      row(TT("Labor", "العمالة") + statusDot(rv.labor.status), iqd(ap.labor_iqd)) +
      row(TT("Other Construction Costs", "تكاليف التنفيذ الأخرى") + statusDot(rv.expense.status), iqd(ap.other_costs_iqd)) +
      row(TT("Approved Actual Cost", "الكلفة الفعلية المعتمدة") + statusDot("green"), "<b>" + iqd(ap.construction_cost_iqd) + "</b>") +
      row(TT("Pending / Unapproved Cost", "الكلفة المعلقة/غير المعتمدة") + statusDot(pn.construction_cost_iqd > 0 ? "yellow" : "green"), iqd(pn.construction_cost_iqd)) +
      row("<b>" + TT("Working Actual Cost", "الكلفة الفعلية العملية") + "</b>" + statusDot(rv.cost.status), "<b>" + iqd(wk.construction_cost_iqd) + "</b>") +
      row(TT("Total Used (incl. fee charged to project)", "إجمالي المستخدم (شامل الأتعاب المحمّلة)"), iqd(ap.total_used_iqd)) +
      row("<b>" + TT("Approved Remaining Client Balance", "رصيد العميل المتبقي المعتمد") + "</b>", "<b>" + iqd(ap.remaining_balance_iqd) + "</b>") +
      row("<b>" + TT("Working Remaining Client Balance", "رصيد العميل المتبقي العملي") + "</b>", "<b>" + iqd(wk.remaining_balance_iqd) + "</b>") +
      row(TT("Refundable Principal", "أصل المبلغ القابل للإرجاع"), iqd(cf.refundable_principal_iqd)) +
      row(TT("Refundable Consultancy Fee", "أتعاب الاستشارة القابلة للإرجاع"), iqd(cf.refundable_fee_iqd)) +
      row("<b>" + TT("Total Refund Due to Client", "إجمالي المسترجع المستحق للعميل") + "</b>", "<b>" + iqd(cf.total_refund_due_iqd) + "</b>") +
      row(TT("Refunded so far (principal)", "المسترجع حتى الآن (أصل)"), iqd(cf.refunded_principal_to_date_iqd)) +

      grp(TT("B · Larsa Company Accounting", "ب · حسابات شركة لارسا")) +
      row(TT("Consultancy Fee Revenue", "إيراد أتعاب الاستشارة"), iqd(co.consultancy_fee_revenue_iqd)) +
      row(TT("Engineering Revenue", "الإيراد الهندسي"), iqd(co.engineering_revenue_iqd)) +
      row(TT("Other Larsa Revenue", "إيرادات لارسا الأخرى"), iqd(co.other_revenue_iqd)) +
      row("<b>" + TT("Larsa Revenue", "إيراد لارسا") + "</b>", "<b>" + iqd(co.larsa_revenue_iqd) + "</b>") +
      row(TT("Larsa Operating Expenses", "مصاريف تشغيل لارسا"), iqd(co.operating_expenses_iqd)) +
      row(TT("Larsa-attributable Project Costs", "تكاليف المشروع على لارسا"), iqd(co.larsa_attributable_project_costs_iqd)) +
      row(TT("Refund / Reversal of Consultancy Fees", "إرجاع/عكس أتعاب الاستشارة"), iqd(co.fee_refunds_reversals_iqd)) +
      row("<b>" + TT("Company Net Profit", "صافي ربح الشركة") + "</b>", "<b>" + iqd(co.company_net_profit_iqd) + "</b>") +

      grp(TT("C · Progress", "ج · التقدم")) +
      row("<b>" + TT("Cost Progress", "التقدم الكلفوي") + "</b>", costTxt) +
      row("<b>" + TT("Schedule / Physical Progress", "التقدم الزمني/الفعلي") + "</b>", schedTxt) +
      "</tbody></table></div>" +
      curLine +
      reliabilityBanner(rev) +
      '<div class="rpt-actions" style="margin-top:8px">' +
      (canWriteAcct() || engineUser().role === "Project Manager" || engineUser().role === "Construction Engineer"
        ? '<button class="btn sm" onclick="acctUpdateProgress(\'' + p.id + '\')">' + TT("Update Progress", "تحديث التقدم") + "</button>" : "") +
      (canWriteAcct() && Number(cf.total_refund_due_iqd) > 0
        ? '<button class="btn sm ghost" onclick="acctRefundModal(\'' + p.id + '\')">' + TT("Refund unused funding…", "إرجاع التمويل غير المستخدم…") + "</button>" : "") +
      '<button class="btn sm ghost" onclick="acctFundingStatementPrint(\'' + p.id + '\')">' + TT("Funding Statement", "كشف التمويل") + "</button>" +
      '<button class="btn sm ghost" onclick="acctClientStatement(\'' + p.id + '\')">' + TT("Client Statement", "كشف حساب العميل") + "</button>" +
      '<button class="btn sm ghost" onclick="acctShowHistory(\'' + p.id + '\')">' + TT("Accounting History", "السجل المحاسبي") + "</button>" +
      "</div></div>"
    );
  }

  window.acctUpdateProgress = function (pid) {
    var root = document.getElementById("modalRoot");
    if (!root) return;
    var t = today ? today() : new Date().toISOString().slice(0, 10);
    root.innerHTML =
      '<div class="modal-back" onclick="if(event.target===this)closeEditor()"><div class="modal">' +
      '<div class="modal-head"><h3>' + TT("Update Schedule / Physical Progress", "تحديث التقدم الزمني/الفعلي") + '</h3><button class="mini" onclick="closeEditor()">✕</button></div>' +
      '<div class="modal-body"><div class="form-grid">' +
      '<div class="field"><label>' + TT("Completion %", "نسبة الإنجاز %") + '</label><input id="acct_pg_pct" type="number" min="0" max="100" step="0.5"></div>' +
      '<div class="field"><label>' + TT("Update date", "تاريخ التحديث") + '</label><input id="acct_pg_date" type="date" value="' + t + '"></div>' +
      '<div class="field wide"><label>' + TT("Note (optional)", "ملاحظة (اختياري)") + '</label><input id="acct_pg_note"></div>' +
      '</div><p class="muted small">' + TT("Every update is kept permanently in the progress history.", "يُحفظ كل تحديث بشكل دائم في سجل التقدم.") + "</p></div>" +
      '<div class="modal-foot"><button class="btn ghost" onclick="closeEditor()">' + TT("Cancel", "إلغاء") + '</button><button class="btn" id="acct_pg_go">' + TT("Save Progress", "حفظ التقدم") + "</button></div></div></div>";
    document.body.classList.add("modal-open");
    document.getElementById("acct_pg_go").onclick = function () {
      var pctV = Number(document.getElementById("acct_pg_pct").value);
      if (!(pctV >= 0 && pctV <= 100)) { toast4(TT("Percent must be 0–100.", "النسبة بين ٠ و١٠٠.")); return; }
      keepContext();
      rpc("acct_record_progress", {
        actor: actor(), p_project_id: pid, p_percent: pctV,
        p_date: document.getElementById("acct_pg_date").value || null,
        p_note: document.getElementById("acct_pg_note").value || null,
      }).then(function () { try { closeEditor(); } catch (e) {} refresh(false); })
        .catch(function (e) { toast4(String(e.message || e)); });
    };
  };

  window.acctRefundModal = function (pid) {
    rpc("acct_compute_refund", { p_project_id: pid, p_refund_amount_iqd: null, p_manual_allocations: null }).then(function (calc) {
      var root = document.getElementById("modalRoot");
      if (!root) return;
      root.innerHTML =
        '<div class="modal-back" onclick="if(event.target===this)closeEditor()"><div class="modal">' +
        '<div class="modal-head"><h3>' + TT("Client Refund — Unused Funding", "إرجاع للعميل — تمويل غير مستخدم") + '</h3><button class="mini" onclick="closeEditor()">✕</button></div>' +
        '<div class="modal-body"><div class="preview">' +
        TT("Unused Net Funding", "صافي التمويل غير المستخدم") + ": <b>" + iqd(calc.unused_net_funding_iqd) + "</b><br>" +
        TT("Refundable Consultancy Fee", "الأتعاب القابلة للإرجاع") + ": <b>" + iqd(calc.refundable_fee_iqd) + "</b><br>" +
        TT("Total Client Refund", "إجمالي المسترجع للعميل") + ": <b>" + iqd(calc.total_refund_iqd) + "</b><br>" +
        TT("Final Fee Retained", "الأتعاب النهائية المحتفظ بها") + ": <b>" + iqd(calc.retained_fee_iqd) + "</b></div>" +
        '<div class="form-grid"><div class="field"><label>' + TT("Partial refund amount (IQD, blank = all unused)", "مبلغ الإرجاع الجزئي (دينار، فارغ = الكل)") + '</label><input id="acct_rf_amt" type="number"></div>' +
        '<div class="field"><label>' + TT("Settlement exchange rate (optional)", "سعر صرف التسوية (اختياري)") + '</label><input id="acct_rf_rate" type="number" step="0.01"></div>' +
        '<div class="field wide"><label>' + TT("Reason", "السبب") + '</label><input id="acct_rf_reason"></div></div>' +
        '<p class="muted small">' + TT("Allocation uses documented FIFO across funding entries at each entry's own snapshotted consultancy rate and exchange rate. Posting requires the protected approval workflow.", "التوزيع يعتمد FIFO الموثق على دفعات التمويل بنسبة الأتعاب وسعر الصرف المثبتين لكل دفعة. الترحيل يتطلب مسار الموافقة المحمي.") + "</p>" +
        '<div id="acct_rf_msg" class="muted small"></div></div>' +
        '<div class="modal-foot"><button class="btn ghost" onclick="closeEditor()">' + TT("Cancel", "إلغاء") + '</button><button class="btn" id="acct_rf_go">' + TT("Draft settlement & request approval", "إعداد التسوية وطلب الموافقة") + "</button></div></div></div>";
      document.body.classList.add("modal-open");
      document.getElementById("acct_rf_go").onclick = function () {
        var amt = Number(document.getElementById("acct_rf_amt").value) || null;
        var srate = Number(document.getElementById("acct_rf_rate").value) || null;
        var reason = document.getElementById("acct_rf_reason").value || "";
        rpc("acct_create_refund_settlement", {
          actor: actor(), p_project_id: pid, p_refund_amount_iqd: amt,
          p_manual_allocations: null, p_settlement_rate: srate, p_reason: reason,
        }).then(function (r) {
          var sid = r && r.settlement && r.settlement.id;
          try { closeEditor(); } catch (e) {}
          protectedActionModal("post_refund", TT("Post client refund", "ترحيل الإرجاع للعميل"), pid,
            { settlement_id: sid },
            TT("Total refund: ", "إجمالي الإرجاع: ") + "<b>" + iqd(r.settlement.total_refund) + "</b> (" +
            TT("principal ", "الأصل ") + iqd(r.settlement.unused_net_funding) + " + " +
            TT("refundable fee ", "أتعاب قابلة للإرجاع ") + iqd(r.settlement.refundable_fee) + ")");
        }).catch(function (e) {
          var el = document.getElementById("acct_rf_msg"); if (el) el.textContent = String(e.message || e);
        });
      };
    }).catch(function (e) { toast4(String(e.message || e)); });
  };

  window.acctShowHistory = function (pid) {
    rpc("acct_get_audit", { p_project_id: pid, p_before: null, p_limit: 200 }).then(function (rows) {
      var root = document.getElementById("modalRoot");
      if (!root) return;
      var body = (rows || []).map(function (r) {
        return "<tr><td>" + esc4(String(r.at || "").replace("T", " ").slice(0, 16)) + "</td><td>" + esc4(r.actor_email || "") +
          '<div class="muted small">' + esc4(r.actor_role || "") + "</div></td><td><b>" + esc4(r.action || "") + "</b>" +
          '<div class="muted small">' + esc4(r.details || r.reason || "") + "</div></td></tr>";
      }).join("") || '<tr><td colspan="3" class="muted">' + TT("No accounting events yet.", "لا توجد أحداث محاسبية بعد.") + "</td></tr>";
      root.innerHTML =
        '<div class="modal-back" onclick="if(event.target===this)closeEditor()"><div class="modal" style="max-width:760px">' +
        '<div class="modal-head"><h3>' + TT("Permanent Accounting History", "السجل المحاسبي الدائم") + '</h3><button class="mini" onclick="closeEditor()">✕</button></div>' +
        '<div class="modal-body"><p class="muted small">' + TT("Append-only and backend-controlled: history cannot be edited or deleted from the app.", "سجل إلحاقي يتحكم به الخادم: لا يمكن تعديل التاريخ أو حذفه من التطبيق.") + "</p>" +
        '<div class="table-wrap"><table><thead><tr><th>' + TT("When (UTC)", "التوقيت (UTC)") + "</th><th>" + TT("Who", "من") + "</th><th>" + TT("What", "ماذا") + "</th></tr></thead><tbody>" + body + "</tbody></table></div></div>" +
        '<div class="modal-foot"><button class="btn ghost" onclick="closeEditor()">' + TT("Close", "إغلاق") + "</button></div></div></div>";
      document.body.classList.add("modal-open");
    }).catch(function (e) { toast4(String(e.message || e)); });
  };

  var origXRenderProject = null;
  /* ---------------- the project workspace: everything on one page ----------------
     Opening a project gives you the whole project: the financial
     summary, and every ledger you can record into — funding,
     materials, labour, expenses, revenue — with its own Add button,
     all on the project page. Nothing here needs a trip to another
     section, and the project stays locked in the editor so an entry
     can never land on the wrong project. */
  var WORKSPACE_KINDS = [
    { coll: "funding", perm: "funding",
      en: "Funding received", ar: "التمويل المستلم",
      addEn: "Add funding", addAr: "إضافة تمويل" },
    { coll: "materials", perm: "materials",
      en: "Materials", ar: "المواد",
      addEn: "Add material", addAr: "إضافة مادة" },
    { coll: "projectLabor", perm: "labor",
      en: "Workforce / Labour", ar: "العمالة",
      addEn: "Add labour", addAr: "إضافة عمالة" },
    { coll: "expenses", perm: "expenses",
      en: "Other costs", ar: "التكاليف الأخرى",
      addEn: "Add cost", addAr: "إضافة تكلفة" },
    { coll: "revenue", perm: "revenue",
      en: "Revenue", ar: "الإيرادات",
      addEn: "Add revenue", addAr: "إضافة إيراد" },
  ];

  function canCreateColl(coll) {
    try { if (typeof can === "function") return can("create", coll === "projectLabor" ? "labor" : coll); }
    catch (e) {}
    return canWriteAcct();
  }
  /* Opens the editor with this project locked in, and returns here on save.
     Uses the engine's own linked-add path so the existing behaviour and
     permission checks are preserved exactly. */
  window.acctAddHere = function (coll, pid) {
    var backToWorkspace = function () {
      // Come back to the one-page project workspace, not to the single
      // ledger tab for whatever was just added.
      try { window.__larsaReturnProjectTab = "summary"; } catch (e) {}
    };
    try {
      if (typeof window.addLinked310 === "function") {
        var r = window.addLinked310(coll, pid);
        backToWorkspace();
        return r;
      }
      if (typeof window.addLinked === "function") {
        var r2 = window.addLinked(coll, pid);
        backToWorkspace();
        return r2;
      }
    } catch (e) {}
    window.__larsaReturnProjectId = pid;
    backToWorkspace();
    try { window.xAdd(coll, pid); } catch (e) { try { openEditor(coll, null); } catch (e2) {} }
  };

  function workspaceRows(coll, pid) {
    var list = (state[coll] || []).filter(function (r) { return r.projectId === pid; });
    list.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return list;
  }
  function workspaceTable(coll, rows) {
    try {
      if (coll === "expenses" && typeof xExpenseTable === "function") return xExpenseTable(rows);
      if (coll === "materials" && typeof xMaterialTable === "function") return xMaterialTable(rows);
      if (coll === "projectLabor" && typeof xLaborTable === "function") return xLaborTable(rows);
      if (coll === "funding" && typeof xLedger === "function") {
        return xLedger("funding", rows, [
          { label: TT("Date", "التاريخ"), get: function (r) { return r.date; } },
          { label: TT("Payer", "الدافع"), get: function (r) { return esc4(r.payerName || r.description || "—"); } },
          { label: TT("Gross", "الإجمالي"), r: 1, get: function (r) { return nmoney(r.amount, r.currency); } },
          { label: TT("Fee", "الأتعاب"), r: 1, get: function (r) { return r.waived ? TT("Waived", "معفى") : nmoney(r.consultancyFee, r.currency); } },
          { label: TT("Net construction", "صافي التنفيذ"), r: 1, get: function (r) { return nmoney(r.netConstruction, r.currency); } },
          { label: TT("Status", "الحالة"), get: function (r) { return '<span class="pill">' + esc4(r.status) + "</span>"; } },
        ]);
      }
      if (typeof xLedger === "function") {
        return xLedger(coll, rows, [
          { label: TT("Date", "التاريخ"), get: function (r) { return r.date; } },
          { label: TT("Description", "الوصف"), get: function (r) { return esc4(r.description || r.itemName || r.notes || "—"); } },
          { label: TT("Amount", "المبلغ"), r: 1, get: function (r) { return nmoney(r.amount, r.currency); } },
          { label: TT("Status", "الحالة"), get: function (r) { return '<span class="pill">' + esc4(r.status) + "</span>"; } },
        ]);
      }
    } catch (e) { console.warn("[acct-cloud] workspace table:", e); }
    return '<p class="muted small">' + TT("Unable to render this ledger.", "تعذر عرض هذا السجل.") + "</p>";
  }

  function projectWorkspaceHTML(p) {
    var quick = WORKSPACE_KINDS.filter(function (k) { return canCreateColl(k.coll); }).map(function (k) {
      return '<button class="btn sm" onclick="acctAddHere(\'' + k.coll + "','" + esc4(p.id) + "')\">+ " +
        TT(k.addEn, k.addAr) + "</button>";
    }).join(" ");

    var html = '<div class="card" id="acct_workspace"><h3>' +
      TT("Record in this project", "التسجيل في هذا المشروع") + "</h3>" +
      '<p class="muted small">' +
      TT("Everything for this project is here — add funding or any cost without leaving the page. Each entry is locked to this project and waits for its assigned approver.",
        "كل ما يخص هذا المشروع هنا — أضف التمويل أو أي تكلفة دون مغادرة الصفحة. كل قيد مرتبط بهذا المشروع وينتظر معتمِده المكلف.") + "</p>" +
      (quick
        ? '<div class="rpt-actions" style="flex-wrap:wrap;gap:6px">' + quick + "</div>"
        : '<p class="muted small">' + TT("Your permissions do not include creating accounting entries.", "صلاحياتك لا تشمل إنشاء قيود محاسبية.") + "</p>") +
      "</div>";

    WORKSPACE_KINDS.forEach(function (k) {
      var rows = workspaceRows(k.coll, p.id);
      var addBtn = canCreateColl(k.coll)
        ? '<button class="btn sm" onclick="acctAddHere(\'' + k.coll + "','" + esc4(p.id) + "')\">+ " + TT(k.addEn, k.addAr) + "</button>"
        : "";
      html += '<div class="card acct-ws-card"><h3>' + TT(k.en, k.ar) +
        ' <span class="muted small">(' + rows.length + ")</span></h3>" +
        (addBtn ? '<div class="rpt-actions">' + addBtn + "</div>" : "") +
        (rows.length
          ? workspaceTable(k.coll, rows)
          : '<p class="muted small">' + TT("Nothing recorded yet.", "لا توجد قيود بعد.") + "</p>") +
        "</div>";
    });
    return html;
  }

  function wrapProjectView() {
    if (origXRenderProject) return;
    origXRenderProject = window.xRenderProject;
    if (typeof origXRenderProject !== "function") return;
    window.xRenderProject = function () {
      var out = origXRenderProject.apply(this, arguments);
      try {
        if (!ACCT.on) return out;
        var pid = window.xProject;
        var tab = window.xTab || "summary";
        if (!pid || (tab !== "summary" && tab !== "financials")) return out;
        var p = (state.projects || []).filter(function (x) { return x.id === pid; })[0];
        if (!p) return out;
        var view = document.getElementById("view");
        if (!view || document.getElementById("acct_summary_card")) return out;
        var holder = document.createElement("div");
        holder.innerHTML = summaryCardHTML(p) + projectWorkspaceHTML(p);
        var firstCard = view.querySelector(".card");
        var anchor = firstCard && firstCard.parentNode ? firstCard.nextSibling : null;
        while (holder.firstChild) {
          var node = holder.firstChild;
          if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor);
          else view.appendChild(node);
        }
      } catch (e) { console.warn("[acct-cloud] project workspace:", e); }
      return out;
    };
  }

  /* ---------------- settings: platform defaults, sample data, approvals ---------------- */
  function settingsCardsHTML() {
    var s = ACCT.settings || {};
    var pending = ACCT.approvals.filter(function (x) { return x.status === "pending"; });
    var sampleCount = ACCT.txns.filter(function (t) { return t.is_sample; }).length;
    var html = '<div class="card"><h3>' + TT("Accounting Platform Defaults", "الإعدادات الافتراضية للمحاسبة (المنصة)") + "</h3>" +
      '<p class="muted small">' + TT("Defined by the Platform Super Admin (the software owner). Changing them never recalculates historical records.", "يحددها مشرف المنصة (مالك النظام). تغييرها لا يعيد احتساب السجلات التاريخية أبداً.") + "</p>" +
      '<div class="form-grid">' +
      '<div class="field"><label>' + TT("Default exchange rate (1 USD = X IQD)", "سعر الصرف الافتراضي") + '</label><input id="acct_ps_rate" type="number" step="0.01" value="' + (s.default_exchange_rate || "") + '"' + (ACCT.isPlatformAdmin ? "" : " disabled") + "></div>" +
      '<div class="field"><label>' + TT("Default consultancy fee %", "نسبة أتعاب الاستشارة الافتراضية %") + '</label><input id="acct_ps_fee" type="number" step="0.1" value="' + Core.round2((s.default_fee_rate || 0) * 100) + '"' + (ACCT.isPlatformAdmin ? "" : " disabled") + "></div>" +
      '<div class="field"><label>' + TT("Default basis", "الأساس الافتراضي") + '</label><select id="acct_ps_basis"' + (ACCT.isPlatformAdmin ? "" : " disabled") + ">" +
      ["funding", "income", "total_expenses", "materials_only", "labor_only"].map(function (b) { return '<option value="' + b + '"' + (s.default_fee_basis === b ? " selected" : "") + ">" + b + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label>' + TT("Default treatment", "المعالجة الافتراضية") + '</label><select id="acct_ps_treat"' + (ACCT.isPlatformAdmin ? "" : " disabled") + ">" +
      ["deduct_from_funding", "project_expense", "larsa_revenue"].map(function (t) { return '<option value="' + t + '"' + (s.default_fee_treatment === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div>" +
      "</div>" +
      '<h4 style="margin:10px 0 2px">' + TT("Area approvers (dual control)", "معتمِدو الأقسام (رقابة مزدوجة)") + "</h4>" +
      '<p class="muted small">' + TT("Assign who approves each accounting area. Empty = anyone holding the approve permission. Data is entered by the accountant and waits as Pending Approval until an assigned approver (a different user) approves it.",
        "حدد من يعتمد كل قسم محاسبي. فارغ = أي شخص لديه صلاحية الاعتماد. يُدخل المحاسب البيانات وتبقى بانتظار الاعتماد حتى يعتمدها معتمِد مكلف (مستخدم آخر).") + "</p>" +
      '<div class="form-grid">' +
      [["funding", TT("Funding", "التمويل")], ["material", TT("Materials", "المواد")], ["labor", TT("Labor", "العمالة")],
       ["expense", TT("Expenses", "المصاريف")], ["revenue", TT("Revenue", "الإيرادات")], ["adjustment", TT("Adjustments", "التسويات")]].map(function (a) {
        var cur_ = ((s.area_approvers || {})[a[0]] || []);
        return '<div class="field wide"><label>' + a[1] + ' <span class="muted small">(' + a[0] + ')</span></label>' +
          rosterPicker("acct_area_" + a[0], cur_,
            TT("Select none = anyone with the approve permission.", "بدون اختيار = أي شخص لديه صلاحية الاعتماد.")) + "</div>";
      }).join("") +
      "</div>" +
      (ACCT.isPlatformAdmin
        ? '<div class="rpt-actions"><button class="btn sm" onclick="acctSavePlatform()">' + TT("Save platform defaults (email code)", "حفظ إعدادات المنصة (رمز بريدي)") + "</button></div>"
        : '<p class="muted small">' + TT("Read-only: you are not a Platform Super Admin.", "للقراءة فقط: لست مشرف المنصة.") + "</p>") +
      "</div>";

    html += '<div class="card"><h3>' + TT("Sample Accounting Data", "بيانات المحاسبة التجريبية") + "</h3>";
    if (s.sample_state === "seeded" && sampleCount > 0) {
      html += '<p class="muted small">' + sampleCount + TT(" sample records are active (marked internally). They behave like real records and are removed only through the protected workflow. Removal never touches real records and sample data is never seeded again.", " سجلاً تجريبياً فعالاً (معلّمة داخلياً). تعمل كسجلات حقيقية وتُزال فقط عبر المسار المحمي. الإزالة لا تمس السجلات الحقيقية ولن تُزرع البيانات التجريبية مجدداً.") + "</p>" +
        (canWriteAcct() ? '<button class="btn sm danger" onclick="acctRemoveSamples()">' + TT("Remove Sample Data", "إزالة البيانات التجريبية") + "</button>" : "");
    } else if (s.sample_state === "removed") {
      html += '<p class="muted small">' + TT("Sample data was removed on ", "أُزيلت البيانات التجريبية في ") + esc4(String(s.sample_removed_at || "").slice(0, 10)) + TT(" and will not be seeded again.", " ولن تُزرع مجدداً.") + "</p>";
    } else {
      html += '<p class="muted small">' + TT("Sample data is seeded automatically only when the organization has no accounting records.", "تُزرع البيانات التجريبية تلقائياً فقط عندما لا توجد سجلات محاسبية.") + "</p>";
    }
    html += "</div>";

    var PERM_KEYS = ["view","create","edit_own_unapproved","edit_any_unapproved","submit_review","review","approve","reject",
      "print_receipts","reprint_receipts","post_refunds","approve_refunds","reopen_approved","export_working","export_approved","self_approve"];
    html += '<div class="card"><h3>' + TT("Accounting Permissions (per accountant)", "صلاحيات المحاسبة (لكل محاسب)") + "</h3>" +
      '<p class="muted small">' + TT("Role defaults apply automatically (an Accountant enters and submits; Management reviews and approves). Explicit per-user grants below override the defaults — configured only by the Platform Super Admin with an email code. A creator never approves their own entry unless the separate self-approval permission is granted.",
        "تُطبَّق افتراضيات الأدوار تلقائياً (المحاسب يُدخل ويُرسل؛ الإدارة تراجع وتعتمد). المنح الصريحة أدناه تتجاوز الافتراضيات — يضبطها مشرف المنصة فقط برمز بريدي. لا يعتمد المُدخل قيده إلا بصلاحية الاعتماد الذاتي المنفصلة.") + "</p>";
    if (ACCT.permissions.length) {
      html += '<div class="table-wrap"><table><thead><tr><th>' + TT("Accountant", "المحاسب") + "</th><th>" + TT("Explicit grants", "المنح الصريحة") + "</th></tr></thead><tbody>" +
        ACCT.permissions.map(function (perm) {
          var g = perm.grants || {};
          var txt = Object.keys(g).map(function (k) { return (g[k] ? "+" : "−") + k; }).join(", ") || "—";
          return "<tr><td>" + esc4(perm.email) + "</td><td class=\"muted small\">" + esc4(txt) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    if (ACCT.isPlatformAdmin) {
      var roster = acctRoster();
      html += '<div class="form-grid"><div class="field wide"><label>' + TT("Accountant", "المحاسب") + "</label>" +
        (roster.length
          ? '<select id="acct_perm_email"><option value="">' + TT("Choose a person…", "اختر شخصاً…") + "</option>" +
            roster.map(function (p) {
              return '<option value="' + esc4(p.email) + '">' + esc4(p.name) + (p.role ? " — " + esc4(p.role) : "") + "</option>";
            }).join("") + "</select>"
          : '<input id="acct_perm_email" type="email" placeholder="name@larsaeng.com">') +
        "</div></div>" +
        '<div class="form-grid">' + PERM_KEYS.map(function (k) {
          return '<div class="field"><label class="small"><input type="checkbox" class="acct-perm-box" data-perm="' + k + '"> ' + k + "</label></div>";
        }).join("") + "</div>" +
        '<div class="rpt-actions"><button class="btn sm" onclick="acctSavePerms()">' + TT("Save permissions (email code)", "حفظ الصلاحيات (رمز بريدي)") + "</button></div>";
    }
    html += "</div>";
    html += '<div class="card"><h3>' + TT("Protected Accounting Approvals", "موافقات المحاسبة المحمية") + "</h3>";
    if (!pending.length) html += '<p class="muted small">' + TT("No pending requests.", "لا توجد طلبات معلقة.") + "</p>";
    else {
      html += '<div class="table-wrap"><table><thead><tr><th>' + TT("Action", "الإجراء") + "</th><th>" + TT("Requested by", "مقدم الطلب") + "</th><th>" + TT("Reason", "السبب") + "</th><th></th></tr></thead><tbody>" +
        pending.map(function (q) {
          return "<tr><td><b>" + esc4(q.action) + "</b><div class=\"muted small\">" + esc4(q.project_id || "") + "</div></td><td>" + esc4(q.requester_email) + "</td><td>" + esc4(q.reason || "") + "</td><td class=\"right nowrap\">" +
            (ACCT.isPlatformAdmin && (q.requester_email || "").toLowerCase() !== (actor().email || "").toLowerCase()
              ? '<button class="mini" onclick="acctDecide(\'' + q.id + "',true)\">" + TT("Approve", "موافقة") + '</button> <button class="mini" onclick="acctDecide(\'' + q.id + "',false)\">" + TT("Reject", "رفض") + "</button>"
              : '<span class="muted small">' + TT("Awaiting Platform Super Admin", "بانتظار مشرف المنصة") + "</span>") + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    html += "</div>";
    return html;
  }
  window.acctSavePlatform = function () {
    var a = actor();
    edgeFn("auth-code", { op: "send", email: a.email, purpose: "verify", name: a.name }).then(function (r) {
      if (!(r && r.ok)) { toast4(String((r && r.error) || TT("Could not send the code.", "تعذر إرسال الرمز."))); return; }
      var code = prompt(TT("A code was sent to ", "أُرسل رمز إلى ") + a.email + TT(". Enter it to confirm the platform change:", ". أدخله لتأكيد تغيير إعدادات المنصة:"));
      if (!code) return;
      rpc("acct_save_platform_settings", {
        actor: a, p_code: String(code).trim(),
        changes: {
          default_exchange_rate: Number((document.getElementById("acct_ps_rate") || {}).value || "") || null,
          default_fee_rate: (function () { var v = (document.getElementById("acct_ps_fee") || {}).value; return v === "" ? null : Number(v) / 100; })(),
          default_fee_basis: (document.getElementById("acct_ps_basis") || {}).value || null,
          default_fee_treatment: (document.getElementById("acct_ps_treat") || {}).value || null,
          area_approvers: (function () {
            var out = {};
            ["funding", "material", "labor", "expense", "revenue", "adjustment"].forEach(function (kind) {
              var picked = readPicker("acct_area_" + kind);
              if (picked !== null) out[kind] = picked;
            });
            return out;
          })(),
        },
      }).then(function () { toast4(TT("Platform accounting defaults saved (future entries only).", "حُفظت إعدادات المنصة (للقيود المستقبلية فقط).")); refresh(); })
        .catch(function (e) { toast4(String(e.message || e)); });
    });
  };
  window.acctSavePerms = function () {
    var email = ((document.getElementById("acct_perm_email") || {}).value || "").trim().toLowerCase();
    if (!email || email.indexOf("@") < 0) { toast4(TT("Enter the accountant's email.", "أدخل بريد المحاسب.")); return; }
    var grants = {};
    Array.prototype.forEach.call(document.querySelectorAll(".acct-perm-box"), function (box) {
      grants[box.getAttribute("data-perm")] = !!box.checked;
    });
    var a = actor();
    edgeFn("auth-code", { op: "send", email: a.email, purpose: "verify", name: a.name }).then(function (r) {
      if (!(r && r.ok)) { toast4(String((r && r.error) || TT("Could not send the code.", "تعذر إرسال الرمز."))); return; }
      var code = prompt(TT("A code was sent to ", "أُرسل رمز إلى ") + a.email + TT(". Enter it to save these permissions:", ". أدخله لحفظ الصلاحيات:"));
      if (!code) return;
      rpc("acct_set_permissions", { actor: a, p_code: String(code).trim(), p_email: email, p_grants: grants, p_note: null })
        .then(function () { toast4(TT("Permissions saved.", "حُفظت الصلاحيات.")); refresh(); })
        .catch(function (e) { toast4(String(e.message || e)); });
    });
  };
  window.acctRemoveSamples = function () {
    protectedActionModal("remove_sample_data", TT("Remove Sample Data", "إزالة البيانات التجريبية"), null, { },
      TT("Only records marked as samples are removed. Real records are never touched, an archive snapshot is kept, and samples are never seeded again.", "تُزال السجلات المعلّمة كتجريبية فقط. لا تُمس السجلات الحقيقية، وتُحفظ نسخة أرشيفية، ولن تُزرع البيانات التجريبية مجدداً."));
  };

  /* ---------------- permanent accounting history browser ----------------
     The backend append-only history is the authoritative audit. It is
     never truncated here: filters and paging only choose what to show,
     and the total always reports the whole history. */
  var HIST = { rows: [], total: 0, actions: [], before: null, pages: [] };
  var HF = { project: "", search: "", action: "", actor: "", from: "", to: "" };
  ACCT.history = HIST;

  function loadHistory(then) {
    return rpc("acct_audit_page", {
      p_project_id: HF.project || null,
      p_search: HF.search || null,
      p_action: HF.action || null,
      p_actor: HF.actor || null,
      p_from: HF.from || null,
      p_to: HF.to || null,
      p_record_type: null,
      p_before: HIST.before,
      p_limit: 50,
    }).then(function (a) {
      if (!a) return;
      HIST.rows = a.rows || [];
      HIST.total = a.total || 0;
      HIST.actions = a.actions || [];
      if (then) then();
    }).catch(function (e) { console.warn("[acct-cloud] history:", e); });
  }
  window.acctHistFilter = function (key, value) {
    HF[key] = value; HIST.before = null; HIST.pages = [];
    loadHistory(function () { renderHistoryInto(document.getElementById("acct_hist_body")); });
  };
  window.acctHistPage = function (dir) {
    if (dir === "next") {
      var last = HIST.rows[HIST.rows.length - 1];
      if (!last) return;
      HIST.pages.push(HIST.before);
      HIST.before = last.id;
    } else {
      HIST.before = HIST.pages.pop() || null;
    }
    loadHistory(function () { renderHistoryInto(document.getElementById("acct_hist_body")); });
  };

  function changedFieldsHTML(list) {
    if (!list || !list.length) return "";
    return '<div class="muted small">' + list.slice(0, 6).map(function (c) {
      return esc4(c.field) + ": " + esc4(String(c.before == null ? "—" : c.before)).slice(0, 40) +
        " → " + esc4(String(c.after == null ? "—" : c.after)).slice(0, 40);
    }).join(" · ") + (list.length > 6 ? " · +" + (list.length - 6) : "") + "</div>";
  }

  function renderHistoryInto(host) {
    if (!host) return;
    host.innerHTML =
      '<div class="table-wrap"><table><thead><tr><th>' + TT("When", "الوقت") + "</th><th>" + TT("Who", "من") +
        "</th><th>" + TT("Action", "الإجراء") + "</th><th>" + TT("Record / change", "السجل / التغيير") +
        "</th><th>" + TT("Reason", "السبب") + "</th></tr></thead><tbody>" +
      (HIST.rows.length ? HIST.rows.map(function (r) {
        return "<tr><td class=\"nowrap\">" + esc4(tzStamp(r.at, (ACCT.settings || {}).display_timezone)) + "</td>" +
          "<td>" + esc4(r.actor_name || r.actor_email || "—") + '<div class="muted small">' + esc4(r.actor_role || "") + "</div></td>" +
          "<td>" + esc4(r.action || "") + "</td>" +
          "<td>" + esc4(r.details || r.record_id || "") + changedFieldsHTML(r.changed_fields) +
            (r.approval_id ? '<div class="muted small">' + TT("Approval ref: ", "مرجع الموافقة: ") + esc4(String(r.approval_id).slice(0, 8)) + "</div>" : "") + "</td>" +
          "<td>" + esc4(r.reason || "") + "</td></tr>";
      }).join("") : '<tr><td colspan="5" class="muted small">' + TT("No events match these filters.", "لا توجد أحداث مطابقة.") + "</td></tr>") +
      "</tbody></table></div>" +
      '<div class="rpt-actions"><button class="btn sm ghost" onclick="acctHistPage(\'prev\')">← ' + TT("Newer", "أحدث") + '</button>' +
      '<button class="btn sm ghost" onclick="acctHistPage(\'next\')">' + TT("Older", "أقدم") + " →</button>" +
      '<span class="muted small">' + TT("Showing ", "عرض ") + HIST.rows.length + TT(" of ", " من ") + HIST.total + TT(" permanent events", " حدثاً دائماً") + "</span></div>";
  }

  function historyCardHTML() {
    return '<div class="card"><h3>' + TT("Permanent Accounting History", "سجل المحاسبة الدائم") + "</h3>" +
      '<p class="muted small">' + TT("The authoritative append-only accounting audit. Events are never edited or deleted; filters and paging only choose what is shown.",
        "سجل التدقيق المحاسبي الدائم غير القابل للتعديل. لا تُحذف الأحداث أو تُعدّل؛ عوامل التصفية والصفحات تختار المعروض فقط.") + "</p>" +
      '<div class="form-grid">' +
      '<div class="field wide"><label class="small">' + TT("Search", "بحث") + '</label><input value="' + esc4(HF.search) + '" placeholder="' + TT("description, reference, person…", "وصف، مرجع، شخص…") + '" onchange="acctHistFilter(\'search\',this.value)"></div>' +
      '<div class="field"><label class="small">' + TT("Project", "المشروع") + '</label><select onchange="acctHistFilter(\'project\',this.value)"><option value="">' + TT("All", "الكل") + "</option>" +
        ACCT.projects.map(function (p) { return '<option value="' + esc4(p.id) + '"' + (HF.project === p.id ? " selected" : "") + ">" + esc4(p.name || p.id) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label class="small">' + TT("Action", "الإجراء") + '</label><select onchange="acctHistFilter(\'action\',this.value)"><option value="">' + TT("All", "الكل") + "</option>" +
        HIST.actions.map(function (a) { return '<option value="' + esc4(a) + '"' + (HF.action === a ? " selected" : "") + ">" + esc4(a) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label class="small">' + TT("Person", "الشخص") + '</label><input value="' + esc4(HF.actor) + '" onchange="acctHistFilter(\'actor\',this.value)"></div>' +
      '<div class="field"><label class="small">' + TT("From", "من") + '</label><input type="date" value="' + esc4(HF.from) + '" onchange="acctHistFilter(\'from\',this.value)"></div>' +
      '<div class="field"><label class="small">' + TT("To", "إلى") + '</label><input type="date" value="' + esc4(HF.to) + '" onchange="acctHistFilter(\'to\',this.value)"></div>' +
      "</div><div id=\"acct_hist_body\"></div></div>";
  }

  /* ---------------- production hygiene ----------------
     Inside the authenticated Larsa Control work area the engine's own
     local-prototype plumbing is not just redundant, it is dangerous:
     it offers to replace the production ledger from a serialized blob
     and shows a local audit trail beside the authoritative one. When
     the parent signals production, those cards are removed. */
  function inProduction() {
    try { if (window.__larsaProductionMode === true) return true; } catch (e) {}
    return ACCT.on === true;
  }
  var LEGACY_SETTINGS_CARDS = [
    /supabase\s*sync/i, /production\s*setup/i, /restore\s*points?/i,
    /local[-\s]?first/i, /audit\s*trail/i, /audit\s*log/i,
  ];
  function stripLegacySettings(view) {
    if (!inProduction() || !view) return;
    Array.prototype.forEach.call(view.querySelectorAll(".card"), function (card) {
      var head = card.querySelector("h1,h2,h3,h4");
      var title = head ? (head.textContent || "") : "";
      if (!title) return;
      if (LEGACY_SETTINGS_CARDS.some(function (re) { return re.test(title); })) {
        card.setAttribute("data-acct-legacy-removed", title.trim());
        card.remove();
      }
    });
    // Any stray push/pull/replace control that lived outside a card.
    Array.prototype.forEach.call(view.querySelectorAll("button,a"), function (b) {
      var fn = String(b.getAttribute("onclick") || "");
      if (/v35(Push|Pull)StateToSupabase|v35PullStateFromSupabase|v35SaveSupabaseSettings/.test(fn)) {
        var host = b.closest ? (b.closest(".card") || b.parentNode) : b.parentNode;
        if (host && host.remove) host.remove(); else b.remove();
      }
    });
  }

  var origRenderSettings = null;
  function wrapSettings() {
    if (origRenderSettings) return;
    origRenderSettings = window.renderSettingsEnterprise;
    if (typeof origRenderSettings !== "function") return;
    window.renderSettingsEnterprise = function () {
      var out = origRenderSettings.apply(this, arguments);
      try {
        if (!ACCT.on) return out;
        var view = document.getElementById("view");
        stripLegacySettings(view);
        if (view && !document.getElementById("acct_settings_flag")) {
          var d = document.createElement("div");
          d.id = "acct_settings_flag";
          d.innerHTML = settingsCardsHTML() + historyCardHTML();
          view.appendChild(d);
          renderHistoryInto(document.getElementById("acct_hist_body"));
          loadHistory(function () { renderHistoryInto(document.getElementById("acct_hist_body")); });
        }
      } catch (e) { console.warn(e); }
      return out;
    };
  }

  /* ---------------- the Accounting Approval Queue ----------------
     Distinct from the severity/risk queue the engine already had (now
     shown under its real name, Flags / Risk Reviews). This one lists
     the records actually waiting for an accounting decision, with the
     ONE outstanding action each of them needs. */
  var QUEUE = { rows: [], total: 0, by_kind: {}, loading: false };
  var QF = { project: "", kind: "", accountant: "", approver: "", age: "", status: "" };
  ACCT.queue = QUEUE;

  function loadQueue(then) {
    QUEUE.loading = true;
    return rpc("acct_approval_queue", {
      p_project_id: QF.project || null,
      p_kind: QF.kind || null,
      p_created_by: QF.accountant || null,
      p_approver: QF.approver || null,
      p_min_age_days: QF.age ? Number(QF.age) : null,
      p_status: QF.status || null,
      p_limit: 500,
    }).then(function (q) {
      QUEUE.loading = false;
      if (!q) return;
      QUEUE.rows = q.rows || [];
      QUEUE.total = q.total || 0;
      QUEUE.by_kind = q.by_kind || {};
      if (then) then();
    }).catch(function (e) { QUEUE.loading = false; console.warn("[acct-cloud] queue:", e); });
  }
  ACCT.reloadQueue = loadQueue;

  window.acctQueueFilter = function (key, value) {
    QF[key] = value;
    loadQueue(function () { renderQueueInto(document.getElementById("acct_queue_body")); });
  };
  window.acctQueueAct = function (id, action) {
    if (action === "approve_entry") {
      var t = ACCT.txns.filter(function (x) { return x.id === id; })[0];
      if (t && typeof window.xApprove === "function") { window.xApprove(KIND_COLL[t.kind] || "expenses", id); return; }
    }
    if (action === "review_entry") { window.acctReviewEntry(id, "approved"); return; }
    if (action === "decide_protected") {
      var req = ACCT.approvals.filter(function (x) { return x.id === id; })[0];
      if (req) { approvalCodeModal(req, true); return; }
    }
    toast4(TT("Open the record to complete this action.", "افتح السجل لإتمام هذا الإجراء."));
  };

  function queueRowHTML(r) {
    var amount = r.amount != null && r.currency
      ? nmoney(Number(r.amount), r.currency)
      : (r.amount != null ? nmoney(Number(r.amount), "IQD") : "—");
    var mine = String(r.entered_by || "").toLowerCase() === myEmailLc();
    var canAct = r.action === "approve_entry" ? (myPerm("approve") && (!mine || myPerm("self_approve")))
      : r.action === "review_entry" ? myPerm("approve")
      : ACCT.isPlatformAdmin;
    var blocked = mine && !myPerm("self_approve") && r.action !== "decide_protected";
    return "<tr>" +
      "<td><b>" + esc4(r.reference || "") + "</b><div class=\"muted small\">" + esc4(r.project_name || r.project_id || "") + "</div></td>" +
      "<td>" + esc4(r.record_kind || "") + "<div class=\"muted small\">" + esc4(r.description || r.category || "") + "</div></td>" +
      "<td class=\"right\">" + esc4(amount) + "</td>" +
      "<td>" + esc4(r.entered_by_name || r.entered_by || "—") + "</td>" +
      "<td>" + esc4(r.assigned_approver || "—") + "</td>" +
      "<td class=\"right\">" + esc4(String(r.age_days == null ? "—" : r.age_days + "d")) + "</td>" +
      "<td>" + esc4(r.action_label || "") + "</td>" +
      "<td class=\"right nowrap\">" +
        (blocked
          ? '<span class="muted small">' + TT("You entered this", "أنت من أدخله") + "</span>"
          : canAct
            ? '<button class="mini" onclick="acctQueueAct(\'' + r.id + "','" + esc4(r.action) + "')\">" + TT("Approve", "اعتماد") + "</button>"
            : '<span class="muted small">' + TT("Not yours to decide", "ليس من صلاحيتك") + "</span>") +
      "</td></tr>";
  }

  function renderQueueInto(host) {
    if (!host) return;
    host.innerHTML = QUEUE.rows.length
      ? '<div class="table-wrap"><table><thead><tr>' +
        "<th>" + TT("Reference", "المرجع") + "</th><th>" + TT("Type", "النوع") + '</th><th class="right">' + TT("Amount", "المبلغ") + "</th>" +
        "<th>" + TT("Entered by", "أدخله") + "</th><th>" + TT("Approver", "المعتمِد") + '</th><th class="right">' + TT("Waiting", "الانتظار") + "</th>" +
        "<th>" + TT("Action needed", "الإجراء المطلوب") + "</th><th></th></tr></thead><tbody>" +
        QUEUE.rows.map(queueRowHTML).join("") + "</tbody></table></div>"
      : '<p class="muted small">' + TT("Nothing is waiting for an accounting decision.", "لا يوجد ما ينتظر قراراً محاسبياً.") + "</p>";
  }

  function approvalQueueHTML() {
    var projOpts = '<option value="">' + TT("All projects", "كل المشاريع") + "</option>" +
      ACCT.projects.map(function (p) {
        return '<option value="' + esc4(p.id) + '"' + (QF.project === p.id ? " selected" : "") + ">" + esc4(p.name || p.id) + "</option>";
      }).join("");
    var kindOpts = '<option value="">' + TT("All types", "كل الأنواع") + "</option>" +
      ["funding", "material", "labor", "expense", "revenue", "refund", "adjustment"].map(function (k) {
        return '<option value="' + k + '"' + (QF.kind === k ? " selected" : "") + ">" + k + "</option>";
      }).join("");
    var counts = Object.keys(QUEUE.by_kind).map(function (k) {
      return esc4(k) + " " + QUEUE.by_kind[k];
    }).join(" · ");
    return '<div class="card"><h3>' + TT("Accounting Approval Queue", "قائمة الاعتماد المحاسبي") +
      ' <span class="muted small">(' + QUEUE.total + ")</span></h3>" +
      '<p class="muted small">' + TT("Records waiting for an accounting decision — funding, expenses, materials, labour, revenue, fee and rate overrides, refunds and protected actions. Each record shows the one action it still needs.",
        "السجلات التي تنتظر قراراً محاسبياً — التمويل والمصاريف والمواد والعمالة والإيرادات وتجاوزات الأتعاب والأسعار والمستردات والإجراءات المحمية. يعرض كل سجل الإجراء الوحيد المتبقي له.") +
      (counts ? " · " + counts : "") + "</p>" +
      '<div class="form-grid">' +
      '<div class="field"><label class="small">' + TT("Project", "المشروع") + '</label><select onchange="acctQueueFilter(\'project\',this.value)">' + projOpts + "</select></div>" +
      '<div class="field"><label class="small">' + TT("Type", "النوع") + '</label><select onchange="acctQueueFilter(\'kind\',this.value)">' + kindOpts + "</select></div>" +
      '<div class="field"><label class="small">' + TT("Accountant (entered by)", "المحاسب (المُدخِل)") + '</label><input value="' + esc4(QF.accountant) + '" placeholder="name@larsaeng.com" onchange="acctQueueFilter(\'accountant\',this.value)"></div>' +
      '<div class="field"><label class="small">' + TT("Approver", "المعتمِد") + '</label><input value="' + esc4(QF.approver) + '" placeholder="name@larsaeng.com" onchange="acctQueueFilter(\'approver\',this.value)"></div>' +
      '<div class="field"><label class="small">' + TT("Waiting at least (days)", "الانتظار على الأقل (أيام)") + '</label><input type="number" min="0" value="' + esc4(QF.age) + '" onchange="acctQueueFilter(\'age\',this.value)"></div>' +
      '<div class="field"><label class="small">' + TT("Status", "الحالة") + '</label><select onchange="acctQueueFilter(\'status\',this.value)">' +
        '<option value="">' + TT("Any", "أي") + "</option>" +
        ["draft", "pending", "approved", "received", "paid"].map(function (s) {
          return '<option value="' + s + '"' + (QF.status === s ? " selected" : "") + ">" + s + "</option>";
        }).join("") + "</select></div>" +
      "</div>" +
      '<div id="acct_queue_body"></div></div>';
  }

  /* ---------------- review section: approval queue, risk flags, deleted ---------------- */
  var origRenderReview = null;
  function wrapReview() {
    if (origRenderReview) return;
    origRenderReview = window.renderReviewEnterprise;
    if (typeof origRenderReview !== "function") return;
    window.renderReviewEnterprise = function () {
      var out = origRenderReview.apply(this, arguments);
      try {
        if (!ACCT.on) return out;
        var view = document.getElementById("view");
        if (!view || document.getElementById("acct_review_flag")) return out;
        // The engine's own queue is a severity/risk-flag list, not an
        // approval list. Say so, so the two are never confused again.
        try {
          Array.prototype.forEach.call(view.querySelectorAll("h1, h2, h3"), function (h) {
            if (/^\s*(Review Queue|Open flags by severity)\s*$/i.test(h.textContent || "")) {
              h.textContent = TT("Flags / Risk Reviews", "التنبيهات / مراجعات المخاطر");
            }
          });
          var pageH1 = view.querySelector(".page-head h1");
          if (pageH1 && /review/i.test(pageH1.textContent || "") && !/flag/i.test(pageH1.textContent || "")) {
            pageH1.textContent = TT("Flags / Risk Reviews", "التنبيهات / مراجعات المخاطر");
          }
        } catch (e) {}

        var open = ACCT.review;
        var deleted = ACCT.txns.filter(function (t) { return t.deleted_at; });
        var d = document.createElement("div");
        d.id = "acct_review_flag";
        var h = approvalQueueHTML();
        h += '<div class="card"><h3>' + TT("Flags / Risk Reviews (server)", "التنبيهات / مراجعات المخاطر (الخادم)") + "</h3>";
        h += open.length
          ? '<div class="table-wrap"><table><thead><tr><th>' + TT("Type", "النوع") + "</th><th>" + TT("Note", "الملاحظة") + "</th><th></th></tr></thead><tbody>" +
            open.map(function (q) {
              return "<tr><td>" + esc4(q.source) + " · " + esc4(q.record_type || "") + "</td><td>" + esc4(q.note || "") + "</td><td class=\"right\">" +
                (canWriteAcct() ? '<button class="mini" onclick="acctResolveReview(\'' + q.id + "',false)\">" + TT("Resolve", "حل") + '</button> <button class="mini" onclick="acctResolveReview(\'' + q.id + "',true)\">" + TT("Dismiss", "تجاهل") + "</button>" : "") + "</td></tr>";
            }).join("") + "</tbody></table></div>"
          : '<p class="muted small">' + TT("Nothing waiting for review.", "لا يوجد ما ينتظر المراجعة.") + "</p>";
        h += "</div>";
        h += '<div class="card"><h3>' + TT("Deleted (restorable) accounting records", "السجلات المحاسبية المحذوفة (قابلة للاسترجاع)") + "</h3>";
        h += deleted.length
          ? '<div class="table-wrap"><table><thead><tr><th>#</th><th>' + TT("Record", "السجل") + "</th><th>" + TT("Reason", "السبب") + "</th><th></th></tr></thead><tbody>" +
            deleted.map(function (t) {
              return "<tr><td>" + esc4(t.txn_no) + "</td><td>" + esc4(t.kind) + " · " + nmoney(Number(t.original_amount), t.original_currency) + "</td><td>" + esc4(t.delete_reason || "") + "</td><td class=\"right\">" +
                (canWriteAcct() ? '<button class="mini" onclick="acctRestore(\'' + t.id + "')\">" + TT("Restore", "استرجاع") + "</button>" : "") + "</td></tr>";
            }).join("") + "</tbody></table></div>"
          : '<p class="muted small">' + TT("No deleted records.", "لا توجد سجلات محذوفة.") + "</p>";
        h += "</div>";
        d.innerHTML = h;
        view.appendChild(d);
        renderQueueInto(document.getElementById("acct_queue_body"));
        loadQueue(function () { renderQueueInto(document.getElementById("acct_queue_body")); });
      } catch (e) { console.warn(e); }
      return out;
    };
  }
  window.acctResolveReview = function (id, dismiss) {
    var note = prompt(TT("Resolution note:", "ملاحظة الحل:")) || "";
    keepContext();
    rpc("acct_resolve_review", { actor: actor(), p_id: id, p_resolution: note, p_dismiss: !!dismiss })
      .then(function () { refresh(false); }).catch(function (e) { toast4(String(e.message || e)); });
  };
  window.acctRestore = function (id) {
    keepContext();
    rpc("acct_restore_record", { actor: actor(), p_txn_id: id, p_reason: null })
      .then(function () { refresh(false); }).catch(function (e) { toast4(String(e.message || e)); });
  };

  /* ---------------- client funding receipts + funding statement ----------------
     The receipt renders ONLY from the immutable server snapshot, so later
     changes to names, defaults, or settings never rewrite an issued receipt. */
  function tzStamp(iso, tz) {
    try {
      return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz || "Asia/Baghdad" }).format(new Date(iso || Date.now()));
    } catch (e) { return String(iso || ""); }
  }
  function nfmt(v, cur) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: cur === "IQD" ? 0 : 2 }).format(Number(v) || 0) + " " + (cur || "");
  }
  function approvalPhrase(status) {
    return status === "approved"
      ? "Payment Received — Approved / تم استلام المبلغ — مُعتمد"
      : "Payment Received — Pending Internal Review / تم استلام المبلغ — بانتظار المراجعة الداخلية";
  }
  /* ---------------- the funding receipt document ----------------
     A Larsa statement, not a long table: the official logo, a company
     block, then labelled sections. Language follows the engine (EN /
     AR / bilingual) with the document direction set to match, and the
     page is sized so A4 and US Letter both hold it on one sheet.
     Every value comes from the immutable server snapshot. */
  /* The real Larsa logo asset, unaltered, addressed absolutely so it also
     resolves inside a print window opened with document.write. */
  var RECEIPT_LOGO = (function () {
    try { return window.location.origin + "/icons/larsa-logo.svg"; }
    catch (e) { return "/icons/larsa-logo.svg"; }
  })();
  function receiptLang() {
    try { if (window.__acctReceiptLang) return window.__acctReceiptLang; } catch (e) {}
    return "both";
  }
  function RL(en, ar) {
    var L = receiptLang();
    if (L === "en") return en;
    if (L === "ar") return ar;
    return en + " / " + ar;
  }
  function receiptSection(title, rows) {
    var body = rows.filter(Boolean).map(function (r) {
      return '<tr><th scope="row">' + esc4(r[0]) + "</th><td" + (r[2] ? ' class="strong"' : "") + ">" +
        (r[3] ? r[1] : esc4(r[1])) + "</td></tr>";
    }).join("");
    if (!body) return "";
    return '<section class="rc-sec"><h2>' + esc4(title) + "</h2>" +
      '<table class="rc-tbl"><tbody>' + body + "</tbody></table></section>";
  }
  function acctReceiptHTML(sn, currentStatus, printMeta) {
    var tz = sn.timezone || "Asia/Baghdad";
    var lang = receiptLang();
    var dir = lang === "ar" ? "rtl" : "ltr";
    var approved = (currentStatus || sn.review_status_at_issue) === "approved";
    var co = (ACCT.settings || {});
    var contact = [co.company_address, co.company_phone, co.company_email, co.company_website]
      .filter(Boolean).join("  ·  ");

    var head =
      '<header class="rc-head">' +
        '<div class="rc-brand">' +
          '<img class="rc-logo" src="' + RECEIPT_LOGO + '" alt="Larsa Engineering">' +
          '<div class="rc-co"><div class="rc-name">Larsa Engineering</div>' +
            '<div class="rc-ar">شركة لارسا للهندسة</div>' +
            (contact ? '<div class="rc-contact">' + esc4(contact) + "</div>" : "") +
          "</div>" +
        "</div>" +
        '<div class="rc-title"><h1>Funding Receipt</h1><div class="rc-title-ar">وصل استلام تمويل</div>' +
          '<div class="rc-no">' + esc4(sn.receipt_no || "") + "</div></div>" +
      "</header>";

    var statusChip = '<div class="rc-status ' + (approved ? "ok" : "wait") + '">' +
      esc4(approvalPhrase(currentStatus || sn.review_status_at_issue)) + "</div>";

    var corrected = sn.kind === "corrected" && sn.corrects_receipt_no
      ? '<div class="rc-corrected">CORRECTED RECEIPT — replaces ' + esc4(sn.corrects_receipt_no) +
        " / وصل مُصحح يحل محل الوصل المذكور</div>"
      : "";
    var reprint = printMeta && printMeta.isReprint
      ? '<div class="rc-reprint">REPRINT — original receipt number preserved / إعادة طباعة مع الحفاظ على رقم الوصل الأصلي</div>'
      : "";
    // An unapproved receipt is still valid proof of payment, and says so
    // plainly across the page so it can never be mistaken for a reviewed one.
    var watermark = approved ? "" :
      '<div class="rc-wm"><span>PENDING REVIEW · بانتظار المراجعة</span></div>';

    var docSec = receiptSection(RL("Document", "المستند"), [
      [RL("Receipt No.", "رقم الوصل"), sn.receipt_no || "—", true],
      [RL("Transaction No.", "رقم الحركة"), sn.txn_no || "—"],
      [RL("Transaction Date", "تاريخ الحركة"), String(sn.txn_date || "—")],
      [RL("Issued", "تاريخ الإصدار"), tzStamp(sn.issued_at || sn.received_at, tz)],
      [RL("Approval Status", "حالة الاعتماد"),
        approved ? RL("Approved", "مُعتمد") : RL("Pending internal review", "بانتظار المراجعة الداخلية")],
    ]);
    var partySec = receiptSection(RL("Client & Project", "العميل والمشروع"), [
      [RL("Client / Payer", "العميل / الدافع"), sn.payer_name || sn.client_name || "—"],
      [RL("Project", "المشروع"), sn.project_name || "—"],
      [RL("Project Code", "رمز المشروع"), sn.project_code || "—"],
    ]);
    var paySec = receiptSection(RL("Payment", "الدفع"), [
      [RL("Payment Method", "طريقة الدفع"), sn.payment_method || "—"],
      [RL("Payment Reference", "مرجع الدفع"), sn.payment_ref || "—"],
      [RL("Time Received", "وقت الاستلام"), tzStamp(sn.received_at, tz)],
    ]);

    var feeRows = [];
    if (Number(sn.fee_amount) > 0) {
      feeRows.push([RL("Consultancy Fee Rate", "نسبة أتعاب الاستشارة"),
        (Core.round2(Number(sn.fee_rate || 0) * 100)) + "%"]);
      feeRows.push([RL("Consultancy Fee", "أتعاب الاستشارة"), nfmt(sn.fee_amount, sn.currency)]);
      if ((sn.fee_treatment || "") === "deduct_from_funding") {
        feeRows.push([RL("Net Construction Funding", "صافي تمويل التنفيذ"),
          nfmt(sn.net_after_fee, sn.currency), true]);
      }
    }
    var amountSec = receiptSection(RL("Amount", "المبلغ"), [
      [RL("Gross Amount Received", "إجمالي المبلغ المستلم"), nfmt(sn.amount, sn.currency), true],
    ].concat(feeRows));

    var curSec = receiptSection(RL("Currency & Exchange Rate", "العملة وسعر الصرف"), [
      [RL("Currency", "العملة"), sn.currency || "—"],
      [RL("Exchange Rate (snapshot)", "سعر الصرف (لقطة دائمة)"),
        "1 USD = " + nfmt(sn.exchange_rate, "IQD") + " (" + (sn.rate_source || "") + ")"],
      [RL("IQD Equivalent", "المعادل بالدينار"), nfmt(sn.amount_iqd, "IQD")],
      [RL("USD Equivalent", "المعادل بالدولار"), nfmt(sn.amount_usd, "USD")],
    ]);

    var wordsSec =
      '<section class="rc-sec rc-words"><h2>' + esc4(RL("Amount in Words", "المبلغ كتابةً")) + "</h2>" +
      '<div class="rc-word-en"><small>English</small>' + esc4(Core.amountInWords(sn.amount, sn.currency, "en")) + "</div>" +
      '<div class="rc-word-ar" dir="rtl"><small>بالعربية</small>' + esc4(Core.amountInWords(sn.amount, sn.currency, "ar")) + "</div>" +
      "</section>";

    var peopleSec = receiptSection(RL("Handled By", "الجهات المسؤولة"), [
      [RL("Received By", "استلمه"), sn.received_by || "—"],
      [RL("Entered By", "أدخله"), (sn.entered_by_name || "—") + (sn.entered_by_role ? " — " + sn.entered_by_role : "")],
      [RL("Reviewed By", "راجعه"), sn.reviewed_by || (approved ? "—" : RL("Pending", "قيد المراجعة"))],
      [RL("Approved By", "اعتمده"), sn.approved_by || (approved ? "—" : RL("Pending", "قيد الاعتماد"))],
    ]);
    var noteSec = receiptSection(RL("Notes & Verification", "ملاحظات والتحقق"), [
      [RL("Notes", "ملاحظات"), sn.notes || "—"],
      [RL("Verification Code", "رمز التحقق"), sn.verify_code || "—"],
    ]);

    var signs =
      '<section class="rc-signs"><div><span></span>' + esc4(RL("Client / Payer Signature", "توقيع العميل / الدافع")) + "</div>" +
      '<div><span></span>' + esc4(RL("Larsa Receiver Signature", "توقيع المستلم")) + "</div>" +
      '<div class="rc-stamp"><span></span>' + esc4(RL("Company Stamp", "ختم الشركة")) + "</div></section>";

    var css =
      "<style>" +
      "@page{size:A4;margin:14mm}" +
      "@media print{.rc-doc{box-shadow:none;margin:0}}" +
      ".rc-doc{max-width:190mm;margin:0 auto;color:#111;font-size:11.5px;line-height:1.45}" +
      ".rc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;" +
        "border-bottom:2.5px solid #111;padding-bottom:10px;margin-bottom:4px}" +
      ".rc-brand{display:flex;align-items:center;gap:12px}" +
      ".rc-logo{height:52px;width:auto;max-width:170px;object-fit:contain}" +
      ".rc-name{font-size:15px;font-weight:700;letter-spacing:.02em}" +
      ".rc-ar{font-size:12px;color:#333}" +
      ".rc-contact{font-size:9.5px;color:#666;margin-top:3px;max-width:260px}" +
      ".rc-title{text-align:right}" +
      ".rc-title h1{font-size:17px;margin:0;letter-spacing:.01em}" +
      ".rc-title-ar{font-size:13px;color:#333}" +
      ".rc-no{margin-top:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;font-weight:700;" +
        "border:1px solid #111;display:inline-block;padding:2px 8px}" +
      ".rc-status{margin:9px 0;padding:6px 10px;font-weight:700;font-size:11px;border-radius:3px}" +
      ".rc-status.ok{background:#e8f5ec;border:1px solid #1a7f37;color:#12592a}" +
      ".rc-status.wait{background:#fdf6e3;border:1px solid #b58900;color:#7a5b00}" +
      ".rc-corrected{border:1.5px solid #b00;color:#b00;padding:6px 10px;margin:8px 0;font-weight:700;font-size:11px}" +
      ".rc-reprint{color:#555;font-size:10px;margin:4px 0}" +
      ".rc-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}" +
      ".rc-sec{break-inside:avoid;margin-top:9px}" +
      ".rc-sec h2{font-size:10px;text-transform:uppercase;letter-spacing:.09em;color:#666;margin:0 0 3px;" +
        "border-bottom:1px solid #ddd;padding-bottom:2px;font-weight:700}" +
      ".rc-tbl{width:100%;border-collapse:collapse}" +
      ".rc-tbl th{text-align:inherit;font-weight:400;color:#555;padding:2.5px 0;width:47%;vertical-align:top}" +
      ".rc-tbl td{padding:2.5px 0;font-weight:600;vertical-align:top}" +
      ".rc-tbl td.strong{font-size:13px;font-weight:700}" +
      ".rc-words{grid-column:1/-1;background:#fafafa;border:1px solid #e3e3e3;padding:7px 10px}" +
      ".rc-words small{display:block;font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.06em}" +
      ".rc-word-en,.rc-word-ar{font-weight:600;margin-top:2px}" +
      ".rc-signs{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin-top:34px;" +
        "text-align:center;font-size:10.5px;color:#333;break-inside:avoid}" +
      ".rc-signs span{display:block;border-top:1px solid #333;margin-bottom:5px;height:34px}" +
      ".rc-stamp span{border:1px dashed #999;border-radius:4px;height:52px}" +
      ".rc-foot{margin-top:16px;border-top:1px solid #ddd;padding-top:6px;color:#777;font-size:9px;" +
        "display:flex;justify-content:space-between;gap:12px}" +
      ".rc-wm{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:0}" +
      ".rc-wm span{transform:rotate(-24deg);font-size:52px;font-weight:800;color:rgba(181,137,0,.13);" +
        "letter-spacing:.06em;white-space:nowrap;border:5px solid rgba(181,137,0,.13);padding:10px 26px;border-radius:8px}" +
      ".rc-body{position:relative;z-index:1}" +
      "</style>";

    return css + '<div class="rc-doc" dir="' + dir + '">' + watermark +
      '<div class="rc-body">' + head + corrected + reprint + statusChip +
      '<div class="rc-grid">' + docSec + partySec + amountSec + curSec + wordsSec + paySec + peopleSec + noteSec + "</div>" +
      signs +
      '<div class="rc-foot"><span>' + esc4(RL("Printed", "طُبع")) + ": " + esc4(tzStamp(new Date().toISOString(), tz)) + "</span>" +
      "<span>Larsa Engineering · " + esc4(sn.receipt_no || "") + "</span></div>" +
      "</div></div>";
  }

  /* Print the document itself rather than handing it to the engine's
     generic print wrapper: the receipt carries its own page setup, and
     printing waits for the logo so preview, print and saved PDF are the
     same page. */
  function openPrintWindow(title, inner) {
    try {
      var w = window.open("", "_blank");
      if (!w) throw new Error("popup blocked");
      w.document.write(
        '<!doctype html><html><head><meta charset="utf-8"><title>' + esc4(title) + "</title>" +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        "<style>body{margin:0;padding:12mm;background:#fff;" +
        "font-family:'Segoe UI',Tahoma,'Noto Naskh Arabic',Arial,sans-serif}</style>" +
        "</head><body>" + inner + "</body></html>");
      w.document.close();
      var go = function () { try { w.focus(); w.print(); } catch (e) {} };
      var img = w.document.querySelector("img");
      if (img && !img.complete) {
        img.addEventListener("load", go);
        img.addEventListener("error", go);
        setTimeout(go, 2500); // never leave the user waiting on a slow asset
      } else {
        setTimeout(go, 120);
      }
      return;
    } catch (e) { /* fall through to the engine's printer */ }
    try { printDoc(title, inner); }
    catch (e2) { toast4(TT("Pop-up blocked — allow pop-ups to print.", "منع النافذة المنبثقة — اسمح بالنوافذ للطباعة.")); }
  }

  function receiptRecordFor(txnId) {
    var originals = ACCT.receipts.filter(function (r) { return r.txn_id === txnId && !r.voided_at; });
    originals.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
    return originals[0] || null;
  }

  window.acctPrintReceipt = function (txnId, isReprint) {
    var rec = receiptRecordFor(txnId);
    if (!rec) { toast4(TT("No receipt exists for this entry.", "لا يوجد وصل لهذا القيد.")); return; }
    if (!myPerm(isReprint ? "reprint_receipts" : "print_receipts")) {
      toast4(TT("Your permissions do not include printing receipts.", "صلاحياتك لا تشمل طباعة الوصولات.")); return;
    }
    var txn = ACCT.txns.filter(function (t) { return t.id === txnId; })[0];
    var status = txn ? txn.review_status : rec.status_at_issue;
    rpc("acct_log_receipt_print", { actor: actor(), p_receipt_id: rec.id, p_is_reprint: !!isReprint, p_reason: null })
      .catch(function () { /* the print itself must still work offline */ });
    openPrintWindow("Funding Receipt " + rec.receipt_no,
      acctReceiptHTML(rec.snapshot || {}, status, { isReprint: !!isReprint }));
  };

  function receiptModal(receipt, txn) {
    var root = document.getElementById("modalRoot");
    if (!root || !receipt) return;
    var sn = receipt.snapshot || {};
    root.innerHTML =
      '<div class="modal-back" onclick="if(event.target===this)closeEditor()"><div class="modal">' +
      '<div class="modal-head"><h3>' + TT("Funding saved — receipt ready", "تم حفظ التمويل — الوصل جاهز") + '</h3><button class="mini" onclick="closeEditor()">✕</button></div>' +
      '<div class="modal-body"><div class="preview">' +
      TT("Receipt ", "وصل رقم ") + "<b>" + esc4(receipt.receipt_no) + "</b> — " + nfmt(sn.amount, sn.currency) +
      '<div class="muted small">' + esc4(approvalPhrase(sn.review_status_at_issue)) + "</div></div>" +
      '<p class="muted small">' + TT("Print it now and hand it to the client as proof that Larsa received the amount. Internal review continues separately and never blocks this receipt.",
        "اطبعه الآن وسلّمه للعميل كإثبات باستلام لارسا للمبلغ. تستمر المراجعة الداخلية بشكل منفصل ولا تمنع هذا الوصل.") + "</p></div>" +
      '<div class="modal-foot">' +
      '<label class="small" style="margin-inline-end:auto">' + TT("Language", "اللغة") +
        ' <select id="acct_rcpt_lang" onchange="window.__acctReceiptLang=this.value">' +
        '<option value="both">' + TT("Bilingual", "ثنائي اللغة") + "</option>" +
        '<option value="en">English</option><option value="ar">العربية</option></select></label>' +
      '<button class="btn ghost" onclick="closeEditor()">' + TT("Close", "إغلاق") + "</button>" +
      '<button class="btn ghost" onclick="acctFundingStatementPrint(\'' + esc4(sn.project_id || (txn && txn.project_id) || "") + '\')">' + TT("Print Funding Statement", "طباعة كشف التمويل") + "</button>" +
      '<button class="btn ghost" onclick="acctPrintReceipt(\'' + esc4(receipt.txn_id) + '\', false)">' + TT("Save as PDF", "حفظ PDF") + "</button>" +
      '<button class="btn" onclick="acctPrintReceipt(\'' + esc4(receipt.txn_id) + '\', false)">' + TT("Print Receipt", "طباعة الوصل") + "</button>" +
      "</div></div></div>";
    document.body.classList.add("modal-open");
  }

  window.acctFundingStatementPrint = function (pid) {
    if (!myPerm("export_working")) { toast4(TT("Your permissions do not include exporting statements.", "صلاحياتك لا تشمل تصدير الكشوفات.")); return; }
    rpc("acct_funding_statement", { p_project_id: pid, p_from: null, p_to: null }).then(function (st) {
      var rows = (st.entries || []).map(function (e) {
        var m = Core.reviewMeta(e.review_status);
        return "<tr><td>" + esc4(e.receipt_no || "—") + "</td><td>" + esc4(e.txn_no) + "</td><td>" + esc4(String(e.date)) + "</td><td>" + esc4(e.payer || "") + "</td>" +
          "<td class=\"right\">" + nfmt(e.amount, e.currency) + "</td><td class=\"right\">" + nfmt(e.exchange_rate, "IQD") + "</td>" +
          "<td class=\"right\">" + nfmt(e.amount_iqd, "IQD") + "</td><td class=\"right\">" + nfmt(e.amount_usd, "USD") + "</td>" +
          "<td class=\"right\">" + nfmt(e.fee_amount, e.fee_currency) + "</td><td class=\"right\">" + nfmt(e.net_construction, e.currency) + "</td>" +
          "<td>" + m.icon + " " + esc4(m.en) + "</td></tr>";
      }).join("");
      var pendingBanner = st.contains_pending
        ? '<div style="border:1.5px solid #b58900;color:#7a5c00;background:#fff8e1;padding:6px 10px;margin:8px 0;font-weight:700">' + esc4(st.pending_label) + " / يحتوي قيوداً بانتظار الموافقة الداخلية</div>"
        : "";
      var totals =
        '<h2 class="sec">Totals / الإجماليات</h2><table><tbody>' +
        receiptRowsHTML([
          ["Total Funding (IQD equivalent)", nfmt(st.total_funding_iqd, "IQD"), true],
          ["Total Funding (USD equivalent)", nfmt(st.total_funding_usd, "USD")],
          ["Approved Funding", nfmt(st.approved_funding_iqd, "IQD")],
          ["Pending / Unreviewed Funding", nfmt(st.pending_funding_iqd, "IQD")],
          ["Total Consultancy Fee", nfmt(st.total_fee_iqd, "IQD")],
          ["Total Net Construction Funding", nfmt(st.total_net_funding_iqd, "IQD")],
          ["Total Project Expenses (approved)", nfmt(st.total_expenses_iqd, "IQD")],
          ["Remaining Balance", nfmt(st.remaining_balance_iqd, "IQD")],
          ["Refundable to Client (incl. refundable fee)", nfmt(st.refundable_to_client_iqd, "IQD"), true],
        ]) + "</tbody></table>" +
        '<div style="color:#777;font-size:11px;margin-top:10px">Generated by ' + esc4(actor().name || actor().email) + " — " + esc4(tzStamp(st.generated_at, st.timezone)) + "</div>";
      openPrintWindow("Project Funding Statement — " + (st.project_name || ""),
        pendingBanner +
        '<h2 class="sec">' + esc4(st.project_name || "") + " (" + esc4(st.project_code || "") + ") — " + esc4(st.client || "") + "</h2>" +
        '<table><thead><tr><th>Receipt</th><th>Txn</th><th>Date</th><th>Payer</th><th class="right">Amount</th><th class="right">Rate</th><th class="right">IQD</th><th class="right">USD</th><th class="right">Fee</th><th class="right">Net</th><th>Review</th></tr></thead>' +
        "<tbody>" + rows + "</tbody></table>" + totals);
    }).catch(function (e) { toast4(String(e.message || e)); });
  };

  /* ---------------- the client statement ----------------
     Built from the authoritative model, so it can no longer report
     "Actual Spending: 0" while approved spending exists, and its
     balance always matches the project summary and the project cards. */
  function statementSection(title, rows) {
    return '<h2 class="sec">' + esc4(title) + '</h2><table class="rc-tbl"><tbody>' +
      rows.filter(Boolean).map(function (r) {
        return "<tr><th scope=\"row\" style=\"text-align:inherit;font-weight:400;color:#555;width:58%\">" +
          esc4(r[0]) + "</th><td style=\"text-align:end;font-weight:" + (r[2] ? "700" : "600") + "\">" +
          esc4(r[1]) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }
  window.acctClientStatement = function (pid) {
    if (!myPerm("export_working")) {
      toast4(TT("Your permissions do not include exporting statements.", "صلاحياتك لا تشمل تصدير الكشوفات.")); return;
    }
    var fin = finFor(pid);
    var run = function (f) {
      if (!f) { toast4(TT("Financial figures are still loading.", "الأرقام المالية قيد التحميل.")); return; }
      var cf = f.client_funds || {}, ap = cf.approved || {}, wk = cf.working || {}, pn = cf.pending || {},
          co = f.company || {}, rev = f.review || {};
      var m = function (v) { return nfmt(v, "IQD"); };
      var banner = (rev.status && rev.status !== "green")
        ? '<div style="border:1.5px solid ' + (rev.status === "red" ? "#c62828" : "#b58900") + ";color:" +
          (rev.status === "red" ? "#8e1c1c" : "#7a5c00") + ";background:" +
          (rev.status === "red" ? "#fdecea" : "#fff8e1") + ';padding:6px 10px;margin:8px 0;font-weight:700">' +
          (rev.status === "red" ? "✖ " : "⏳ ") + esc4(rev.label || "") +
          " — Working figures include every saved entry / تشمل الأرقام العملية كل قيد محفوظ</div>"
        : "";
      var body =
        '<h2 class="sec">' + esc4(f.project_name || "") + " (" + esc4(f.project_code || "") + ") — " +
          esc4(f.client || "") + esc4(f.is_sample ? "  [SAMPLE]" : "") + "</h2>" + banner +
        statementSection("A) Client construction funds / أموال تنفيذ العميل", [
          ["Gross funding / إجمالي التمويل", m(ap.gross_funding_iqd), true],
          ["Initial consultancy fee / أتعاب الاستشارة الأولية", m(ap.initial_fee_iqd)],
          ["Net construction funds / صافي أموال التنفيذ", m(ap.net_construction_funding_iqd), true],
        ]) +
        statementSection("B) Project spending / صرف المشروع", [
          ["Materials / المواد", m(ap.materials_iqd)],
          ["Labor / العمالة", m(ap.labor_iqd)],
          ["Other construction costs / تكاليف أخرى", m(ap.other_costs_iqd)],
          ["Approved spending / المصروف المعتمد", m(ap.construction_cost_iqd), true],
          ["Pending spending / المصروف المعلق", m(pn.construction_cost_iqd)],
          ["Working spending / المصروف العملي", m(wk.construction_cost_iqd), true],
        ]) +
        statementSection("C) Remaining client balance / رصيد العميل المتبقي", [
          ["Approved remaining / المتبقي المعتمد", m(ap.remaining_balance_iqd), true],
          ["Working remaining / المتبقي العملي", m(wk.remaining_balance_iqd), true],
          ["Refundable principal / أصل قابل للإرجاع", m(cf.refundable_principal_iqd)],
          ["Refundable consultancy fee / أتعاب قابلة للإرجاع", m(cf.refundable_fee_iqd)],
          ["Total refund due / إجمالي المسترجع المستحق", m(cf.total_refund_due_iqd), true],
        ]) +
        statementSection("D) Larsa consultancy earnings / أرباح استشارة لارسا", [
          ["Consultancy fee earned / الأتعاب المكتسبة", m(co.consultancy_fee_revenue_iqd)],
          ["Engineering revenue / الإيراد الهندسي", m(co.engineering_revenue_iqd)],
        ]) +
        '<p style="color:#666;font-size:10.5px;margin-top:12px">' +
        "Client construction funding is held and managed for this project. It is not Larsa company revenue. / " +
        "أموال تنفيذ العميل محتجزة ومُدارة لهذا المشروع وليست إيراداً لشركة لارسا.</p>" +
        '<div style="color:#777;font-size:10px;margin-top:6px">Generated by ' +
        esc4(actor().name || actor().email) + " — " + esc4(tzStamp(new Date().toISOString(), (ACCT.settings || {}).display_timezone)) + "</div>";
      openPrintWindow("Client Construction Statement — " + (f.project_name || ""),
        "<style>.rc-tbl{width:100%;border-collapse:collapse;font-size:12px}" +
        ".rc-tbl td,.rc-tbl th{padding:3px 0;border-bottom:1px solid #f0f0f0}" +
        "h2.sec{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#555;margin:14px 0 3px}</style>" +
        body);
    };
    if (fin) run(fin);
    else loadFinancials(function () { run(finFor(pid)); });
  };

  /* The engine's own Client Statement button now prints the same
     authoritative document, so the two can never disagree. */
  function wrapClientStatement() {
    try {
      if (typeof window.printClientStatement !== "function") return;
      var orig = window.printClientStatement;
      window.printClientStatement = function () {
        var pid = null;
        try { pid = typeof clientProj !== "undefined" ? clientProj : null; } catch (e) {}
        if (!pid) { try { pid = window.__larsaReturnProjectId || null; } catch (e2) {} }
        if (ACCT.on && pid) { window.acctClientStatement(pid); return; }
        return orig.apply(this, arguments);
      };
    } catch (e) { /* engine not ready */ }
  }

  /* ---------------- review workflow UI ---------------- */
  function reviewChip(r) {
    var m = Core.reviewMeta(r.reviewStatus || "unreviewed");
    var color = m.color === "green" ? "#1a7f37" : m.color === "yellow" ? "#b58900" : "#c62828";
    return '<span title="' + esc4(r.reviewComment || m.en) + '" style="white-space:nowrap;font-size:11px;color:' + color + ';border:1px solid ' + color + '33;border-radius:9px;padding:1px 7px">' +
      m.icon + " " + esc4(TT(m.en, m.ar)) + "</span>";
  }
  window.acctSubmitReview = function (id) {
    keepContext();
    rpc("acct_submit_for_review", { actor: actor(), p_txn_id: id })
      .then(function () { refresh(false); }).catch(function (e) { toast4(String(e.message || e)); });
  };
  window.acctReviewEntry = function (id, decision) {
    var comment = null;
    if (decision === "needs_correction") {
      comment = prompt(TT("What needs to be corrected? (required)", "ما الذي يجب تصحيحه؟ (إلزامي)"));
      if (comment == null) return;
    }
    keepContext();
    rpc("acct_review_entry", { actor: actor(), p_txn_id: id, p_decision: decision, p_comment: comment })
      .then(function () { refresh(false); }).catch(function (e) { toast4(String(e.message || e)); });
  };

  var origRowActions = null;
  function wrapRowActions() {
    if (origRowActions) return;
    origRowActions = window.rowActions;
    if (typeof origRowActions !== "function") return;
    window.rowActions = function (c, id, r) {
      var out = origRowActions.apply(this, arguments);
      try {
        if (!ACCT.on || !COLL_KIND[c] || !r || !r._acctManaged) return out;
        var extra = sampleBadge(r.isSample) + " " + reviewChip(r);
        var rs = r.reviewStatus || "unreviewed";
        var scTx = ACCT.txns.filter(function (x) { return x.id === id; })[0];
        var scOk = !scTx || approverScope(scTx.project_id, scTx.kind).ok;
        if ((rs === "unreviewed" || rs === "needs_correction") && myPerm("submit_review")) {
          extra += ' <button class="mini" title="' + TT("Submit for review", "إرسال للمراجعة") + '" onclick="event.stopPropagation();acctSubmitReview(\'' + id + "')\">⇪</button>";
        }
        if ((rs === "pending_review" || rs === "unreviewed") && myPerm("approve") && scOk) {
          extra += ' <button class="mini" title="' + TT("Approve entry", "اعتماد القيد") + '" onclick="event.stopPropagation();acctReviewEntry(\'' + id + "','approved')\">✔</button>";
        }
        if (rs !== "needs_correction" && myPerm("reject") && scOk) {
          extra += ' <button class="mini" title="' + TT("Request correction", "طلب تصحيح") + '" onclick="event.stopPropagation();acctReviewEntry(\'' + id + "','needs_correction')\">✖</button>";
        }
        if (c === "funding" && receiptRecordFor(id)) {
          extra += ' <button class="mini" title="' + TT("Print funding receipt", "طباعة وصل الاستلام") + '" onclick="event.stopPropagation();acctPrintReceipt(\'' + id + "', true)\">🧾</button>";
        }
        // Insert before the closing </td> of the actions cell.
        return String(out).replace(/<\/td>\s*$/, extra + "</td>");
      } catch (e) { return out; }
    };
  }

  /* Reports that include unapproved entries stay complete but say so. */
  var origRenderReports = null;
  function wrapReports() {
    if (origRenderReports) return;
    origRenderReports = window.renderReportsEnterprise;
    if (typeof origRenderReports !== "function") return;
    window.renderReportsEnterprise = function () {
      var out = origRenderReports.apply(this, arguments);
      try {
        if (!ACCT.on) return out;
        var view = document.getElementById("view");
        if (!view || document.getElementById("acct_reports_flag")) return out;
        var active = ACCT.txns.filter(function (t) {
          return !t.deleted_at && ["void", "reversed", "rejected"].indexOf(t.status) === -1;
        });
        var notApproved = active.filter(function (t) { return t.review_status !== "approved"; });
        var d = document.createElement("div");
        d.id = "acct_reports_flag";
        if (notApproved.length) {
          d.innerHTML = '<div class="card" style="border-color:#b58900"><b style="color:#b58900">' +
            TT("Contains Unapproved Accounting Entries", "يحتوي قيوداً محاسبية غير معتمدة") + "</b> — " +
            notApproved.length + TT(" active entries are not approved yet; totals below are complete Working Totals.",
              " قيداً فعالاً غير معتمد بعد؛ الإجماليات أدناه هي إجماليات العمل الكاملة.") + "</div>";
        }
        // Portfolio comparison across projects (working figures, status-aware).
        var rows = ACCT.projects.filter(function (p) { return !p.archived_at; }).map(function (p) {
          var s = Core.projectSummary(p, ACCT.txns, ACCT.fees, ACCT.progress);
          var statuses = ACCT.txns.filter(function (t) {
            return t.project_id === p.id && !t.deleted_at && ["void", "reversed", "rejected"].indexOf(t.status) === -1;
          }).map(function (t) { return t.review_status; });
          var agg = Core.aggregateStatus(statuses);
          var dot = agg === "green" ? "🟢" : agg === "yellow" ? "🟡" : agg === "red" ? "🔴" : "⚪";
          return "<tr><td>" + dot + " " + esc4(p.name) + "</td><td class=\"right\">" + nfmt(s.gross_funding_iqd, "IQD") + "</td>" +
            "<td class=\"right\">" + nfmt(s.initial_fee_iqd, "IQD") + "</td><td class=\"right\">" + nfmt(s.actual_construction_cost_iqd, "IQD") + "</td>" +
            "<td class=\"right\">" + nfmt(s.total_used_iqd, "IQD") + "</td><td class=\"right\">" + nfmt(s.remaining_unused_iqd, "IQD") + "</td>" +
            "<td class=\"right\">" + nfmt(s.total_refund_due_iqd, "IQD") + "</td></tr>";
        }).join("");
        if (rows) {
          d.innerHTML += '<div class="card"><h3>' + TT("Portfolio — working totals by project", "المحفظة — إجماليات العمل حسب المشروع") + "</h3>" +
            '<div class="table-wrap"><table><thead><tr><th>' + TT("Project", "المشروع") + '</th><th class="right">' + TT("Gross Funding", "إجمالي التمويل") +
            '</th><th class="right">' + TT("Consultancy Fee", "أتعاب الاستشارة") + '</th><th class="right">' + TT("Actual Cost", "الكلفة الفعلية") +
            '</th><th class="right">' + TT("Total Used", "المستخدم") + '</th><th class="right">' + TT("Remaining", "المتبقي") +
            '</th><th class="right">' + TT("Refund Due", "الإرجاع المستحق") + "</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
            '<p class="muted small">' + TT("Totals never add a value to its own components; funding, cost, fees, refunds, and balances stay separate.",
              "الإجماليات لا تجمع القيمة مع مكوناتها؛ يبقى التمويل والكلفة والأتعاب والإرجاعات والأرصدة منفصلة.") + "</p></div>";
        }
        view.insertBefore(d, view.firstChild);
      } catch (e) { console.warn(e); }
      return out;
    };
  }

  /* ---------------- keep snapshots safe from legacy recompute ---------------- */
  var origDerive = null;
  function wrapDerive() {
    if (origDerive) return;
    origDerive = window.deriveRecord;
    if (typeof origDerive !== "function") return;
    window.deriveRecord = function (coll, rec) {
      if (rec && rec._acctManaged) return rec; // server snapshots are authoritative
      return origDerive.apply(this, arguments);
    };
  }

  /* ---------------- wire up ---------------- */
  function install() {
    wrapSaveEditor();
    wrapOpenEditor();
    wrapDelRec();
    wrapApprove();
    wrapProjectView();
    wrapSettings();
    wrapReview();
    wrapRowActions();
    wrapReports();
    wrapDerive();
    wrapTotals();
    wrapCompanyTotals();
    wrapClientStatement();
    wrapFundingSchema();
    bootstrap();
  }
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(install, 0);
  else document.addEventListener("DOMContentLoaded", install);
})();
