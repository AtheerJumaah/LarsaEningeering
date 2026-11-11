-- The reporting calendar is a platform setting, not a rewrite of saved punches.
-- JavaScript weekday numbering: Sunday=0, Saturday=6.
alter table public.auth_policy
  add column if not exists week_start_day smallint not null default 6;

alter table public.auth_policy
  drop constraint if exists auth_policy_week_start_day_check;

alter table public.auth_policy
  add constraint auth_policy_week_start_day_check
  check (week_start_day between 0 and 6);
