-- PIN sign-in re-verification policy: an emailed code on the first PIN
-- sign-in and again every pin_hours (weekly by default), switchable and
-- tunable in Platform Settings exactly like the email intervals.
-- Applied to production 2026-08-05 as auth_026_pin_verification_policy.
alter table public.auth_policy
  add column if not exists pin_verification_required boolean not null default true,
  add column if not exists pin_hours integer not null default 168;
