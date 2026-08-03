-- ============================================================
-- 015 — a per-entry fee waiver must say why.
--
-- The engine's fee panel has always LABELLED the reason field "required
-- when waiving", and nothing on the client or the server enforced it, so
-- a consultancy fee could be waived silently — an 8,000,000 IQD charge
-- disappearing with no audit trail. The client now blocks it (accounting
-- cloud layer), and this guard makes the rule real at the boundary that
-- actually decides: acct_resolve_fee_rule, the function every posting
-- path calls to snapshot the rule onto the transaction.
--
-- Scope: ONLY the transaction-level override. A project or platform
-- configured as fee-free ("waived" method in settings) is standing
-- configuration, decided once by an authorised person — not a per-entry
-- exception that needs a per-entry justification.
-- ============================================================

create or replace function public.acct_resolve_fee_rule(
  p_project_id text, p_kind text, p_category text default null, p_override jsonb default null)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  proj record;
  ps record;
  ov jsonb;
  rule jsonb;
begin
  select * into proj from public.acct_projects where id = p_project_id;
  select * into ps from public.acct_platform_settings where id = 1;

  -- 1. Transaction-level override
  if p_override is not null and coalesce(p_override->>'method','') <> '' then
    if coalesce(p_override->>'method','') = 'waived'
       and coalesce(trim(p_override->>'waiver_reason'),'') = '' then
      raise exception 'ACCT_VALIDATION: waiving the consultancy fee on an entry requires a waiver reason';
    end if;
    return jsonb_build_object(
      'method', p_override->>'method',
      'rate', coalesce((p_override->>'rate')::numeric, 0),
      'fixed', coalesce((p_override->>'fixed')::numeric, 0),
      'basis', coalesce(p_override->>'basis',
                        case when proj.fee_inherit or proj.fee_basis is null then ps.default_fee_basis else proj.fee_basis end),
      'basis_categories', coalesce(p_override->'basis_categories',
                        to_jsonb(case when proj.fee_inherit then ps.default_fee_basis_categories else proj.fee_basis_categories end)),
      'treatment', coalesce(p_override->>'treatment',
                        case when proj.fee_inherit or proj.fee_treatment is null then ps.default_fee_treatment else proj.fee_treatment end),
      'waived', coalesce((p_override->>'waived')::boolean, p_override->>'method' = 'waived'),
      'waiver_reason', p_override->>'waiver_reason',
      'source', 'transaction_override');
  end if;

  -- 2. Category/section override configured on the project
  if p_category is not null and proj.fee_category_overrides is not null then
    select o into ov
      from jsonb_array_elements(proj.fee_category_overrides) as o
     where lower(coalesce(o->>'category','')) = lower(p_category)
        or lower(coalesce(o->>'category','')) = lower(p_kind)
     limit 1;
    if ov is not null then
      return jsonb_build_object(
        'method', coalesce(ov->>'method','percentage'),
        'rate', coalesce((ov->>'rate')::numeric, 0),
        'fixed', coalesce((ov->>'fixed')::numeric, 0),
        'basis', coalesce(ov->>'basis',
                        case when proj.fee_inherit or proj.fee_basis is null then ps.default_fee_basis else proj.fee_basis end),
        'basis_categories', coalesce(ov->'basis_categories','[]'::jsonb),
        'treatment', coalesce(ov->>'treatment',
                        case when proj.fee_inherit or proj.fee_treatment is null then ps.default_fee_treatment else proj.fee_treatment end),
        'waived', coalesce(ov->>'method','') = 'waived',
        'source', 'category_override');
    end if;
  end if;

  -- 3. Project default (when the project defines its own rule)
  if proj.id is not null and not proj.fee_inherit and proj.fee_method is not null then
    return jsonb_build_object(
      'method', proj.fee_method,
      'rate', coalesce(proj.fee_rate, 0),
      'fixed', coalesce(proj.fee_fixed, 0),
      'basis', coalesce(proj.fee_basis, ps.default_fee_basis),
      'basis_categories', to_jsonb(coalesce(proj.fee_basis_categories, '{}'::text[])),
      'treatment', coalesce(proj.fee_treatment, ps.default_fee_treatment),
      'waived', proj.fee_method = 'waived',
      'source', 'project_default');
  end if;

  -- 4. Platform default (8% percentage on funding, deducted from funding)
  return jsonb_build_object(
    'method', ps.default_fee_method,
    'rate', ps.default_fee_rate,
    'fixed', ps.default_fee_fixed,
    'basis', ps.default_fee_basis,
    'basis_categories', to_jsonb(ps.default_fee_basis_categories),
    'treatment', ps.default_fee_treatment,
    'waived', ps.default_fee_method = 'waived',
    'source', 'platform_default');
end;
$$;
