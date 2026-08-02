/* ============================================================
   Larsa Control — Accounting Core (v4.0)

   Pure calculation module shared by the accounting engine
   (public/engines/accounting.html) and the node test suite
   (tests/accounting-core.test.mjs). It mirrors, exactly, the maths
   enforced server-side by the Supabase acct_* functions:

     * exchange-rate hierarchy + historical snapshots (1 USD = X IQD)
     * consultancy-fee hierarchy (transaction > category > project >
       platform), calculation bases, and treatments
     * incremental per-transaction fee generation
     * the Larsa unused-funding refund rule:
         Unused Net Funding    = Net Construction Funding − Approved Expenses
         Refundable Fee        = Unused Net Funding × original snapshot rate
         Total Client Refund   = Unused Net Funding + Refundable Fee
         Retained Fee          = Initial Fee − Refundable Fee
     * the project financial summary (contract / budget / funding /
       cost / fees / refunds kept separate, never double-counted)

   No DOM, no network, no state — inputs in, numbers out.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LarsaAcctCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var r2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };

  /* ---------- exchange-rate hierarchy ---------- */
  function resolveRate(platform, project, override) {
    var o = Number(override);
    if (isFinite(o) && o > 0) return { rate: o, source: "transaction_override" };
    var p = Number(project && project.default_exchange_rate);
    if (isFinite(p) && p > 0) return { rate: p, source: "project_default" };
    var d = Number(platform && platform.default_exchange_rate);
    return { rate: isFinite(d) && d > 0 ? d : 1310, source: "platform_default" };
  }

  /* Historical snapshot: both equivalents, frozen forever. */
  function snapshot(amount, currency, rate) {
    var amt = Number(amount) || 0;
    var rt = Number(rate) || 1;
    if (currency === "IQD") return { amount_iqd: r2(amt), amount_usd: r2(amt / rt) };
    return { amount_usd: r2(amt), amount_iqd: r2(amt * rt) };
  }

  /* ---------- consultancy-fee hierarchy ---------- */
  function ruleFrom(source, method, rate, fixed, basis, cats, treatment, extra) {
    var out = {
      method: method || "percentage",
      rate: Number(rate) || 0,
      fixed: Number(fixed) || 0,
      basis: basis || "funding",
      basis_categories: cats || [],
      treatment: treatment || "deduct_from_funding",
      waived: (method || "") === "waived",
      source: source,
    };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }

  function resolveFeeRule(platform, project, kind, category, override) {
    platform = platform || {};
    var projBasis = project && !project.fee_inherit && project.fee_basis ? project.fee_basis : platform.default_fee_basis || "funding";
    var projTreat = project && !project.fee_inherit && project.fee_treatment ? project.fee_treatment : platform.default_fee_treatment || "deduct_from_funding";
    if (override && override.method) {
      return ruleFrom("transaction_override", override.method, override.rate, override.fixed,
        override.basis || projBasis, override.basis_categories, override.treatment || projTreat,
        { waived: override.method === "waived" || !!override.waived, waiver_reason: override.waiver_reason || "" });
    }
    var ovs = (project && project.fee_category_overrides) || [];
    for (var i = 0; i < ovs.length; i++) {
      var c = String(ovs[i].category || "").toLowerCase();
      if (c && (c === String(category || "").toLowerCase() || c === String(kind || "").toLowerCase())) {
        return ruleFrom("category_override", ovs[i].method || "percentage", ovs[i].rate, ovs[i].fixed,
          ovs[i].basis || projBasis, ovs[i].basis_categories, ovs[i].treatment || projTreat);
      }
    }
    if (project && !project.fee_inherit && project.fee_method) {
      return ruleFrom("project_default", project.fee_method, project.fee_rate, project.fee_fixed,
        project.fee_basis || platform.default_fee_basis || "funding",
        project.fee_basis_categories, project.fee_treatment || platform.default_fee_treatment);
    }
    return ruleFrom("platform_default", platform.default_fee_method || "percentage",
      platform.default_fee_rate != null ? platform.default_fee_rate : 0.08,
      platform.default_fee_fixed, platform.default_fee_basis || "funding",
      platform.default_fee_basis_categories, platform.default_fee_treatment || "deduct_from_funding");
  }

  function feeEligible(kind, category, rule) {
    var basis = (rule && rule.basis) || "funding";
    var cats = ((rule && rule.basis_categories) || []).map(function (c) { return String(c).toLowerCase(); });
    var inCats = cats.indexOf(String(category || "").toLowerCase()) !== -1 || cats.indexOf(String(kind || "").toLowerCase()) !== -1;
    switch (basis) {
      case "funding": return kind === "funding";
      case "income": return kind === "revenue";
      case "total_expenses": return kind === "material" || kind === "labor" || kind === "expense";
      case "materials_only": return kind === "material";
      case "labor_only": return kind === "labor";
      case "expense_categories": return (kind === "material" || kind === "labor" || kind === "expense") && inCats;
      case "custom": return inCats;
      default: return false;
    }
  }

  function feePostable(kind, status) {
    if (kind === "funding") return status === "received" || status === "posted";
    if (kind === "revenue") return status === "received" || status === "posted" || status === "paid";
    return status === "approved" || status === "posted" || status === "paid";
  }

  /* Incremental fee for ONE source transaction — never the running total. */
  function feeForTxn(txn, rule) {
    if (!rule || rule.waived || rule.method === "waived") return null;
    if (!feeEligible(txn.kind, txn.category, rule)) return null;
    var fee;
    if (rule.method === "percentage") fee = r2((Number(txn.amount) || 0) * (Number(rule.rate) || 0));
    else fee = r2(Number(rule.fixed) || 0);
    var snap = snapshot(fee, txn.currency, txn.exchange_rate);
    return {
      basis_amount: r2(txn.amount),
      fee_amount: fee,
      currency: txn.currency,
      exchange_rate: Number(txn.exchange_rate) || 1,
      fee_iqd: snap.amount_iqd,
      fee_usd: snap.amount_usd,
      method: rule.method,
      rate: Number(rule.rate) || 0,
      basis: rule.basis,
      treatment: rule.treatment,
      source: rule.source,
      status: feePostable(txn.kind, txn.status) ? "posted" : "estimated",
    };
  }

  /* ---------- the Larsa unused-funding refund rule ----------
     fundingEntries: [{amount_iqd, fee_iqd, fee_rate, fee_method,
                       fee_treatment, currency, exchange_rate}] oldest first
     expensesIqd:    approved/posted project expenses (historical IQD)
     refundIqd:      partial principal to return (null = all unused)     */
  function computeRefund(fundingEntries, expensesIqd, refundIqd, alreadyRefundedIqd) {
    var remaining = r2(Number(expensesIqd) || 0) + r2(Number(alreadyRefundedIqd) || 0);
    var netPool = 0, grossIqd = 0, initialFee = 0;
    var slots = [];
    (fundingEntries || []).forEach(function (f) {
      var feeIqd = r2(f.fee_iqd || 0);
      grossIqd = r2(grossIqd + r2(f.amount_iqd));
      initialFee = r2(initialFee + feeIqd);
      var net = r2(f.amount_iqd - ((f.fee_treatment || "deduct_from_funding") === "deduct_from_funding" ? feeIqd : 0));
      netPool = r2(netPool + net);
      var take = Math.min(net, remaining);
      remaining = r2(remaining - take);
      var unused = r2(net - take);
      if (unused > 0) {
        slots.push({
          entry: f,
          available_unused_iqd: unused,
          fee_rate: (f.fee_method || "percentage") === "percentage" ? Number(f.fee_rate) || 0 : 0,
        });
      }
    });
    var unusedTotal = 0;
    slots.forEach(function (s) { unusedTotal = r2(unusedTotal + s.available_unused_iqd); });
    var want = refundIqd == null ? unusedTotal : Math.min(r2(refundIqd), unusedTotal);
    var left = want, refundableFee = 0;
    var allocations = [];
    slots.forEach(function (s) {
      var m = Math.min(left, s.available_unused_iqd);
      if (m <= 0) return;
      left = r2(left - m);
      var fee = r2(m * s.fee_rate);
      refundableFee = r2(refundableFee + fee);
      allocations.push({
        funding: s.entry,
        allocated_unused_iqd: r2(m),
        fee_rate: s.fee_rate,
        refundable_fee_iqd: fee,
      });
    });
    return {
      gross_funding_iqd: grossIqd,
      initial_fee_iqd: initialFee,
      net_construction_funding_iqd: netPool,
      approved_expenses_iqd: r2(Number(expensesIqd) || 0),
      unused_net_funding_iqd: unusedTotal,
      refund_principal_iqd: r2(want),
      refundable_fee_iqd: refundableFee,
      total_refund_iqd: r2(want + refundableFee),
      retained_fee_iqd: r2(initialFee - refundableFee),
      partial: want < unusedTotal,
      allocations: allocations,
    };
  }

  /* ---------- project financial summary (mirror of acct_project_summary) ----------
     txns: relational transactions; fees: fee-ledger rows; both raw server rows. */
  var ACTUAL = { funding: ["received", "posted", "paid"], revenue: ["received", "posted", "paid"] };
  function isActual(kind, status) {
    var list = ACTUAL[kind] || ["approved", "posted", "paid"];
    return list.indexOf(status) !== -1;
  }

  function sumTxns(txns, kind, statuses) {
    var iqd = 0, usd = 0;
    (txns || []).forEach(function (t) {
      if (t.kind !== kind || t.deleted_at) return;
      var ok = statuses ? statuses.indexOf(t.status) !== -1 : isActual(t.kind, t.status);
      if (!ok) return;
      iqd = r2(iqd + Number(t.amount_iqd || 0));
      usd = r2(usd + Number(t.amount_usd || 0));
    });
    return { iqd: iqd, usd: usd };
  }

  function projectSummary(project, txns, fees, progressUpdates) {
    txns = (txns || []).filter(function (t) { return t.project_id === project.id; });
    fees = (fees || []).filter(function (f) { return f.project_id === project.id; });
    var gross = sumTxns(txns, "funding");
    var mat = sumTxns(txns, "material");
    var lab = sumTxns(txns, "labor");
    var oth = sumTxns(txns, "expense");
    var rev = sumTxns(txns, "revenue");
    var pending = { iqd: 0, usd: 0 };
    txns.forEach(function (t) {
      if ((t.kind === "material" || t.kind === "labor" || t.kind === "expense")
        && (t.status === "draft" || t.status === "pending") && !t.deleted_at) {
        pending.iqd = r2(pending.iqd + Number(t.amount_iqd || 0));
        pending.usd = r2(pending.usd + Number(t.amount_usd || 0));
      }
    });
    var feePosted = 0, feeDeduct = 0, feeExpense = 0, feeRevenue = 0, feeReversed = 0;
    fees.forEach(function (f) {
      if (f.entry_type === "fee" && (f.status === "posted" || f.status === "settled")) {
        feePosted = r2(feePosted + Number(f.fee_iqd || 0));
        if (f.treatment === "deduct_from_funding") feeDeduct = r2(feeDeduct + Number(f.fee_iqd || 0));
        if (f.treatment === "project_expense") feeExpense = r2(feeExpense + Number(f.fee_iqd || 0));
        if (f.treatment === "larsa_revenue") feeRevenue = r2(feeRevenue + Number(f.fee_iqd || 0));
      }
      if ((f.entry_type === "fee_reversal" || f.entry_type === "fee_adjustment")
        && (f.status === "posted" || f.status === "settled")) {
        feeReversed = r2(feeReversed - Number(f.fee_iqd || 0));
      }
    });
    var refundedPrincipal = 0;
    txns.forEach(function (t) {
      if (t.kind === "refund" && (t.status === "posted" || t.status === "paid") && !t.deleted_at) {
        var p = t.meta && t.meta.principal_iqd != null ? Number(t.meta.principal_iqd) : Number(t.amount_iqd || 0);
        refundedPrincipal = r2(refundedPrincipal + p);
      }
    });

    var actualCost = { iqd: r2(mat.iqd + lab.iqd + oth.iqd), usd: r2(mat.usd + lab.usd + oth.usd) };
    var netFunding = r2(gross.iqd - feeDeduct);
    var totalUsed = r2(actualCost.iqd + feeDeduct + feeExpense);

    var fundingEntries = txns
      .filter(function (t) { return t.kind === "funding" && isActual("funding", t.status) && !t.deleted_at; })
      .sort(function (a, b) { return String(a.txn_date).localeCompare(String(b.txn_date)); })
      .map(function (t) {
        var fee = fees.filter(function (f) {
          return f.source_txn_id === t.id && f.entry_type === "fee" && (f.status === "posted" || f.status === "settled");
        })[0];
        return {
          amount_iqd: Number(t.amount_iqd || 0),
          fee_iqd: fee ? Number(fee.fee_iqd || 0) : 0,
          fee_rate: fee ? Number(fee.fee_rate || 0) : (t.fee_rule ? Number(t.fee_rule.rate || 0) : 0),
          fee_method: fee ? fee.calc_method : (t.fee_rule ? t.fee_rule.method : "percentage"),
          fee_treatment: fee ? fee.treatment : (t.fee_rule ? t.fee_rule.treatment : "deduct_from_funding"),
          currency: t.original_currency,
          exchange_rate: Number(t.exchange_rate || 1),
        };
      });
    var expensesForRefund = r2(actualCost.iqd + feeExpense);
    var refund = computeRefund(fundingEntries, expensesForRefund, null, refundedPrincipal);

    var latest = null;
    (progressUpdates || []).forEach(function (p) {
      if (p.project_id !== project.id) return;
      if (!latest || String(p.update_date) > String(latest.update_date)
        || (String(p.update_date) === String(latest.update_date) && String(p.created_at) > String(latest.created_at))) latest = p;
    });

    var budget = Number(project.approved_budget);
    var budgetCur = project.budget_currency || project.currency || "IQD";
    var costProgress = null;
    if (isFinite(budget) && budget > 0) {
      var costSide = budgetCur === "IQD" ? actualCost.iqd : actualCost.usd;
      costProgress = Math.round((costSide / budget) * 1000) / 10;
    }

    return {
      contract_value: project.contract_value != null ? Number(project.contract_value) : null,
      approved_budget: isFinite(budget) && budget > 0 ? budget : null,
      budget_currency: budgetCur,
      gross_funding_iqd: gross.iqd, gross_funding_usd: gross.usd,
      initial_fee_iqd: feePosted,
      fee_deducted_from_funding_iqd: feeDeduct,
      fee_as_project_expense_iqd: feeExpense,
      fee_as_larsa_revenue_iqd: feeRevenue,
      fee_reversed_iqd: feeReversed,
      net_construction_funding_iqd: netFunding,
      materials_iqd: mat.iqd, materials_usd: mat.usd,
      labor_iqd: lab.iqd, labor_usd: lab.usd,
      other_expenses_iqd: oth.iqd, other_expenses_usd: oth.usd,
      actual_construction_cost_iqd: actualCost.iqd,
      actual_construction_cost_usd: actualCost.usd,
      total_used_iqd: totalUsed,
      revenue_iqd: rev.iqd,
      pending_commitments_iqd: pending.iqd,
      refunded_principal_iqd: refundedPrincipal,
      remaining_unused_iqd: refund.unused_net_funding_iqd,
      refundable_fee_iqd: refund.refundable_fee_iqd,
      total_refund_due_iqd: refund.total_refund_iqd,
      final_fee_retained_iqd: refund.retained_fee_iqd,
      cost_progress_pct: costProgress,
      schedule_progress_pct: latest ? Number(latest.percent) : null,
      schedule_progress_date: latest ? latest.update_date : null,
      schedule_progress_by: latest ? (latest.updated_by_name || latest.updated_by_email) : null,
    };
  }

  /* ---------- amounts in words (receipts) ---------- */
  var EN_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  var EN_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  function enBelowThousand(n) {
    var out = [];
    if (n >= 100) { out.push(EN_ONES[Math.floor(n / 100)] + " Hundred"); n = n % 100; }
    if (n >= 20) {
      out.push(EN_TENS[Math.floor(n / 10)] + (n % 10 ? "-" + EN_ONES[n % 10] : ""));
    } else if (n > 0) out.push(EN_ONES[n]);
    return out.join(" ");
  }
  function numberToWordsEn(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    if (n === 0) return "Zero";
    var parts = [];
    var scales = [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"], [1, ""]];
    scales.forEach(function (s) {
      if (n >= s[0]) {
        var chunk = Math.floor(n / s[0]);
        n = n % s[0];
        parts.push(enBelowThousand(chunk) + (s[1] ? " " + s[1] : ""));
      }
    });
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  var AR_ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة",
    "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
  var AR_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
  var AR_HUNDREDS = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
  function arBelowThousand(n) {
    var out = [];
    if (n >= 100) { out.push(AR_HUNDREDS[Math.floor(n / 100)]); n = n % 100; }
    if (n >= 20) {
      var unit = n % 10;
      out.push((unit ? AR_ONES[unit] + " و" : "") + AR_TENS[Math.floor(n / 10)]);
    } else if (n > 0) out.push(AR_ONES[n]);
    return out.join(" و");
  }
  function arScale(chunk, singular, dual, plural, generic) {
    if (chunk === 1) return singular;
    if (chunk === 2) return dual;
    if (chunk >= 3 && chunk <= 10) return arBelowThousand(chunk) + " " + plural;
    return arBelowThousand(chunk) + " " + generic;
  }
  function numberToWordsAr(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    if (n === 0) return "صفر";
    var parts = [];
    if (n >= 1e9) { parts.push(arScale(Math.floor(n / 1e9), "مليار", "ملياران", "مليارات", "مليار")); n = n % 1e9; }
    if (n >= 1e6) { parts.push(arScale(Math.floor(n / 1e6), "مليون", "مليونان", "ملايين", "مليون")); n = n % 1e6; }
    if (n >= 1e3) { parts.push(arScale(Math.floor(n / 1e3), "ألف", "ألفان", "آلاف", "ألف")); n = n % 1e3; }
    if (n > 0) parts.push(arBelowThousand(n));
    return parts.join(" و");
  }
  function amountInWords(amount, currency, lang) {
    var n = Number(amount) || 0;
    var whole = Math.floor(Math.abs(n));
    var cents = Math.round((Math.abs(n) - whole) * 100);
    if (lang === "ar") {
      var curAr = currency === "USD" ? "دولار أمريكي" : "دينار عراقي";
      var out = numberToWordsAr(whole) + " " + curAr;
      if (cents > 0) out += " و" + numberToWordsAr(cents) + " سنت";
      return out + " لا غير";
    }
    var curEn = currency === "USD" ? "US Dollars" : "Iraqi Dinars";
    var res = numberToWordsEn(whole) + " " + curEn;
    if (cents > 0) res += " and " + numberToWordsEn(cents) + " Cents";
    return res + " Only";
  }

  /* ---------- review / approval status helpers ----------
     Approval changes the reliability of a number, never the amount. */
  var REVIEW_META = {
    unreviewed: { color: "red", icon: "●", en: "Unreviewed", ar: "غير مُراجع" },
    pending_review: { color: "yellow", icon: "◐", en: "Pending Review", ar: "قيد المراجعة" },
    approved: { color: "green", icon: "✔", en: "Approved", ar: "مُعتمد" },
    needs_correction: { color: "red", icon: "✖", en: "Needs Correction", ar: "يحتاج تصحيحاً" },
    voided: { color: "gray", icon: "⊘", en: "Voided/Reversed", ar: "ملغى/معكوس" },
  };
  function reviewMeta(status) { return REVIEW_META[status] || REVIEW_META.unreviewed; }
  /* Worst-of aggregation: red > yellow > green. */
  function aggregateStatus(statuses) {
    var hasRed = false, hasYellow = false, any = false;
    (statuses || []).forEach(function (s) {
      if (!s) return;
      any = true;
      if (s === "needs_correction" || s === "red") hasRed = true;
      else if (s === "unreviewed" || s === "pending_review" || s === "yellow") hasYellow = true;
    });
    if (!any) return null;
    return hasRed ? "red" : hasYellow ? "yellow" : "green";
  }

  return {
    round2: r2,
    resolveRate: resolveRate,
    snapshot: snapshot,
    resolveFeeRule: resolveFeeRule,
    feeEligible: feeEligible,
    feePostable: feePostable,
    feeForTxn: feeForTxn,
    computeRefund: computeRefund,
    projectSummary: projectSummary,
    numberToWordsEn: numberToWordsEn,
    numberToWordsAr: numberToWordsAr,
    amountInWords: amountInWords,
    reviewMeta: reviewMeta,
    aggregateStatus: aggregateStatus,
  };
});
