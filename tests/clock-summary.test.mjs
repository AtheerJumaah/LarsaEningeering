import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("employee clock summary reports hours by mode for today, week, and selected period", () => {
  assert.match(page, /const todaySummary = summarizeClockHours\(todaySessions\)/);
  assert.match(page, /const weekSummary = summarizeClockHours\(weekSessions\)/);
  assert.match(page, /const selectedSummary = summarizeClockHours\(selectedPeriodSessions\)/);
  assert.match(page, /<th scope="col">Today<\/th>/);
  assert.match(page, /<th scope="col">This week<\/th>/);
  assert.match(page, /className="hours-summary-table"/);
  assert.match(page, /\["online", "office", "site"\]/);
  assert.match(page, /className="hours-summary-total"/);
  assert.doesNotMatch(page, /<div><small>Sessions<\/small>/);
});
