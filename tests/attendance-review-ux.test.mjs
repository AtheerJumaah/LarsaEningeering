import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

test('Time & Attendance review notice exposes exact evidence and opens correction', () => {
  assert.match(page, /reviewActions(?:\.slice\([^)]*\))?\.map\(\(event\)/, 'the panel must enumerate persisted review events');
  assert.match(page, /event\.client_event_id/, 'the panel must show each held event id');
  assert.match(page, /event\.occurred_at/, 'the panel must show each held original timestamp');
  assert.match(page, /Open correction/, 'the panel must provide a direct correction action');
});
