-- LARSA incident repair: verification identity follows the PERSON (their
-- normalized email), not the mutable staff uid. During the incident, account
-- recreation issued new uids (and even reissued OLD uids to different
-- people), so verification stamps were lost or crossed accounts -- that is
-- why people were asked to verify on every sign-in. The stamp now carries
-- the normalized email and is matched by it first.
alter table public.user_verification add column if not exists normalized_email text;

update public.user_verification v
set normalized_email = sub.email
from (
  select u->>'id' as uid, trim(lower(u->>'email')) as email
  from public.app_state, jsonb_array_elements(data->'users') u
  where store_key = 'larsaStaffV8' and coalesce(trim(u->>'email'), '') <> ''
) sub
where v.user_id = sub.uid and v.normalized_email is null;

create index if not exists user_verification_email_idx on public.user_verification (normalized_email);

-- Admin-configurable verification frequency UNIT (Part 39/41): the existing
-- *_hours numbers are interpreted in this unit. 'hours' preserves today's
-- behavior exactly; 'days' = calendar days; 'business_days' = configured
-- working days (Iraq week: Sunday-Thursday; weekend Friday+Saturday),
-- extensible later with a company holiday calendar.
alter table public.auth_policy add column if not exists interval_unit text not null default 'hours';
alter table public.auth_policy drop constraint if exists auth_policy_interval_unit_check;
alter table public.auth_policy add constraint auth_policy_interval_unit_check
  check (interval_unit in ('hours','days','business_days'));
