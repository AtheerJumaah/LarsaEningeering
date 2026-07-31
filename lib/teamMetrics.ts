"use client";

/* Hours, sessions, points and jobs for a set of people over a period.
 *
 * Both sources live in the larsaStaffV8 blob the rest of the app already syncs:
 *
 *   logs        one row per clock event -- { uid, type, status: In | Out, time }
 *   performance one row per submitted job -- { uid, Date, Job Number, points }
 *
 * Hours are not stored anywhere; they only exist as the gap between an In and
 * the Out that follows it, so they have to be reconstructed by pairing events.
 * A shift that is still open, or an Out with no matching In after a correction,
 * contributes nothing rather than a wild number -- an unfinished shift is not
 * zero hours worked, but counting it as "now minus this morning" would quietly
 * inflate somebody's week, and a silent undercount is easier to spot than a
 * silent overcount.
 */

const STORE_KEY = "larsaStaffV8";

export type Period = "today" | "week" | "month" | "quarter" | "half" | "year" | "custom";

export const PERIOD_LABELS: { id: Period; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "quarter", label: "3 months" },
  { id: "half", label: "6 months" },
  { id: "year", label: "Year" },
  { id: "custom", label: "Custom" },
];

export type PersonMetrics = {
  id: string;
  hours: number;
  sessions: number;
  openSession: boolean;
  approvedPoints: number;
  submittedPoints: number;
  jobs: number;
  jobNumbers: string[];
};

type LogRow = { uid?: string; type?: string; status?: string; time?: string };
type PerfRow = Record<string, unknown>;

function readBlob(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

/* The week starts on Saturday, which is the working week in Iraq -- using
   Sunday here would put Saturday's work in the previous week on every report. */
function startOfWeek(date: Date): Date {
  const copy = startOfDay(date);
  const shift = (copy.getDay() + 1) % 7;
  copy.setDate(copy.getDate() - shift);
  return copy;
}

export function rangeFor(period: Period, customFrom?: string, customTo?: string): { from: Date; to: Date } {
  const now = new Date();
  if (period === "custom") {
    const from = customFrom ? startOfDay(new Date(customFrom)) : startOfWeek(now);
    const to = customTo ? endOfDay(new Date(customTo)) : endOfDay(now);
    return { from, to };
  }
  if (period === "today") return { from: startOfDay(now), to: endOfDay(now) };
  if (period === "week") return { from: startOfWeek(now), to: endOfDay(now) };

  const from = startOfDay(now);
  if (period === "month") from.setDate(1);
  else if (period === "quarter") from.setMonth(from.getMonth() - 3);
  else if (period === "half") from.setMonth(from.getMonth() - 6);
  else if (period === "year") from.setFullYear(from.getFullYear() - 1);
  return { from, to: endOfDay(now) };
}

function timeOf(value: unknown): number {
  const stamp = new Date(String(value || "")).getTime();
  return Number.isNaN(stamp) ? 0 : stamp;
}

function textOf(row: PerfRow, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function numberOf(row: PerfRow, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

export function metricsFor(ids: string[], from: Date, to: Date): Map<string, PersonMetrics> {
  const wanted = new Set(ids);
  const result = new Map<string, PersonMetrics>();
  ids.forEach((id) => {
    result.set(id, {
      id,
      hours: 0,
      sessions: 0,
      openSession: false,
      approvedPoints: 0,
      submittedPoints: 0,
      jobs: 0,
      jobNumbers: [],
    });
  });

  const blob = readBlob();
  if (!blob) return result;

  const fromMs = from.getTime();
  const toMs = to.getTime();

  /* Clock events, paired per person into finished sessions. */
  const logs = Array.isArray(blob.logs) ? (blob.logs as LogRow[]) : [];
  const byPerson = new Map<string, LogRow[]>();
  logs.forEach((row) => {
    const uid = String(row.uid || "");
    if (!wanted.has(uid)) return;
    const list = byPerson.get(uid) || [];
    list.push(row);
    byPerson.set(uid, list);
  });

  byPerson.forEach((rows, uid) => {
    const entry = result.get(uid);
    if (!entry) return;
    const ordered = rows.slice().sort((a, b) => timeOf(a.time) - timeOf(b.time));
    let openedAt = 0;
    ordered.forEach((row) => {
      const stamp = timeOf(row.time);
      if (!stamp) return;
      const status = String(row.status || "").toLowerCase();
      if (status === "in") {
        openedAt = stamp;
        return;
      }
      if (status !== "out" || !openedAt) return;
      /* Count the session against the period it finished in, so a shift is
         never split across two reports or counted in both. */
      if (stamp >= fromMs && stamp <= toMs) {
        entry.hours += Math.max(0, stamp - openedAt) / 3600000;
        entry.sessions += 1;
      }
      openedAt = 0;
    });
    if (openedAt) entry.openSession = true;
  });

  /* Submitted work. */
  const performance = Array.isArray(blob.performance) ? (blob.performance as PerfRow[]) : [];
  performance.forEach((row) => {
    const uid = textOf(row, "uid");
    if (!wanted.has(uid)) return;
    const stamp = timeOf(row.Date);
    if (!stamp || stamp < fromMs || stamp > toMs) return;
    const entry = result.get(uid);
    if (!entry) return;
    entry.jobs += 1;
    entry.approvedPoints += numberOf(row, "Approved Points");
    entry.submittedPoints += numberOf(row, "Submitted Points");
    const job = textOf(row, "Job Number");
    if (job && entry.jobNumbers.indexOf(job) < 0) entry.jobNumbers.push(job);
  });

  return result;
}

export function emptyMetrics(id: string): PersonMetrics {
  return { id, hours: 0, sessions: 0, openSession: false, approvedPoints: 0, submittedPoints: 0, jobs: 0, jobNumbers: [] };
}

export function formatHours(hours: number): string {
  if (!hours) return "0h";
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  if (!whole) return minutes + "m";
  if (!minutes) return whole + "h";
  return whole + "h " + minutes + "m";
}
