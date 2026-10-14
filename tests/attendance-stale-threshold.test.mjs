import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [page, attendance] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/attendance.mjs", import.meta.url), "utf8"),
]);

test("open attendance sessions use the conservative 16-hour stale policy", () => {
  assert.match(attendance, /export const OPEN_SESSION_STALE_HOURS = 16;/);
  assert.match(page, /openHours >= OPEN_SESSION_STALE_HOURS \? "stale"/);
  assert.doesNotMatch(page, /openHours >= 48/);
});

test("stale open sessions remain correction-only rather than auto-clocked out", () => {
  const start = page.indexOf("if (stillOpen?.time)");
  const end = page.indexOf("      record(stillOpen.time", start);
  const block = page.slice(start, end);
  const recordLine = page.slice(end, page.indexOf("\n", end));
  assert.match(recordLine, /record\(stillOpen\.time, serverNowIso\(\)/);
  assert.match(page, /openHours >= OPEN_SESSION_STALE_HOURS \? "stale"/);
  assert.doesNotMatch(block, /status:\s*["']Out["']/);
});
