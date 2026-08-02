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
    isPlatformAdmin: false,
    lastError: "",
  };

  function engineUser() {
    try { return (typeof currentUser !== "undefined" && currentUser) ? currentUser : {}; } catch (e) { return {}; }
  }
  function actor() {
    var u = engineUser();
    return { email: u.email || "", name: u.name || "", role: u.role || "" };
  }
  var WRITER_ROLES = ["Owner / Super Admin", "Management", "Accountant"];
  function canWriteAcct() { return WRITER_ROLES.indexOf(engineUser().role) !== -1; }

  var COLL_KIND = { funding: "funding", materials: "material", projectLabor: "labor", expenses: "expense", revenue: "revenue" };
  var KIND_COLL = { funding: "funding", material: "materials", labor: "projectLabor", expense: "expenses", revenue: "revenue" };
  var STATUS_TO_LEGACY = {
    draft: "Draft", pending: "Pending", approved: "Approved", posted: "Approved",
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
      ACCT.on = true;
      ACCT.lastError = "";
      applyMirrors();
      var email = (actor().email || "").toLowerCase();
      if (email) {
        rpc("acct_is_platform_admin", { admin_email: email })
          .then(function (v) { ACCT.isPlatformAdmin = v === true; })
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
    var status = LEGACY_TO_STATUS[g("status")] || "draft";
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
        div.innerHTML =
          "<b>" + TT("Consultancy fee rule", "قاعدة أتعاب الاستشارة") + ":</b> " + esc4(ruleText) +
          ' <span class="muted small">(' + esc4(rule.source) + (eligible ? "" : TT(" — not applicable to this entry", " — لا تنطبق على هذا القيد")) + ")</span>" +
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
        };
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

  function summaryCardHTML(p) {
    var s = Core.projectSummary(p._acct || { id: p.id, currency: p.currency, approved_budget: p.approvedBudget, budget_currency: p.budgetCurrency, contract_value: p.contractValue }, ACCT.txns, ACCT.fees, ACCT.progress);
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
      row(TT("Gross Funding Received", "إجمالي التمويل المستلم"), iqd(s.gross_funding_iqd) + ' <span class="muted small">/ ' + nmoney(s.gross_funding_usd, "USD") + "</span>") +
      row(TT("Initial Consultancy Fee", "أتعاب الاستشارة الأولية"), iqd(s.initial_fee_iqd)) +
      row(TT("Net Construction Funding", "صافي تمويل التنفيذ"), iqd(s.net_construction_funding_iqd)) +
      row(TT("Materials", "المواد"), iqd(s.materials_iqd)) +
      row(TT("Labor", "العمالة"), iqd(s.labor_iqd)) +
      row(TT("Other Project Expenses", "مصاريف المشروع الأخرى"), iqd(s.other_expenses_iqd)) +
      row("<b>" + TT("Actual Construction Cost", "كلفة التنفيذ الفعلية") + "</b>", "<b>" + iqd(s.actual_construction_cost_iqd) + "</b>") +
      row(TT("Total Used", "إجمالي المستخدم"), iqd(s.total_used_iqd)) +
      row(TT("Remaining Unused Balance", "الرصيد غير المستخدم"), iqd(s.remaining_unused_iqd)) +
      row(TT("Refundable Consultancy Fee", "أتعاب الاستشارة القابلة للإرجاع"), iqd(s.refundable_fee_iqd)) +
      row("<b>" + TT("Total Refund Due to Client", "إجمالي المسترجع المستحق للعميل") + "</b>", "<b>" + iqd(s.total_refund_due_iqd) + "</b>") +
      row(TT("Final Consultancy Fee Retained by Larsa", "أتعاب الاستشارة النهائية المحتفظ بها"), iqd(s.final_fee_retained_iqd)) +
      row(TT("Fee recorded as separate Larsa revenue", "أتعاب مسجلة كإيراد منفصل لـ لارسا"), iqd(s.fee_as_larsa_revenue_iqd)) +
      row(TT("Pending Commitments", "الالتزامات المعلقة"), iqd(s.pending_commitments_iqd)) +
      row(TT("Refunded so far (principal)", "المسترجع حتى الآن (أصل)"), iqd(s.refunded_principal_iqd)) +
      row("<b>" + TT("Cost Progress", "التقدم الكلفوي") + "</b>", costTxt) +
      row("<b>" + TT("Schedule / Physical Progress", "التقدم الزمني/الفعلي") + "</b>", schedTxt) +
      "</tbody></table></div>" +
      '<div class="rpt-actions" style="margin-top:8px">' +
      (canWriteAcct() || engineUser().role === "Project Manager" || engineUser().role === "Construction Engineer"
        ? '<button class="btn sm" onclick="acctUpdateProgress(\'' + p.id + '\')">' + TT("Update Progress", "تحديث التقدم") + "</button>" : "") +
      (canWriteAcct() && s.total_refund_due_iqd > 0
        ? '<button class="btn sm ghost" onclick="acctRefundModal(\'' + p.id + '\')">' + TT("Refund unused funding…", "إرجاع التمويل غير المستخدم…") + "</button>" : "") +
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
        holder.innerHTML = summaryCardHTML(p);
        var firstCard = view.querySelector(".card");
        if (firstCard && firstCard.parentNode) firstCard.parentNode.insertBefore(holder.firstChild, firstCard.nextSibling);
        else view.appendChild(holder.firstChild);
      } catch (e) { console.warn("[acct-cloud] summary inject:", e); }
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
        },
      }).then(function () { toast4(TT("Platform accounting defaults saved (future entries only).", "حُفظت إعدادات المنصة (للقيود المستقبلية فقط).")); refresh(); })
        .catch(function (e) { toast4(String(e.message || e)); });
    });
  };
  window.acctRemoveSamples = function () {
    protectedActionModal("remove_sample_data", TT("Remove Sample Data", "إزالة البيانات التجريبية"), null, { },
      TT("Only records marked as samples are removed. Real records are never touched, an archive snapshot is kept, and samples are never seeded again.", "تُزال السجلات المعلّمة كتجريبية فقط. لا تُمس السجلات الحقيقية، وتُحفظ نسخة أرشيفية، ولن تُزرع البيانات التجريبية مجدداً."));
  };

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
        if (view && !document.getElementById("acct_settings_flag")) {
          var d = document.createElement("div");
          d.id = "acct_settings_flag";
          d.innerHTML = settingsCardsHTML();
          view.appendChild(d);
        }
      } catch (e) { console.warn(e); }
      return out;
    };
  }

  /* ---------------- review section: server review queue + deleted records ---------------- */
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
        var open = ACCT.review;
        var deleted = ACCT.txns.filter(function (t) { return t.deleted_at; });
        var d = document.createElement("div");
        d.id = "acct_review_flag";
        var h = '<div class="card"><h3>' + TT("Accounting Review Queue (server)", "قائمة المراجعة المحاسبية (الخادم)") + "</h3>";
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
    wrapDerive();
    bootstrap();
  }
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(install, 0);
  else document.addEventListener("DOMContentLoaded", install);
})();
