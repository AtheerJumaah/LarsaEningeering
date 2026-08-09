import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The owner asked for every user to be able to trim their OWN recorded
 * hours, for Admin accounts to trim the people they manage, and for a Super
 * Admin to trim anyone. The trim path is one-way by construction — a
 * clock-out may only move EARLIER — so self-service can close a forgotten
 * clock-out or hand back over-counted minutes but can never manufacture
 * time; adding hours still goes through the correction request and its
 * approval. Removal stays a clock manager's tool alone.
 *
 * Every rule below is enforced in the HANDLER (trimSession in Home()), not
 * in the panel — hiding a button is not a permission. The time rules
 * themselves live in lib/attendance.mjs, where tests/trim-hours.test.mjs
 * exercises them with real log fixtures.
 */

test("trimSession admits managers and Admins for their scope, and every clock user for themselves only", async () => {
  const page = await read("app/page.tsx");
  const body = page.slice(page.indexOf("const trimSession = useCallback"), page.indexOf("Removes a session outright"));
  // The manager door: the staff-clock manage capability (a Super Admin) or
  // the Admin role.
  assert.match(body, /const managesClock = Boolean\(actor && clockItem && \(hasItemPermission\(actor, clockItem, "manage"\) \|\| actor\.access === "Admin"\)\);/);
  // Self-trim is scoped by uid equality BEFORE any grant helps, and is open
  // to anyone who can use the clock at all — trim only ever shortens.
  assert.match(body, /const trimsOwnRecord = Boolean\(actor && clockItem && uid === actor\.id\s*\n\s*&& \(hasItemPermission\(actor, clockItem, "edit"\) \|\| hasItemPermission\(actor, clockItem, "add"\)\)\);/);
  assert.match(body, /if \(!actor \|\| !clockItem \|\| \(!managesClock && !trimsOwnRecord\)\) \{/);
  // Somebody else's record additionally has to sit inside the actor's own
  // data scope — checked in the handler so a forged call fails like a
  // forged click. scopedUsers short-circuits for a Super Admin.
  assert.match(body, /if \(uid !== actor\.id && !scopedUsers\(actor, accessUsers\)\.some\(\(user\) => user\.id === uid\)\) \{/);
  assert.match(body, /notify\("That employee is outside your data scope\."\);/);
});

test("the trim decision is the shared pairing engine, and the one-way rule survives intact", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /import \{ findPunchSession, planTrim \} from "\.\.\/lib\/attendance\.mjs";/);
  const body = page.slice(page.indexOf("const trimSession = useCallback"), page.indexOf("Removes a session outright"));
  // The exact selected session, by the same pairing walk the list uses,
  // validated against the server-corrected clock.
  assert.match(body, /const plan = planTrim\(logs, uid, clockIn, newClockOut, serverNowMs\(\)\);/);
  // The one-way rule that makes self-service safe must survive intact.
  assert.match(body, /You can only bring a clock-out earlier, not later\. Use a correction request to add hours\./);
  // And closing an open session may never swallow the next one.
  assert.match(body, /That would run into the next session\./);
});

test("a trim lands on the selected session's own records, is audited, and is pushed before the tab can close", async () => {
  const page = await read("app/page.tsx");
  const body = page.slice(page.indexOf("const trimSession = useCallback"), page.indexOf("Removes a session outright"));
  // In-place correction of THIS session's clock-out — same id, stamped.
  assert.match(body, /outLog\.time = nextOutIso;/);
  assert.match(body, /const stamp = `Adjusted by \$\{actor\.name\} on \$\{new Date\(\)\.toLocaleDateString\(\)\}`;/);
  // Closing an open session appends a collision-proof punch and lowers the
  // in-log's active flag — the punches themselves are never rewritten.
  assert.match(body, /id: `l\$\{uid\}\$\{Date\.now\(\)\}\$\{Math\.random\(\)\}`, uid, type: inLog\.type \|\| "Office", status: "Out",/);
  assert.match(body, /inLog\.active = false;/);
  // The audit trail carries who, whose, and both clock-outs.
  assert.match(body, /logAccountEvent\(actor, "attendance\.session_trimmed", uid,/);
  assert.match(body, /previousClockOut: previousOut,/);
  assert.match(body, /newClockOut: nextOutIso,/);
  // Punch-grade persistence: no sync-debounce window in which a refresh
  // could quietly hand the hours back.
  assert.match(body, /localStorage\.setItem\("larsaStaffV8", JSON\.stringify\(store\)\);\s*\n\s*\/\*[^]*?\*\/\s*\n\s*pushSyncedKeyNow\("larsaStaffV8"\);/);
});

test("session removal stays a manager's tool — self-service and Admin trimming get the one-way trim alone", async () => {
  const page = await read("app/page.tsx");
  const reset = page.slice(page.indexOf("Removes a session outright"), page.indexOf("---- Corrections (see CORRECTIONS_ITEM)"));
  assert.match(reset, /hasItemPermission\(actor, clockItem, "manage"\)/);
  assert.ok(!/trimsOwnRecord|actor\.access === "Admin"/.test(reset), "resetSession must not gain a self-service or Admin door");
  // Removal is bounded by the actor's scope too, and identifies the exact
  // paired session — never "the first Out after this In".
  assert.match(reset, /!scopedUsers\(actor, accessUsers\)\.some\(\(user\) => user\.id === uid\)/);
  assert.match(reset, /const found = findPunchSession\(logs, uid, clockIn\);/);
  // And the Reset button renders only for clock managers.
  assert.match(page, /\{mayAdjustHours && \(\s*\n\s*<button type="button" className="danger"/);
});

test("the quick-clock panel opens for everyone with clock access, listing exactly what the rules would let them change", async () => {
  const page = await read("app/page.tsx");
  // Admin joins the managers' panel; removal stays keyed to manage.
  assert.match(page, /const mayTrimOthers = mayAdjustHours \|\| Boolean\(user && user\.access === "Admin"\);/);
  assert.match(page, /const maySelfTrim = Boolean\(!mayTrimOthers && user && \(\(\) => \{\s*\n\s*const item = ITEMS\.find\(\(row\) => row\.id === "staff-clock"\);\s*\n\s*return item \? hasItemPermission\(user, item, "edit"\) \|\| hasItemPermission\(user, item, "add"\) : false;/);
  // The panel lists only the viewer's own sessions, or their scope for a
  // manager — nobody browses records the handler would refuse to change.
  assert.match(page, /: sessions\.filter\(\(session\) => session\.uid === user\?\.id\);/);
  assert.match(page, /trimScopeIds\.has\(session\.uid\)/);
  assert.match(page, /\{\(mayTrimOthers \|\| maySelfTrim\) && !showCorrection && \(/);
  assert.match(page, /\{\(mayTrimOthers \|\| maySelfTrim\) && showTrim && !showCorrection && \(/);
  // The self-service copy promises exactly what the code enforces.
  assert.match(page, /only ever shorter/);
});

test("managers pick the employee, then the exact session — with its times, duration, status, and any earlier adjustment", async () => {
  const page = await read("app/page.tsx");
  // The employee picker, scoped to the people the actor manages.
  assert.match(page, /const trimScope = useMemo\(\s*\n\s*\(\) => \(user && mayTrimOthers \? scopedUsers\(user, users\) : \[\]\),/);
  // A live open session is named for what it is, never given a fake out.
  assert.match(page, /"clocked in — active session"/);
  // A session already corrected says so before somebody corrects it again.
  assert.match(page, /session\.adjusted \? " · adjusted earlier" : ""/);
  // Older sessions stay reachable without losing anything: reveal, not cap.
  assert.match(page, /Show older sessions \(\{trimRows\.length - trimShown\} more\)/);
  // Day-segments of one session fold back into the one record trim keys on.
  assert.match(page, /const key = `\$\{session\.uid\}\|\$\{session\.clockIn\}`;/);
});

test("the panel opens on the viewer's OWN sessions for everyone — the team is an explicit choice, never the default", async () => {
  const page = await read("app/page.tsx");
  // Even a Super Admin lands in their own record first.
  assert.match(page, /if \(trimUser === ""\) return session\.uid === user\?\.id;/);
  assert.match(page, /if \(trimUser === "__team__"\) return \(user \? isAdmin\(user\) : false\) \|\| trimScopeIds\.has\(session\.uid\);/);
  assert.match(page, /<option value="">My sessions<\/option>/);
  assert.match(page, /<option value="__team__">/);
  // And names appear on rows only in the deliberate team view — a single
  // person's list is already named by the picker.
  assert.match(page, /\{trimUser === "__team__" && <b>\{session\.employee\}<\/b>\}/);
});

test("sessions are summarised day by day, with per-day and per-period worked totals", async () => {
  const page = await read("app/page.tsx");
  // Rows group under their calendar day, newest first, each day carrying
  // its own count and worked-hours summary.
  assert.match(page, /if \(last && last\.date === session\.date\) last\.rows\.push\(session\);/);
  assert.match(page, /className="trim-day-head"/);
  assert.match(page, /\{day\.rows\.length\} session\{day\.rows\.length === 1 \? "" : "s"\} · \{formatHours\(day\.rows\.reduce\(\(sum, row\) => sum \+ row\.hours, 0\)\)\} worked/);
  // A chosen period totals what it lists.
  assert.match(page, /\{formatHours\(trimRows\.reduce\(\(sum, row\) => sum \+ row\.hours, 0\)\)\} worked — all shown, pick any to trim\./);
});

test("any period's sessions can be laid out in full — a month, all history, or a chosen range — and picked for trimming", async () => {
  const page = await read("app/page.tsx");
  // The period presets, plus free From/To days.
  assert.match(page, /\[\["recent", "Recent"\], \["this-month", "This month"\], \["last-month", "Last month"\], \["all", "All history"\]\]/);
  assert.match(page, /setTrimFrom\(`\$\{currentMonthKey\(\)\}-01`\);/);
  assert.match(page, /setTrimTo\(monthEnd\(currentMonthKey\(previous\)\)\);/);
  // A session belongs to the day it started, and the filter says exactly that.
  assert.match(page, /\.filter\(\(session\) => \(!trimFrom \|\| session\.date >= trimFrom\) && \(!trimTo \|\| session\.date <= trimTo\)\)/);
  // Only the Recent window is capped; a chosen period shows EVERY session in
  // it — a cap inside a period would reintroduce the "which twelve?" guess.
  assert.match(page, /const visibleTrimRows = trimPreset === "recent" \? trimRows\.slice\(0, trimShown\) : trimRows;/);
  assert.match(page, /\{trimPreset === "recent" && trimRows\.length > trimShown && \(/);
  // An empty period says so honestly instead of "no sessions recorded yet".
  assert.match(page, /No sessions in this period\./);
});
