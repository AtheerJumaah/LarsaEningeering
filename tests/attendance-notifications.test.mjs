import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("attendance encouragement is server-driven, deduplicated, and schedule-aware", async () => {
  const migration = await read("supabase/migrations/20261102_attendance_encouragement.sql");

  assert.match(migration, /cron\.schedule\([\s\S]*attendance-notification-sweep[\s\S]*\*\/15 \* \* \* \*/);
  assert.match(migration, /on conflict \(user_uid, dedupe_key\) where dedupe_key is not null do nothing/);
  assert.match(migration, /store->'schedule'->uid->day_name/);
  assert.match(migration, /extract\(dow from \(e\.occurred_at at time zone tz\)\) = extract\(dow from local_now\)/);
  assert.match(migration, /shift_started < clock_timestamp\(\) - interval '36 hours'/);
  assert.doesNotMatch(migration, /setInterval|setTimeout/);
});

test("attendance notifications are company managed but remain admin configurable", async () => {
  const migration = await read("supabase/migrations/20261102_attendance_encouragement.sql");
  const settings = await read("app/PlatformSettings.tsx");
  const page = await read("app/page.tsx");
  const policy = await read("supabase/functions/auth-policy/index.ts");

  assert.match(migration, /add column if not exists company_managed boolean not null default false/);
  assert.match(migration, /where r\.category = p_category and r\.company_managed and r\.active/);
  assert.match(page, /Company managed/);
  assert.match(page, /disabled=\{category\.managed\}/);
  assert.match(settings, /Attendance encouragement/);
  assert.match(settings, /Server-side checks every 15 minutes/);
  assert.match(settings, /Save changes/);
  assert.match(policy, /next\.attendance_notifications = normalizeAttendance\(policy\.attendance_notifications\)/);
});

test("hourly progress avoids hourly email unless the administrator enables it", async () => {
  const migration = await read("supabase/migrations/20261102_attendance_encouragement.sql");
  const settings = await read("app/PlatformSettings.tsx");

  assert.match(migration, /email_hourly/);
  assert.match(migration, /or milestone >= 9/);
  assert.match(settings, /Email every progress milestone/);
});
