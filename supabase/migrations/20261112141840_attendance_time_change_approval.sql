-- Approval rules are platform-owned and off by default. Time changes still
-- appear in the manager's review queue when approval is disabled.
alter table public.auth_policy
  add column if not exists attendance_approval jsonb not null default
  '{"add_hours_requires_approval":false,"trim_hours_requires_approval":false}'::jsonb;
