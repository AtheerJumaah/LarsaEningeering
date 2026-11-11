export const REPORTING_WEEK_STORAGE_KEY = "larsaReportingWeekStartDay";
export const DEFAULT_REPORTING_WEEK_START_DAY = 6; // Saturday; Sunday=0
export const REPORTING_WEEK_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function normalizeReportingWeekStart(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_REPORTING_WEEK_START_DAY;
  const day = Number(value);
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : DEFAULT_REPORTING_WEEK_START_DAY;
}

export function readReportingWeekStart() {
  if (typeof window === "undefined") return DEFAULT_REPORTING_WEEK_START_DAY;
  try { return normalizeReportingWeekStart(window.localStorage.getItem(REPORTING_WEEK_STORAGE_KEY)); }
  catch { return DEFAULT_REPORTING_WEEK_START_DAY; }
}

export function publishReportingWeekStart(value) {
  const day = normalizeReportingWeekStart(value);
  if (typeof window === "undefined") return day;
  try { window.localStorage.setItem(REPORTING_WEEK_STORAGE_KEY, String(day)); } catch { /* private browsing */ }
  window.dispatchEvent(new CustomEvent("larsa-reporting-week-changed", { detail: day }));
  return day;
}
