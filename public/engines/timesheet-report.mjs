/** @typedef {{uid:string, name:string, day:string, mode:string, start:string, end?:string|null, hours:number, status:string}} Entry */
/** @typedef {{from:string,to:string,entries:Entry[],people?:{uid:string,name:string,department?:string}[],mode?:string,search?:string,summaryOnly?:boolean}} Report */
/** @typedef {{palette?:"color"|"monochrome",bar?:boolean,pie?:boolean}} ReportOptions */
const zone = "America/Chicago";
const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
const stamp = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const punch = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const decimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shareLabel = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const modes = ["Office", "Online", "Site", "Other"];
const barLimit = 8;
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const date = day => day && Number.isFinite(Date.parse(day + "T12:00:00Z")) ? dayLabel.format(new Date(day + "T12:00:00Z")) : "Unspecified";
const clock = value => value && Number.isFinite(Date.parse(value)) ? punch.format(new Date(value)) : "—";
const cell = value => '<td class="number">' + decimal.format(value) + '</td>';

/** Use the already scoped daily net hours, including the original open/review classification. */
/** @param {Report} report */
export function summarizeReport(report) {
  const groups = new Map();
  const shifts = new Set(), flagged = new Set();
  const totals = { hours: 0, Office: 0, Online: 0, Site: 0, Other: 0 };
  function person(uid, name, department = "") {
    if (!groups.has(uid)) groups.set(uid, { name, department, entries: [], hours: 0, Office: 0, Online: 0, Site: 0, Other: 0 });
    return groups.get(uid);
  }
  for (const p of report.people || []) person(p.uid, p.name, p.department);
  for (const e of report.entries) {
    const g = person(e.uid, e.name);
    const mode = modes.includes(e.mode) ? e.mode : "Other";
    const hours = Number.isFinite(e.hours) ? e.hours : 0;
    g.entries.push(e);
    g.hours += hours;
    g[mode] += hours;
    totals.hours += hours;
    totals[mode] += hours;
    const shift = JSON.stringify([e.uid, e.start]);
    shifts.add(shift);
    if (e.status !== "Closed") flagged.add(shift);
  }
  const people = Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  for (const p of people) p.entries.sort((a, b) => a.day.localeCompare(b.day) || Date.parse(a.start) - Date.parse(b.start));
  return { people, totals, shifts: shifts.size, flagged: flagged.size };
}

/** @param {ReturnType<typeof summarizeReport>} summary */
function employeeBars({ people }) {
  const ranked = people.filter(person => person.hours > 0).sort((a, b) => b.hours - a.hours);
  if (!ranked.length) return '<p class="chart-empty">No net worked hours in this selection.</p>';
  const rows = ranked.slice(0, barLimit).map(person => `
    <li>
      <span class="bar-name">${escape(person.name)}</span>
      <span class="bar-value">${decimal.format(person.hours)} h</span>
      <span class="bar-track" aria-hidden="true"><i style="width:${100 * (person.hours / ranked[0].hours)}%"></i></span>
    </li>`);
  const note = ranked.length > barLimit ? `<p class="chart-note">Top ${barLimit} of ${ranked.length} employees with worked hours. The table includes all employees.</p>` : "";
  return note + '<ol class="bar-rows">' + rows.join("") + '</ol>';
}

/** @param {ReturnType<typeof summarizeReport>} summary */
function workModePie({ totals }) {
  const activeModes = modes.filter(mode => totals[mode] > 0);
  const total = activeModes.reduce((sum, mode) => sum + totals[mode], 0);
  if (!total) return '<p class="chart-empty">No net worked hours in this selection.</p>';
  let cumulative = 0;
  const wedges = activeModes.map((mode, index) => {
    const start = cumulative / total * 100;
    cumulative += totals[mode];
    const end = index === activeModes.length - 1 ? 100 : cumulative / total * 100;
    return `var(--${mode.toLowerCase()}) ${start}% ${end}%`;
  });
  const legend = activeModes.map(mode => {
    const share = totals[mode] / total;
    return `<li>
      <span class="mode-swatch" data-mode="${mode.toLowerCase()}" aria-hidden="true"></span>
      <span>${mode}<small>${decimal.format(totals[mode])} h</small></span>
      <b>${share < 0.001 ? "&lt;0.1%" : shareLabel.format(share)}</b>
    </li>`;
  });
  return `<div class="pie-layout"><div class="mode-pie" style="background:conic-gradient(${wedges.join(",")})" aria-hidden="true"></div>
    <ul class="pie-key">${legend.join("")}</ul></div>`;
}

/** @param {Report} report @param {ReportOptions} options */
export function reportDocument(report, generated = new Date(), { palette = "color", bar = false, pie = false } = {}) {
  const summary = summarizeReport(report);
  const { people, totals, shifts, flagged } = summary;
  const columns = modes.filter(m => m !== "Other" || people.some(p => p.entries.some(e => !modes.slice(0,3).includes(e.mode))));
  const period = report.from === report.to ? date(report.from) : date(report.from) + " – " + date(report.to);
  const groupRows = people.map(p => '<tr><th scope="row">' + escape(p.name) + (p.department ? '<small>'+escape(p.department)+'</small>' : '') + '</th>' + columns.map(m => cell(p[m])).join('') + cell(p.hours) + '</tr>').join('');
  const detail = people.filter(p => p.entries.length).map(p => '<table class="detail' + (p.entries.length <= 5 ? ' short-group' : '') + '"><thead><tr class="person"><th colspan="6">'+escape(p.name)+' <span>· '+decimal.format(p.hours)+' h</span></th></tr><tr><th>Work date</th><th>Mode</th><th>Clock in</th><th>Clock out</th><th>Status</th><th class="number">Net h</th></tr></thead><tbody>' +
    p.entries.map(e => '<tr'+(e.status === "Closed" ? '' : ' class="attention"')+'><td>'+escape(date(e.day))+'</td><td>'+escape(e.mode)+'</td><td>'+escape(clock(e.start))+'</td><td>'+escape(clock(e.end))+'</td><td>'+escape(e.status)+'</td>'+cell(e.hours)+'</tr>').join('') + '</tbody></table>').join('');
  const filters = [report.mode && report.mode !== "all" ? "Work mode · "+report.mode : "", report.search ? "Employee filter · "+report.search : ""].filter(Boolean);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Timesheet · ${escape(period)} · Larsa Control</title>
<link rel="stylesheet" href="/engines/timesheet-report.css?v=2"></head><body data-palette="${palette === "monochrome" ? "monochrome" : "color"}">
<nav aria-label="Report actions">
  <div class="report-toolbar">
    <strong>Timesheet preview</strong>
    <button id="print-report" type="button">Print / Save PDF</button>
    <button id="close-report" type="button">Close</button>
    <div class="report-options">
      <label>Appearance <select id="palette"><option value="color">Color</option><option value="monochrome"${palette === "monochrome" ? " selected" : ""}>Black and white</option></select></label>
      <label><input type="checkbox" id="bar-toggle" aria-controls="bar-chart"${bar ? " checked" : ""}> Bar chart</label>
      <label><input type="checkbox" id="pie-toggle" aria-controls="pie-chart"${pie ? " checked" : ""}> Pie chart</label>
      <label${detail ? "" : " hidden"}><input type="checkbox" id="detail-toggle" aria-controls="detail"${report.summaryOnly ? "" : " checked"}> Attendance detail</label>
    </div>
  </div>
</nav>
<main><header><div class="mast"><img src="/icons/larsa-logo.svg" alt="Larsa Engineering" width="110" height="42"><span>Larsa Control · Time &amp; attendance</span></div><h1>Employee timesheet</h1><div class="period">${escape(period)}</div><div class="meta">Generated ${escape(stamp.format(generated))} · US Central time</div>${filters.length ? '<div class="meta">'+filters.map(escape).join(' &nbsp;·&nbsp; ')+'</div>' : ''}</header>
<div class="metrics">${[[decimal.format(totals.hours)+" h","Net worked"],[people.length,"Employees listed"],[shifts,"Shifts"],[flagged,"Open or in review"]].map(([v,l])=>'<div><b>'+v+'</b><span>'+l+'</span></div>').join('')}</div>
<div id="charts" class="charts"${bar || pie ? "" : " hidden"}>
  <figure id="bar-chart"${bar ? "" : " hidden"}><figcaption>Net hours by employee</figcaption>${employeeBars(summary)}</figure>
  <figure id="pie-chart"${pie ? "" : " hidden"}><figcaption>Net hours by work mode</figcaption>${workModePie(summary)}</figure>
</div>
<h2>Employee summary</h2><table class="summary"><thead><tr><th>Employee</th>${columns.map(m=>'<th class="number">'+m+' h</th>').join('')}<th class="number">Total h</th></tr></thead><tbody>${groupRows}</tbody>${people.length ? '<tbody class="total"><tr><th scope="row">Total net hours</th>'+columns.map(m=>cell(totals[m])).join('')+cell(totals.hours)+'</tr></tbody>' : ''}</table>
${report.entries.length ? '' : '<p class="empty">No attendance entries match this selection.</p>'}
${detail ? `<section id="detail"${report.summaryOnly ? ' hidden' : ''}>
  <h2>Attendance detail</h2>
  <p class="detail-period">${escape(period)} · US Central time</p>
  <p class="caption">Net hours belong to the work date shown. A shift spanning midnight can appear on two dates with the same original punches. A dash indicates a missing punch.</p>
  ${detail}
</section>` : ''}
</main></body></html>`;
}

/** @param {Report} report @param {Window|null} preview */
export function openTimesheetReport(report, preview = window.open("", "_blank")) {
  const originDoc = document;
  const trigger = originDoc.activeElement;
  let dialog;
  let frame;
  if (!preview) {
    dialog = originDoc.createElement("dialog");
    dialog.setAttribute("aria-label", "Timesheet report preview");
    Object.assign(dialog.style, { padding: "0", border: "0", width: "min(1000px, 96vw)", height: "92vh", maxWidth: "96vw", maxHeight: "92vh" });
    frame = originDoc.createElement("iframe");
    frame.title = "Timesheet report";
    frame.style.cssText = "width:100%;height:100%;border:0;display:block";
    dialog.append(frame);
    originDoc.body.append(dialog);
    dialog.addEventListener("close", () => { dialog.remove(); trigger?.focus?.(); }, { once: true });
    dialog.showModal();
    preview = frame.contentWindow;
  }
  if (!preview) throw new Error("The report preview could not open");
  const target = preview;
  const doc = target.document;
  doc.open();
  doc.write(reportDocument(report));
  doc.close();
  if (!frame) target.opener = null;
  const palette = /** @type {HTMLSelectElement} */ (doc.getElementById("palette"));
  palette.addEventListener("change", () => { doc.body.dataset.palette = palette.value; });
  const charts = doc.getElementById("charts");
  const bar = doc.getElementById("bar-chart");
  const pie = doc.getElementById("pie-chart");
  for (const [id, panel] of [["bar-toggle", bar], ["pie-toggle", pie], ["detail-toggle", doc.getElementById("detail")]]) {
    const toggle = /** @type {HTMLInputElement} */ (doc.getElementById(id));
    if (!panel) continue;
    toggle.addEventListener("change", () => {
      panel.hidden = !toggle.checked;
      charts.hidden = bar.hidden && pie.hidden;
    });
  }
  doc.getElementById("close-report").onclick = () => dialog ? dialog.close() : target.close();
  const print = doc.getElementById("print-report");
  print.disabled = doc.readyState !== "complete";
  target.addEventListener("load", () => { print.disabled = false; }, { once: true });
  print.onclick = () => { target.focus(); target.print(); };
}
