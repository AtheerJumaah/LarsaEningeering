-- Breaks are part of the attendance record too (they adjust worked vs
-- in-office time), so the append-only ledger accepts their events as well.
alter table public.attendance_events drop constraint if exists attendance_events_status_check;
alter table public.attendance_events add constraint attendance_events_status_check
  check (status in ('In','Out','Break Start','Break End'));
