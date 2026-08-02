import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("the weekly-points donut can no longer be stretched into a rectangle", () => {
  // The old rule matched the ring wrapper (a div) and beat `.ring { flex: none }`.
  assert.ok(
    !/^\.home-stat div \{/m.test(css),
    "the unscoped `.home-stat div` rule must not come back",
  );
  assert.match(css, /\.home-stat > div:not\(\.ring\)/);
  assert.match(css, /\.home-stat \.ring \{ flex: none; \}/);
  // And nothing may draw a box around it.
  assert.match(css, /\.ring, \.ring svg \{[^}]*border: 0/);
});

test("sign-in tolerates the ways people actually type credentials", () => {
  assert.match(page, /const enteredPass = loginPass\.trim\(\)/);
  assert.match(page, /String\(row\.password\)\.trim\(\) === enteredPass/);
  assert.match(page, /String\(row\.pin\)\.trim\(\) === enteredPin/);
  // Local part alone must resolve to the account.
  assert.match(page, /account === enteredLocal/);
  // A blank secret must still never sign anybody in.
  assert.match(page, /Boolean\(row\.password\)/);
  assert.match(page, /!enteredEmail \|\| !enteredPass/);
});

test("sign-in tells people which half of the credential was wrong", () => {
  assert.match(page, /That password does not match this account/);
  assert.match(page, /No account found for that email address/);
});

test("remember-me keeps the session without ever storing the password", () => {
  assert.match(page, /const KEEP_SESSION_KEY = "larsa-control-session-keep"/);
  assert.match(page, /const REMEMBER_EMAIL_KEY = "larsa-control-remember-email"/);
  assert.match(page, /if \(keep\) localStorage\.setItem\(KEEP_SESSION_KEY, payload\)/);
  assert.match(page, /localStorage\.setItem\(REMEMBER_EMAIL_KEY, enteredEmail\)/);
  // The password itself must never reach persistent storage.
  assert.ok(
    !/setItem\([^)]*,\s*loginPass/.test(page) && !/loginPass[^;]*localStorage\.setItem/.test(page),
    "the typed password must never be written to storage",
  );
  // Every session write goes through the one helper that strips the secrets,
  // so a stolen laptop yields an identity but never a working credential.
  assert.match(page, /function persistSession\(user: StaffUser, method: SignInMethod, keep: boolean\)/);
  assert.match(page, /delete safeUser\.password;\s*\n\s*delete safeUser\.pin;/);
  assert.ok(
    !/sessionStorage\.setItem\("larsa-control-session", JSON\.stringify/.test(page),
    "no code path may write the raw user record into the session store",
  );
  // Signing out drops the kept session.
  assert.match(page, /localStorage\.removeItem\(KEEP_SESSION_KEY\)/);
});

test("a group exists only once an administrator opens one", () => {
  assert.match(page, /function ProjectRoom\(/);
  assert.match(page, /const PROJECT_CHAT_KEY = "larsaProjectRoomsV1"/);
  assert.match(page, /Create project group/);
  assert.match(page, /No group has been opened for this project yet/);
  // Creation is gated on administrator rights, in the handler as well as the UI.
  assert.match(page, /const canManageGroups = Boolean\(viewer && isAdmin\(viewer\)\)/);
  assert.match(page, /if \(!viewer \|\| !creatingFor \|\| !canManageGroups\) return;/);
  // Two people cannot open two groups for the same project.
  assert.match(page, /if \(store\.rooms\.some\(\(room\) => room\.projectId === creatingFor\.id\)\)/);
  // Opening a group is itself an audited act.
  assert.match(page, /action: "created"/);
  // The room only renders when a record for it exists.
  assert.match(page, /if \(openRoom && openRoomRecord\)/);
});

test("the offline preview can still load its engines", () => {
  // Without this the single-file preview shows three blank panes, because
  // there is no server to answer /engines/*.html.
  assert.match(page, /__LARSA_ENGINE_HTML/);
  assert.match(page, /\{\.\.\.\(inlineEngines\[engine\]\s*\n?\s*\? \{ srcDoc: inlineEngines\[engine\] \}\s*\n?\s*: \{ src: URLS\[engine\] \}\)\}/);
  // It must not read the global before hydration or the markup disagrees.
  assert.match(page, /if \(!hydrated \|\| typeof window === "undefined"\) return \{\};/);
});

test("room membership reuses project access rather than inventing its own", () => {
  assert.match(page, /function roomMembers\([^)]*\)[\s\S]{0,240}visibleProjectIds\(person, projects\)\.has\(projectId\)/);
  // A room can only be opened for a project the viewer is already allowed to see.
  assert.match(page, /const openRoom = allowedProjects\.find\(\(project\) => project\.id === roomId\)/);
});

test("the room carries messages, media, members, record and a search bar", () => {
  for (const tab of ["chat", "files", "members", "audit"]) {
    assert.ok(page.includes(`"${tab}"`), `missing the ${tab} section`);
  }
  assert.match(page, /Search this group/);
  assert.match(page, /placeholder="Message text, a person's name, or a file name"/);
  // Search must reach message bodies, people and file names.
  assert.match(page, /row\.body\.toLowerCase\(\)\.includes\(needle\)/);
  assert.match(page, /row\.authorName\.toLowerCase\(\)\.includes\(needle\)/);
  assert.match(page, /file\.name\.toLowerCase\(\)\.includes\(needle\)/);
  // Photos and video render inline.
  assert.match(page, /file\.kind === "image"/);
  assert.match(page, /<video key=\{file\.id\}/);
});

test("only an administrator moderates, and nothing is ever truly erased", () => {
  assert.match(page, /const moderator = Boolean\(viewer && isAdmin\(viewer\)\)/);
  // Removal is a redaction that leaves a tombstone plus an audit entry.
  assert.match(page, /deleted: true, deletedBy: viewer\.name/);
  assert.match(page, /action: "removed"/);
  // Locked records resist removal.
  assert.match(page, /if \(row\.locked\) \{ notify\("This message is locked as a permanent record/);
  assert.match(page, /\{!row\.locked && <button type="button" className="danger"/);
  // Every state change is written to the trail.
  for (const action of ["posted", "removed", "locked", "unlocked"]) {
    assert.ok(page.includes(`"${action}"`), `the audit trail is missing "${action}"`);
  }
});

test("attachments are bounded so one photo cannot fill the browser store", () => {
  assert.match(page, /const CHAT_MAX_ATTACHMENT = 3 \* 1024 \* 1024/);
  assert.match(page, /const CHAT_IMAGE_MAX_EDGE = 1600/);
  assert.match(page, /canvas\.toDataURL\("image\/jpeg", 0\.82\)/);
  assert.match(page, /throw new Error\("too-large"\)/);
  // A failed write must surface, not silently drop the message.
  assert.match(page, /out of storage for the project rooms/);
});

test("the room is styled for phones as well as desktops", () => {
  assert.match(css, /\.room-shell \{/);
  assert.match(css, /\.room-feed \{/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*?\.room-msg \{ max-width: 94%; \}/);
});

test("messages carry likes and reactions", () => {
  assert.match(page, /const CHAT_REACTIONS = \["👍", "✅", "❤️", "🎉", "👀", "❓"\]/);
  // Ids, not counts, so a second tap removes your own and the room shows who.
  assert.match(page, /reactions\?: Record<string, string\[\]>/);
  assert.match(page, /const mine = people\.includes\(viewer\.id\)/);
  assert.match(page, /if \(!updated\.length\) delete reactions\[emoji\]/);
  // A redacted message cannot be reacted to.
  assert.match(page, /if \(!viewer \|\| row\.deleted\) return;/);
  assert.match(css, /\.room-reaction\.mine \{/);
});

test("requesting leave is personal and never gated by the approver's page", () => {
  // The defect this replaces: an engineer was permitted to submit a request
  // and given nowhere to do it, because view was inherited from staff-approvals.
  assert.match(page, /if \(item\.id === "my-requests"\) \{\s*\n\s*if \(action === "view" \|\| action === "add"\) return true;/);
  // Acting on other people's requests must still be earned.
  assert.match(page, /const approvals = ITEMS\.find\(\(row\) => row\.id === "staff-approvals"\);\s*\n\s*return approvals \? hasItemPermission\(user, approvals, action\) : false;/);
});

test("the scope switch states the population instead of asking for it", () => {
  assert.match(page, /const SCOPE_ORDER: DataScope\[\] = \["own", "team", "department", "company"\]/);
  assert.match(page, /own: "Mine", team: "Team", department: "Department", company: "Company"/);
  // One rung is not a choice.
  assert.match(page, /if \(scopes\.length < 2\) return null;/);
  // Rungs are compared by membership, not by headcount.
  assert.match(page, /const signature = usersInScope\(viewer, users, scope\)\s*\n\s*\.map\(\(user\) => user\.id\)\.sort\(\)\.join\(","\);/);
  // Nobody can be shown a scope wider than their own ceiling.
  assert.match(page, /const ceiling = SCOPE_ORDER\.indexOf\(maxScopeOf\(viewer\)\)/);
  assert.match(css, /\.scope-switch-track button\.active/);
});

test("the switch defaults to the widest scope, matching the old behaviour", () => {
  // Writing a default into state on mount froze the choice made before the
  // staff list had loaded, pinning managers to "Mine" for the session.
  assert.match(page, /const \[scope, setScope\] = useState<DataScope \| "">\(""\);/);
  assert.match(page, /if \(scope && !availableScopes\.includes\(scope as DataScope\)\) setScope\(""\);/);
  assert.match(page, /const activeScope: DataScope = \(scope \|\| availableScopes\[availableScopes\.length - 1\] \|\| "own"\) as DataScope;/);
});

test("drill-down filters appear only when there is something to drill into", () => {
  assert.match(page, /\{visibleUsers\.length > 1 && \(\s*\n\s*<label><span>Employee<\/span>/);
  assert.match(page, /\{departments\.length > 1 && \(\s*\n\s*<label><span>Department<\/span>/);
  // A single possible week is stated, not offered.
  assert.match(page, /\{weeks\.length > 1 \? \(/);
  assert.match(css, /\.filter-static \{/);
});

test("time and output stay apart except on the productivity page", () => {
  assert.match(page, /label: "Productivity History"/);
  assert.match(page, /description: "Hours worked against points and jobs delivered, for any period"/);
  // The id is unchanged so existing links and permissions still resolve.
  assert.match(page, /id: "performance-history",/);
  // Jobs come from the same records as the points, counted once each.
  assert.match(page, /const jobsIn = \(entries: PerformanceRow\[\]\) => new Set\(/);
  assert.match(page, /row\["Job Number"\] \|\| row\.Project/);
  assert.match(page, /<small>Jobs delivered<\/small>/);
});

test("the productivity export lines both record types up to one header", () => {
  const header = page.match(/\["Record Type", "Date", "Employee", "Department", "Hours", "Job Number", "Submitted Points", "Approved Points", "Project \/ Mode", "Status"\]/);
  assert.ok(header, "export header missing the job number column");
  // Ten header columns means ten cells in each of the two row shapes.
  const block = page.slice(page.indexOf("larsa-productivity-"), page.indexOf("larsa-productivity-") + 1400);
  const sessionRow = block.slice(block.indexOf("\"Clock Session\""), block.indexOf("]),"));
  assert.equal(sessionRow.split("\n").filter((line) => line.trim().endsWith(",")).length, 10);
});

test("every accounting ledger gains totals, a period and a print action", () => {
  // Added through the injection layer: the accounting engine file itself is
  // never edited, and its own money(), printDoc() and printHeader() are reused.
  assert.match(page, /window\.__larsaLedgerToolsInstalled/);
  assert.match(page, /tfoot\.larsa-totals/);
  assert.match(page, /Print \/ PDF/);
  for (const preset of ["all", "month", "quarter", "year", "last", "custom"]) {
    assert.ok(page.includes(`["${preset}",`), `period preset "${preset}" missing`);
  }
  assert.match(page, /\["detailed","Detailed"\],\["summary","Summary totals"\]/);
  // Numeric columns are found the way the engine marks them, so sections added
  // later are covered without another change here.
  assert.match(page, /if\(!th\.classList\.contains\("right"\)\)return;/);
});

test("the ledger injection cannot clobber the engine's own helpers", () => {
  const block = page.slice(
    page.indexOf("window.__larsaLedgerToolsInstalled"),
    page.indexOf('if(typeof can==="function"'),
  );
  // The injection runs in the engine's global scope. `num`, `money`, `iso` and
  // `style` all exist in there already; redeclaring any of them broke the
  // engine outright once, so the names stay prefixed.
  for (const name of ["num", "iso", "fmt", "style"]) {
    assert.ok(
      !new RegExp(`var ${name}\\s*=`).test(block),
      `"var ${name}" would collide with the accounting engine`,
    );
  }
  assert.match(block, /var larsaNum=/);
  assert.match(block, /var larsaIso=/);
});

test("the injected ledger code carries no fragile escaping", () => {
  const block = page.slice(
    page.indexOf("window.__larsaLedgerToolsInstalled"),
    page.indexOf('if(typeof can==="function"'),
  );
  // Doubled backslashes inside a template literal silently stop matching, and
  // escaped quotes inside inline handlers are worse. Neither is used.
  assert.ok(!block.includes("\\\\"), "no doubled escapes in the injected source");
  assert.ok(!/onclick="|onchange="/.test(block), "listeners are attached, not inlined");
  assert.match(block, /addEventListener\("change"/);
  assert.match(block, /addEventListener\("click"/);
});

test("the salesman is chosen from real staff, not typed", () => {
  // The engine already understood select fields; only the field type changes.
  assert.match(page, /window\.__larsaSalesRoster/);
  assert.match(page, /asPicker\("revenue","salesman"\)/);
  assert.match(page, /asPicker\("commissions","person"\)/);
  assert.match(page, /field\.type="select"/);
  // A name on an existing record must survive even after that person leaves.
  assert.match(page, /if\(name&&!seen\[name\]\)\{seen\[name\]=true;roster\.push\(name\)\}/);
  // The list is a getter so it tracks staff being added or removed.
  assert.match(page, /get:function\(\)\{return window\.__larsaSalesOptions\(\)\}/);
});

test("commission and salary are totalled together per person", () => {
  assert.match(page, /function SalesCommissions\(/);
  assert.match(page, /id: "sales-commissions"/);
  // It reads the engine's own collections; nothing is written back.
  assert.match(page, /commissions: CommissionRow\[\]/);
  assert.match(page, /payroll: PayrollRow\[\]/);
  assert.match(page, /total: salary \+ due/);
  // Pay is sensitive, so it follows the payroll permission.
  assert.match(page, /const payrollItem = ITEMS\.find\(\(row\) => row\.id === "acc-payroll"\);/);
  // Voided payroll must never inflate the cost of a person.
  assert.match(page, /!\["Void", "Rejected"\]\.includes\(row\.status\)/);
});

test("the new page is routed to the right module", () => {
  // Added to the permission table but not the channel router once, which filed
  // them under the wrong module and made them unreachable.
  /* Payroll & People joined this line when it became one portal, so the
     assertion is that the rule still routes sales-commissions to accounting,
     not that it is alone on the line. */
  assert.match(page, /if \(item\.id === "sales-commissions"(?: \|\| item\.id === "payroll-portal")?\) return "accounting";/);
  // Approval chains are not duplicated here: the Timeclock engine's Leave and
  // Approvals page already owns "Approval Flow Setup" over the same flowConfig.
  assert.ok(!/approval-flows/.test(page), "the duplicate approval screen must stay gone");
});

test("shift types can be created and corrected, not just assigned", () => {
  // They used to be a frozen constant, so a new shift was impossible.
  assert.match(page, /const SHIFT_TYPES_KEY = "shiftTypes"/);
  assert.match(page, /function shiftCatalogue\(store/);
  assert.match(page, /function shiftTimesFor\(code: string/);
  assert.match(page, /Add shift/);
  assert.match(page, /Save changes/);
  // Editing a built-in writes an override so old rosters still resolve.
  assert.match(page, /custom: !SHIFT_CODES\[code\]/);
  // A code already on the roster cannot be deleted out from under it.
  assert.match(page, /is still on the schedule\. Clear it from the roster first/);
  // Codes stay unique.
  assert.match(page, /is already a shift\. Edit that one instead/);
  assert.match(css, /\.type-form \{/);
});

test("the request form's dropdowns match its inputs", () => {
  // Selects were never styled, so they rendered at the browser's own height
  // beside 44px rounded date fields — that mismatch was the crooked row.
  assert.match(css, /\.settings-fields select \{[^}]*min-height: 44px/);
  assert.match(css, /\.settings-fields input\[type="date"\][\s\S]{0,80}width: 100%/);
  assert.match(css, /\.requests-scroll \.settings-fields \{[^}]*minmax\(200px, 260px\)/);
});

test("the app builds for hosts other than Cloudflare", () => {
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(config, /output: "export"/);
  assert.match(config, /images: \{ unoptimized: true \}/);
  assert.match(config, /output: "standalone"/);
  for (const script of ["build:static", "build:node", "start:node", "dev:next"]) {
    assert.ok(pkg.scripts[script], `missing the ${script} script`);
  }
  // The Cloudflare path must be untouched.
  assert.equal(pkg.scripts.build, "bash scripts/build-verified.sh");
});

test("nothing blocks a type-checked production build", () => {
  // Each of these stopped `next build` dead, and none of them showed up in the
  // Cloudflare build, so they would have surfaced only on the new host.
  assert.match(page, /function hasItemPermission\(user: StaffUser, item: Item, action: PermissionAction = "view"\): boolean/);
  assert.match(page, /const stillOpen = open as ClockLog \| null;/);
  assert.match(page, /interface Window \{\s*\n\s*eval\(code: string\): unknown;/);
  assert.match(page, /typeof raw === "string" \? JSON\.parse\(raw\) : \[\]/);
  assert.match(page, /const envelope = parsed && "user" in parsed/);
});

test("the per-employee chart cannot outgrow its card", () => {
  // It was a column chart: twenty-eight columns in a fixed-width card clipped
  // every name to "Mary…" and painted the bars outside the card entirely.
  assert.match(page, /function MiniBars/);
  assert.match(page, /<div className="bar-rows"/);
  assert.match(page, /<span className="bar-track">/);
  // Bar length is a share of the row, so it is bounded by construction.
  assert.match(page, /width: `\$\{row\.value > 0 \? Math\.max\(2, \(row\.value \/ peak\) \* 100\) : 0\}%`/);
  // Ranking, not roster order.
  assert.match(page, /\[\.\.\.data\]\.sort\(\(left, right\) => right\.value - left\.value\)/);
  // Whole names now fit, so the first-name-only truncation is gone.
  assert.match(page, /label: row\.user\.name, value: row\.approved/);
  // The old column rules must not come back.
  assert.ok(!/\.mini-bars? ?\{/.test(css), "the column chart CSS is gone");
  assert.ok(!/className="mini-bars?"/.test(page), "the column chart markup is gone");
  // A long list scrolls inside the card rather than stretching it.
  assert.match(css, /\.bar-rows \{[^}]*overflow-y: auto/);
  // And no panel child may paint outside its panel again.
  assert.match(css, /\.report-panel > \*, \.focus-card > \* \{[^}]*max-width: 100%/);
});

test("Supabase sync is wired in but stays a no-op until it's configured", () => {
  const client = readFileSync(new URL("../lib/supabase/client.ts", import.meta.url), "utf8");
  const sync = readFileSync(new URL("../lib/supabase/sync.ts", import.meta.url), "utf8");
  const env = readFileSync(new URL("../.env.local.example", import.meta.url), "utf8");
  // With no env vars set, the client factory returns null rather than throwing,
  // so every caller can treat "not configured" as one falsy check.
  assert.match(client, /cached = url && anonKey \? createClient\(url, anonKey\) : null;/);
  assert.match(sync, /if \(typeof window === "undefined" \|\| !supabaseConfigured\(\)\) return \(\) => \{\};/);
  // The parent app only calls in after hydration, and always keeps the cleanup.
  assert.match(page, /const cleanup = initLarsaSync\(\{/);
  assert.match(page, /return cleanup;\s*\n\s*\}, \[hydrated, refs\]\);/);
  // A remote change bumps the same storageTick the rest of the app already
  // reacts to, and reloads the engines, rather than adding a second code path.
  assert.match(page, /setStorageTick\(\(value\) => value \+ 1\);\s*\n\s*\(Object\.keys\(refs\) as Engine\[\]\)\.forEach/);
  assert.match(env, /NEXT_PUBLIC_SUPABASE_URL/);
  assert.match(env, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
});

test("a browser that opens after a remote change actually shows it", () => {
  // The bug this covers: a second browser correctly pulled another
  // device's data into localStorage on load, but the screen had already
  // rendered from the (empty or stale) state before that pull finished, and
  // nothing told React to look again — so the data was there, just not on
  // screen until a manual refresh. Confirmed live: two browsers signed into
  // the same account showed different data. Fixed by treating the initial
  // catch-up exactly like a live remote change once it completes.
  const sync = readFileSync(new URL("../lib/supabase/sync.ts", import.meta.url), "utf8");
  assert.match(sync, /const caughtUpKeys: SyncedKey\[\] = \[\];/);
  assert.match(sync, /if \(text !== before\) caughtUpKeys\.push\(key\);/);
  assert.match(sync, /caughtUpKeys\.forEach\(\(key\) => options\.onRemoteChange\?\.\(key\)\);/);
});

test("the sync engine never pushes a write it just applied from Supabase", () => {
  const sync = readFileSync(new URL("../lib/supabase/sync.ts", import.meta.url), "utf8");
  // Both the push side and the realtime side compare against the same
  // lastKnown map, which is what stops a remote update from being echoed
  // straight back up as if it were a new local change.
  assert.match(sync, /const lastKnown = new Map<string, string>\(\);/);
  assert.match(sync, /if \(raw === lastKnown\.get\(key\)\) return; \/\/ nothing new since our last push/);
  assert.match(sync, /if \(lastKnown\.get\(row\.store_key\) === text\) return; \/\/ our own write, echoed back/);
  // Writes are debounced per key so a flurry of edits becomes one network call.
  assert.match(sync, /setTimeout\(\(\) => \{ pushKey\(key\)\.catch/);
  // Cleanup always restores the original setItem, so a second init (e.g. a
  // route change) can't stack patches on top of each other.
  assert.match(sync, /window\.localStorage\.setItem = originalSetItem;/);
});

const schemaSql = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");

test("the Supabase schema matches the app's three real storage keys", () => {
  for (const key of [
    "larsaStaffV8",
    "larsa_enterprise_v3_new_account_20260630_v34_clean",
    "larsa_hr_visual_counts_v5",
  ]) {
    assert.ok(schemaSql.includes(key), `schema.sql is missing the "${key}" store`);
  }
  // Row Level Security is on, and the policy requires a real session rather
  // than trusting the anon key alone.
  assert.match(schemaSql, /alter table public\.app_state enable row level security;/);
  assert.match(schemaSql, /using \(auth\.role\(\) = 'authenticated'\)/);
});

test("Vercel gets its own build target that leaves next.config.ts untouched", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.equal(pkg.scripts["build:vercel"], "next build");
  assert.ok(pkg.dependencies["@supabase/supabase-js"], "missing the Supabase client dependency");
  // Vercel wants the same unmodified output as the Cloudflare default (no
  // `output` override) — this documents that so the two targets don't drift.
  assert.match(config, /Vercel's own Next\.js runtime/);
});
