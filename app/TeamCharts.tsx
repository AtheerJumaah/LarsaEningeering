"use client";

/* Charts for the Timesheets and Performance tabs.
 *
 * These sit above the existing tables rather than replacing them: the table is
 * still where you check one person's exact figure, but a ranked bar answers
 * "who is behind" without reading twenty-six rows. Same numbers, same period,
 * same permission scope -- the caller passes the summaries it already built,
 * so nothing here recalculates anything.
 */

type Summary = {
  user: { id: string; name: string; department?: string };
  hours: number;
  sessions: number;
  entries: number;
  submitted: number;
  approved: number;
  target: number;
};

function hoursLabel(hours: number): string {
  if (!hours) return "0h";
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  if (!whole) return minutes + "m";
  if (!minutes) return whole + "h";
  return whole + "h " + minutes + "m";
}

function tone(done: number): string {
  if (done >= 100) return "good";
  if (done >= 60) return "warn";
  return "low";
}

export function TeamCharts({ summaries, mode }: { summaries: Summary[]; mode: "time" | "performance" }) {
  if (!summaries.length) return null;

  const people = summaries.length;

  if (mode === "time") {
    const rows = summaries.slice().sort((a, b) => b.hours - a.hours);
    const peak = Math.max(1, ...rows.map((row) => row.hours));
    const total = rows.reduce((sum, row) => sum + row.hours, 0);
    const worked = rows.filter((row) => row.hours > 0).length;
    const average = worked ? total / worked : 0;

    return (
      <section className="chart-card">
        <div className="chart-head">
          <div>
            <span className="org-eyebrow">Hours</span>
            <h3>Who worked the most</h3>
          </div>
          <div className="chart-kpis">
            <span className="hier-stat"><small>Total</small><b>{hoursLabel(total)}</b></span>
            <span className="hier-stat"><small>Average</small><b>{hoursLabel(average)}</b></span>
            <span className="hier-stat"><small>Worked</small><b>{worked} / {people}</b></span>
          </div>
        </div>
        <ul className="chart-rows">
          {rows.map((row) => (
            <li key={row.user.id}>
              <span className="chart-name">{row.user.name}</span>
              <span className="chart-track">
                <i style={{ width: Math.max(row.hours ? 2 : 0, (row.hours / peak) * 100) + "%" }} className="chart-fill-hours" />
              </span>
              <span className="chart-value">{hoursLabel(row.hours)}</span>
              <span className="chart-sub">{row.sessions} {row.sessions === 1 ? "shift" : "shifts"}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const rows = summaries
    .slice()
    .sort((a, b) => {
      const left = a.target ? a.approved / a.target : -1;
      const right = b.target ? b.approved / b.target : -1;
      return right - left;
    });
  const peak = Math.max(1, ...rows.map((row) => Math.max(row.approved, row.target)));
  const approved = rows.reduce((sum, row) => sum + row.approved, 0);
  const target = rows.reduce((sum, row) => sum + row.target, 0);
  const met = rows.filter((row) => row.target && row.approved >= row.target).length;
  const overall = target ? Math.round((approved / target) * 100) : 0;

  return (
    <section className="chart-card">
      <div className="chart-head">
        <div>
          <span className="org-eyebrow">Points</span>
          <h3>Approved against quota</h3>
        </div>
        <div className="chart-kpis">
          <span className="hier-stat"><small>Approved</small><b>{approved}</b></span>
          <span className="hier-stat"><small>Quota</small><b>{target}</b></span>
          <span className={"hier-stat hier-stat-" + tone(overall)}><small>Done</small><b>{overall}%</b></span>
          <span className="hier-stat"><small>Met</small><b>{met} / {people}</b></span>
        </div>
      </div>
      <ul className="chart-rows">
        {rows.map((row) => {
          const done = row.target ? Math.round((row.approved / row.target) * 100) : null;
          return (
            <li key={row.user.id}>
              <span className="chart-name">{row.user.name}</span>
              <span className="chart-track">
                {row.target ? (
                  <em className="chart-target" style={{ left: Math.min(100, (row.target / peak) * 100) + "%" }} />
                ) : null}
                <i
                  className={"chart-fill-" + (done === null ? "none" : tone(done))}
                  style={{ width: Math.max(row.approved ? 2 : 0, (row.approved / peak) * 100) + "%" }}
                />
              </span>
              <span className="chart-value">{row.approved}{row.target ? " / " + row.target : ""}</span>
              <span className="chart-sub">{done === null ? "no quota" : done + "%"}</span>
            </li>
          );
        })}
      </ul>
      <p className="chart-note">The notch on each bar marks that person&apos;s quota.</p>
    </section>
  );
}
