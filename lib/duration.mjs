/* The one duration engine for attendance (plain .mjs so the Node test suite
 * imports the very same file the app bundles — no mirror copy to drift).
 *
 * Rules, straight from the company's attendance specification:
 *
 *   - Durations are computed from EXACT timestamps, in milliseconds. Never
 *     from formatted strings, never by adding pre-rounded decimal hours —
 *     "1.30" is not 1 hour 30 minutes, and 0.3 + 0.45 is not a time total.
 *   - Totals are summed in exact units FIRST and formatted LAST, so
 *     1 hr 20 min + 45 min is exactly 2 hr 5 min, never a drifted decimal.
 *   - Normal display is hours and minutes: "30 min", "1 hr", "1 hr 15 min",
 *     "8 hr 30 min". Decimal hours ("1.25") exist only as a DERIVED value
 *     for accounting/payroll exports, produced from the exact minute total.
 *   - Overnight sessions are just timestamp differences: 23:30 → 01:15 the
 *     next day is 1 hr 45 min, because real date-times are subtracted —
 *     nothing resets at midnight and nothing can go negative.
 */

/** Exact elapsed milliseconds between two ISO timestamps (0 if malformed). */
export function durationMsBetween(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/** Whole minutes from exact milliseconds, rounded to the nearest minute. */
export function minutesFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 60000);
}

/** "30 min" | "1 hr" | "1 hr 15 min" | "8 hr 30 min" | "0 min" */
export function formatMinutes(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hr = Math.floor(minutes / 60);
  const min = minutes % 60;
  if (hr === 0) return `${min} min`;
  if (min === 0) return `${hr} hr`;
  return `${hr} hr ${min} min`;
}

/** Exact milliseconds → normal display. */
export function formatDurationMs(ms) {
  return formatMinutes(minutesFromMs(ms));
}

/* Bridge for the app's existing float-hour values. Those floats are exact
 * quotients of millisecond differences (ms / 3,600,000) — they were computed
 * from timestamps, not typed in — so converting to minutes here rounds ONCE,
 * at display time. Sum hours first, format last, and totals stay exact. */
export function formatHours(hours) {
  return formatMinutes(Math.round((Number(hours) || 0) * 60));
}

/** Derived decimal hours for accounting/payroll exports ONLY (Part 32). */
export function decimalHoursFromMinutes(totalMinutes, decimals = 2) {
  const minutes = Math.max(0, Number(totalMinutes) || 0);
  return (minutes / 60).toFixed(decimals);
}
