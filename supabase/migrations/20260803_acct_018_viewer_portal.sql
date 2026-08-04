-- ============================================================
-- Larsa Control — the one piece of read access a Viewer needs that the
-- table-level RLS from 20260803_acct_016_viewer_accounts.sql cannot cover
-- by itself: a project's rolled-up financial numbers.
--
-- Why this can't just be "let Viewers call acct_project_summary": that
-- function (and acct_project_financials underneath it) takes nothing but a
-- project id — no actor, no caller check of any kind — because until now
-- every caller was already an employee session trusted for the whole
-- accounting area. It is SECURITY DEFINER, so it runs as the owner and
-- bypasses RLS entirely; granting a Viewer EXECUTE on it as-is would let
-- them pass ANY project id, employee or not, and read that project's
-- figures — including company_net_profit_iqd and larsa_revenue_iqd, Larsa's
-- own margin, not the client's numbers. That is a real cross-tenant leak,
-- exactly the kind of gap "server-enforced, never trust the frontend" is
-- meant to catch.
--
-- viewer_project_summary is the gate: it checks
-- viewer_can_read_project(auth.uid(), p_project_id) itself, first, before
-- touching any data, then returns only the subset of
-- acct_project_summary's fields that are the client's own money and
-- progress — what they funded, what has been spent and on what broad
-- category, what is left, what could be refunded, and cost/schedule
-- progress percentages. It deliberately drops every fee-treatment,
-- reliability-review, and revenue/profit field: those describe Larsa's own
-- books and internal risk assessment, not the client's project.
-- ============================================================

create or replace function public.viewer_project_summary(p_project_id text)
returns jsonb
language plpgsql
stable
security definer set search_path = public, pg_temp
as $$
declare
  full_summary jsonb;
begin
  if not public.viewer_can_read_project(auth.uid(), p_project_id) then
    return null;
  end if;

  full_summary := public.acct_project_summary(p_project_id);
  if full_summary is null then
    return null;
  end if;

  return jsonb_build_object(
    'project_id', full_summary->>'project_id',
    'currency', full_summary->>'currency',
    'contract_value', full_summary->'contract_value',
    'approved_budget', full_summary->'approved_budget',
    'budget_currency', full_summary->>'budget_currency',
    'gross_funding_iqd', full_summary->'gross_funding_iqd',
    'gross_funding_usd', full_summary->'gross_funding_usd',
    'net_construction_funding_iqd', full_summary->'net_construction_funding_iqd',
    'net_construction_funding_usd', full_summary->'net_construction_funding_usd',
    'materials_iqd', full_summary->'materials_iqd',
    'materials_usd', full_summary->'materials_usd',
    'labor_iqd', full_summary->'labor_iqd',
    'labor_usd', full_summary->'labor_usd',
    'other_expenses_iqd', full_summary->'other_expenses_iqd',
    'other_expenses_usd', full_summary->'other_expenses_usd',
    'actual_construction_cost_iqd', full_summary->'actual_construction_cost_iqd',
    'actual_construction_cost_usd', full_summary->'actual_construction_cost_usd',
    'total_used_iqd', full_summary->'total_used_iqd',
    'total_used_usd', full_summary->'total_used_usd',
    'approved_remaining_balance_iqd', full_summary->'approved_remaining_balance_iqd',
    'refunded_principal_iqd', full_summary->'refunded_principal_iqd',
    'remaining_unused_iqd', full_summary->'remaining_unused_iqd',
    'total_refund_due_iqd', full_summary->'total_refund_due_iqd',
    'cost_progress_pct', full_summary->'cost_progress_pct',
    'schedule_progress_pct', full_summary->'schedule_progress_pct',
    'schedule_progress_date', full_summary->'schedule_progress_date',
    'computed_at', full_summary->'computed_at'
  );
end;
$$;

revoke all on function public.viewer_project_summary(text) from public, anon;
grant execute on function public.viewer_project_summary(text) to authenticated;
