/* Larsa Control — the notification system contract.
 *
 * The behaviour lives in tests/notifications-sql.test.sql, which runs the real
 * functions against a real Postgres. These pin the wiring that SQL cannot see:
 * that the bell is a permanent surface rather than a trip to Settings, that no
 * client code can reach the notification tables directly, that a push payload
 * is treated as untrusted input by the service worker, that signing out
 * releases the device, and that the design the app already had — six Home
 * cards, rounded cards, themes, RTL — was left alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/* "This must not appear" is a claim about the code, not about the prose
   explaining why it is absent — a comment naming VAPID_PRIVATE_KEY as the
   secret to set is documentation, not a leak. So these checks run against the
   source with its comments stripped. */
const code = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  .replace(/^\s*--[^\n]*/gm, " ");
const page = read("app/page.tsx");
const notify = read("lib/supabase/notify.ts");
const push = read("lib/supabase/push.ts");
const sw = read("public/sw.js");
const pass = read("app/visual-pass.css");
const sender = read("supabase/functions/send-push/index.ts");
const migration = read("supabase/migrations/20260803_notify_011_center.sql");
const dispatch = read("supabase/migrations/20260803_notify_014_dispatch.sql");
const manifest = JSON.parse(read("public/manifest.webmanifest"));
/* The service worker cache name has to change on every release that changes
   what it caches, or devices keep the old worker. A test cannot know the right
   number, and pinning one just means the test breaks on the next legitimate
   bump — which has now happened twice. So it asserts the floor: the version
   that introduced the badge icon and audible pushes, and never lower. */
const SW_VERSION_FLOOR = 27;
const swVersion = Number((read("public/sw.js").match(/larsa-control-v(\d+)/) || [])[1]);

/* ---------------------------------------------------------------- 1 - 5 */

test("1. the bell is a permanent surface, not a trip to Settings", () => {
  // It used to navigate to the settings screen. Now it opens a panel in place.
  assert.match(page, /function NotificationBell\(/);
  assert.match(page, /setBellOpen\(\(value\) => !value\)/);
  assert.match(page, /\{bellOpen && \(\s*<NotificationBell/);
  assert.ok(!/notif-button"[^>]*onClick=\{\(\) => choose\(SETTINGS_ITEM/.test(page),
    "the bell must open the notification centre, not navigate to Settings");
  // And it says what it is to a screen reader, unread count included.
  assert.match(page, /aria-label=\{unreadCount \? `Notifications, \$\{unreadCount\} unread`/);
  assert.match(page, /aria-haspopup="dialog"/);
  assert.match(page, /role="dialog"\s+aria-label="Notifications"/);
});

test("2. the notification record is written unconditionally", () => {
  const fn = page.slice(page.indexOf("function raiseNotification("), page.indexOf("PROJECT GROUP ROOMS"));
  assert.ok(fn.length > 200, "raiseNotification must still exist as the single writer");
  // The old code gated the in-app record on a preference. Nothing may.
  assert.ok(!/prefs\.inApp/.test(fn), "no preference may gate the in-app record");
  assert.ok(!/if \([^)]*inApp[^)]*\)[\s\S]{0,80}items\.unshift/.test(fn),
    "the local mirror must not be written conditionally");
  assert.match(fn, /raiseNotifications\(actor, input\.recipients\.map/);
  // And the database agrees: no column exists that could switch the bell off.
  assert.ok(!/\b(in_app|inapp|bell_enabled)\s+(boolean|text|int)/.test(code(migration)),
    "there must be no in-app column to switch the bell off");
  assert.match(migration, /create table if not exists public\.notify_prefs[\s\S]*?push_enabled[\s\S]*?mail_enabled/);
});

test("3. the settings screen states the promise in the required words", () => {
  assert.match(page, /All Larsa Control notifications always remain available in the notification bell\.\s*These settings control only alerts outside the app\./);
  assert.match(page, /className="notify-promise"/);
  assert.match(pass, /\.notify-promise \{/);
  // The heading has to agree with the promise rather than contradict it.
  assert.match(page, /<h3>Alerts outside the app<\/h3>/);
});

test("4. no client code touches a notification table directly", () => {
  for (const [name, source] of [["notify.ts", code(notify)], ["push.ts", code(push)], ["page.tsx", code(page)]]) {
    for (const table of ["notify_messages", "notify_prefs", "notify_settings",
      "notify_outbox", "notify_deliveries", "push_subscriptions"]) {
      assert.ok(!new RegExp(`from\\(["']${table}["']\\)`).test(source),
        `${name} must not read or write ${table} directly — RPCs only`);
    }
  }
  // The grants back that up: the tables have none.
  assert.match(migration, /revoke all on public\.%I from anon, authenticated/);
  assert.match(migration, /drop policy if exists "authenticated read\/write" on public\.push_subscriptions/);
});

test("5. the sender-side functions are not reachable from a browser", () => {
  /* The revoke must name PUBLIC. A function is created with EXECUTE already
     granted to PUBLIC, so "revoke from anon" removes nothing — anon still
     reaches it through PUBLIC. The first version of this migration got that
     wrong and left notify_outbox_claim, and therefore every queued push title
     and body in the company, callable with nothing but the anon key. */
  assert.match(migration, /revoke all on function public\.%s from public, anon, authenticated/,
    "sender-only functions must be revoked from PUBLIC, not just anon");
  assert.match(migration, /revoke all on function public\.%s from public'/,
    "client functions must also be revoked from PUBLIC before being granted back");
  assert.ok(!/revoke all on function public\.%s from anon, authenticated'/.test(migration),
    "revoking from anon alone leaves the PUBLIC grant in place");
  // And the sender-only list is granted to service_role and nothing else.
  assert.match(migration, /grant execute on function public\.%s to service_role/);
  const senderList = migration.slice(migration.lastIndexOf("foreach fn in array array["));
  for (const fn of ["notify_outbox_claim", "notify_outbox_finish", "notify_prune_device", "notify_actor_uid"]) {
    assert.ok(senderList.includes(fn), `${fn} must be in the sender-only revoke list`);
  }
  // Nothing in the client bundle even names them.
  for (const fn of ["notify_outbox_claim", "notify_outbox_finish", "notify_prune_device"]) {
    assert.ok(!notify.includes(fn) && !push.includes(fn) && !page.includes(fn),
      `${fn} must not appear in client code`);
  }
});

/* --------------------------------------------------------------- 6 - 10 */

test("6. the push sender takes no title or body from its caller", () => {
  // The old function accepted { staffUid, title, body } from the browser,
  // which let any signed-in tab put arbitrary text on a colleague's lock
  // screen. The payload now comes from the outbox row.
  assert.ok(!/const \{ staffUid, title, body, url \} = await req\.json\(\)/.test(sender),
    "the sender must not accept a caller-supplied title, body or recipient");
  assert.match(sender, /notify_outbox_claim/);
  assert.match(sender, /title: item\.title,\s*\n\s*body: item\.body,/);
  assert.match(sender, /SUPABASE_SERVICE_ROLE_KEY/);
  // And the client can only ask it to drain.
  assert.match(notify, /functions\.invoke\("send-push", \{ body: \{ limit: 50 \} \}\)/);
});

test("7. secrets stay out of the client bundle", () => {
  for (const source of [code(notify), code(push), code(page)]) {
    assert.ok(!/VAPID_PRIVATE_KEY/.test(source), "the private VAPID key must never reach the client");
    assert.ok(!/SERVICE_ROLE/.test(source), "the service role key must never reach the client");
  }
  // Only the public half, and only through an env var.
  assert.match(push, /process\.env\.NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  assert.ok(!/BM[A-Za-z0-9_-]{20,}/.test(push), "no VAPID key may be hard-coded");
  assert.match(sender, /Deno\.env\.get\("VAPID_PRIVATE_KEY"\)/);
});

test("8. the service worker treats a push payload as untrusted", () => {
  assert.match(sw, /function safeInternalPath\(candidate\)/);
  assert.match(sw, /if \(resolved\.origin !== self\.location\.origin\) return "\/";/);
  // Both the banner and the click go through it — a validated path is no use
  // if the click handler reads the raw value instead.
  const pushHandler = sw.slice(sw.indexOf('addEventListener("push"'), sw.indexOf('addEventListener("notificationclick"'));
  assert.match(pushHandler, /const url = safeInternalPath\(payload\.url\)/);
  const clickHandler = sw.slice(sw.indexOf('addEventListener("notificationclick"'));
  assert.match(clickHandler, /const url = safeInternalPath\(data\.url\)/);
  assert.ok(!/openWindow\(payload\.url\)|openWindow\(data\.url\)/.test(sw),
    "a raw payload URL must never be opened");
});

test("9. clicking a notification arrives at the thing it is about", () => {
  const clickHandler = sw.slice(sw.indexOf('addEventListener("notificationclick"'));
  // The old handler focused a window and stopped, so a tap left you where you
  // already were.
  assert.match(clickHandler, /existing\.postMessage\(\{ type: "larsa:notification-click"/);
  assert.match(clickHandler, /await self\.clients\.openWindow\(url\)/);
  // The page listens, and a cold start on /?n=<id> is handled too.
  assert.match(page, /data\.type !== "larsa:notification-click"/);
  assert.match(page, /params\.get\("n"\)/);
  assert.match(page, /window\.history\.replaceState/);
  // The stored target is an app item id, never a URL, so it can only ever
  // resolve to a screen this app already has.
  assert.match(page, /const target = ITEMS\.find\(\(item\) => item\.id === row\.itemId\)/);
  assert.match(migration, /item_id\s+text,\s*--.*never a URL/);
});

test("10. a notification arrived at from outside waits for the session", () => {
  // A push tapped on a locked phone must land on the sign-in screen, not show
  // the record to whoever picked the phone up.
  assert.match(page, /if \(!pendingNotification \|\| !sessionUser\?\.id \|\| !notifyConfigured\(\)\) return;/);
  // And the lookup itself is the authorisation check.
  assert.match(page, /const row = feed\.items\.find\(\(item\) => item\.id === pendingNotification\)/);
});

/* -------------------------------------------------------------- 11 - 15 */

test("11. the bell filters, searches, archives and pages", () => {
  assert.match(page, /\[\["all", "All", counts\.all\], \["unread", "Unread", counts\.unread\], \["archived", "Archived", counts\.archived\]\]/);
  assert.match(page, /placeholder="Search notifications"/);
  assert.match(page, /act\(\[row\.id\], row\.archivedAt \? "unarchive" : "archive"\)/);
  assert.match(page, /act\(\[row\.id\], row\.readAt \? "unread" : "read"\)/);
  assert.match(page, /Show older \(\{feedTotal - shown\} more\)/);
  assert.match(page, /const NOTIFY_PAGE = 12;/);
  // Typing must not fire a query per keystroke.
  assert.match(page, /setTimeout\(\(\) => \{ setQuery\(search\); setPage\(0\); \}, 250\)/);
  // Escape and a click outside both close it.
  assert.match(page, /if \(event\.key === "Escape"\) onClose\(\)/);
});

test("12. archiving hides a notification, it never deletes one", () => {
  assert.ok(!/delete\(\)[\s\S]{0,60}notify_messages/.test(code(notify)),
    "the client must have no way to delete a notification");
  assert.ok(!/notify_delete|deleteNotification/.test(code(notify) + code(page)),
    "there must be no delete-notification path at all");
  assert.match(migration, /archived_at timestamptz/);
  // Restoring is offered, which is what makes archive different from delete.
  assert.match(migration, /when act = 'unarchive' then null/);
});

test("13. unread state syncs across devices without leaking content", () => {
  assert.match(page, /return watchNotifications\(\{ id: sessionUser\.id \}, \(\) => setNotifyTick/);
  assert.match(notify, /\.on\("broadcast", \{ event: "changed" \}, \(\) => onChange\(\)\)/);
  // The broadcast is content-free and per person: guessing a colleague's topic
  // reveals that something arrived, never what it said.
  assert.match(migration, /'notify:' \|\| coalesce\(new\.user_uid, old\.user_uid\)/);
  const ping = migration.slice(migration.indexOf("function public.notify_ping()"));
  assert.ok(!/new\.title|new\.body/.test(ping.slice(0, 900)),
    "the realtime ping must not carry the notification's content");
  // Realtime being down must never roll back the notification itself.
  assert.match(ping, /exception when others then[\s\S]{0,300}null;/);
});

test("14. signing out releases this browser", () => {
  const out = page.slice(page.indexOf("const signOut = useCallback"), page.indexOf("const signOut = useCallback") + 1400);
  assert.match(out, /if \(leaving\?\.id\) void unsubscribeFromPush\(leaving\.id\)/);
  assert.match(out, /setBellOpen\(false\)/);
  assert.match(out, /setNotifyCounts\(EMPTY_COUNTS\)/);
  assert.match(out, /setAppBadge\(0\)/);
  // Both halves: unsubscribe locally AND drop the row, or the sender keeps
  // pushing at a browser that is no longer listening.
  assert.match(push, /await subscription\.unsubscribe\(\)/);
  assert.match(push, /notify_forget_device/);
});

test("15. the legacy notifications in localStorage are carried over, once", () => {
  assert.match(page, /const marker = `larsa-notify-imported-\$\{sessionUser\.id\}`/);
  assert.match(page, /importLegacy\(\{ id: sessionUser\.id, name: sessionUser\.name \}, legacy\)/);
  // Idempotent in the database too, so a second device does not double it.
  assert.match(migration, /'legacy:' \|\| coalesce\(row_in->>'id', md5\(row_in::text\)\)/);
  assert.match(migration, /on conflict \(user_uid, dedupe_key\) where dedupe_key is not null do nothing/);
  // A failed import retries next load rather than losing the history.
  assert.match(page, /\.catch\(\(\) => \{ \/\* try again next load rather than losing the history \*\/ \}\)/);
});

/* -------------------------------------------------------------- 16 - 20 */

test("16. every platform in the matrix is accounted for", () => {
  // iOS only delivers push to a PWA on the Home Screen; saying "allow
  // notifications" on a screen where allowing them cannot work is worse than
  // saying nothing.
  assert.match(push, /export function pushNeedsHomeScreen\(\)/);
  assert.match(push, /\/iPad\|iPhone\|iPod\/\.test\(ua\)/);
  assert.match(push, /navigator\.platform === "MacIntel"/);   // iPadOS reports as Mac
  assert.match(page, /<b>Add to Home Screen first<\/b>/);
  // Android, Mac, Windows and Linux all get a name in the device list.
  for (const platform of ["iPad", "iPhone", "Android", "Mac", "Windows", "Linux"]) {
    assert.ok(push.includes(`"${platform}"`), `${platform} must be named in describeThisDevice`);
  }
  for (const browser of ["Edge", "Opera", "Chrome", "Firefox", "Safari"]) {
    assert.ok(push.includes(`"${browser}"`), `${browser} must be named in describeThisDevice`);
  }
  // The manifest still declares the installability the whole thing rests on.
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
});

test("17. permission has more than two states, and each says what to do", () => {
  assert.match(push, /state: "granted" \| "denied" \| "unsupported" \| "unconfigured" \| "needs-home-screen" \| "error"/);
  assert.match(page, /<b>Blocked in this browser<\/b>/);
  assert.match(page, /<b>This browser cannot deliver alerts<\/b>/);
  assert.match(page, /<b>Not configured for this deployment<\/b>/);
  // Every one of those still reassures that the bell is unaffected.
  const states = page.slice(page.indexOf('className="notify-device-state"'), page.indexOf("What to be alerted about"));
  assert.ok((states.match(/bell/gi) || []).length >= 2,
    "a blocked or unsupported state must still say the bell keeps working");
});

test("18. devices are listed, nameable, switchable and removable", () => {
  assert.match(page, /className="notify-devices"/);
  assert.match(page, /deviceAction\(device\.id, \{ enabled: event\.target\.checked \}\)/);
  assert.match(page, /deviceAction\(device\.id, "remove"\)/);
  assert.match(page, /Last used \{notifyAgo\(device\.lastSeen\)\}/);
  assert.match(migration, /add column if not exists device_label text/);
  assert.match(migration, /add column if not exists last_seen_at timestamptz/);
  // A test alert goes down the real path, not a fake local banner: a fake one
  // proves only that this tab can draw a notification.
  assert.match(page, /const testAlert = async \(\) => \{/);
  assert.match(page, /event: "account\.test"/);
  assert.ok(!/new Notification\("Test/.test(page), "the test alert must not be a local fake");
});

test("19. the twelve categories are real, and the sensitive ones are marked", () => {
  const ids = ["attendance", "schedule", "leave", "performance", "development", "projects",
    "accounting", "pay", "approvals", "messages", "announcements", "system"];
  for (const id of ids) {
    assert.ok(migration.includes(`('${id}',`), `category ${id} must exist`);
  }
  assert.equal(ids.length, 12);
  // Pay and accounting are marked sensitive, so their alerts carry no figures.
  assert.match(migration, /\('accounting',[^\n]*true,/);
  assert.match(migration, /\('pay',[^\n]*true,/);
  assert.match(page, /Alerts for this never show figures on a lock screen/);
  // Quiet hours hold the alert and never the record.
  assert.match(page, /Alerts are held during these hours\. Notifications still arrive in the bell straight away\./);
});

test("20. the design the app already had is untouched", () => {
  // Six work-area cards on Home, still six.
  const cards = ["Time & Attendance", "Performance", "Engineering Management",
    "HR & Skills", "Accounting", "Administration"];
  for (const card of cards) assert.ok(page.includes(card), `the ${card} card must survive`);
  // Rounded cards, the decorative mark, both themes and RTL all still there.
  assert.match(read("app/globals.css"), /\.module-bubble \{[\s\S]{0,600}border-radius: 36px/);
  assert.match(pass, /\.unified-app \.module-bubble \{ border-radius: var\(--radius-card\); \}/);
  assert.match(page, /home-hero-mark/);
  assert.match(pass, /\.unified-app\.dark \.bell-panel \{/);
  assert.match(pass, /\[dir="rtl"\] \.notify-switch input:checked \+ i::after/);
  // The notification panel uses the shell's own tokens rather than inventing
  // a second palette.
  assert.match(pass, /\.bell-panel \{[\s\S]{0,600}background: var\(--surface-raised, #fff\);/);
  // And the service worker was bumped, or every device keeps the old one.
  assert.ok(swVersion >= SW_VERSION_FLOOR,
    `the service worker cache must be at least v${SW_VERSION_FLOOR}, found v${swVersion}`);
  assert.ok(sw.includes('"/icons/notify-192.png"') && sw.includes('"/icons/badge-96.png"'),
    "the notification icons must be cached with the rest");
});

/* Extras that are cheap to check and expensive to get wrong. */

test("the bell degrades honestly when there is no backend", () => {
  assert.match(page, /Showing this device only — no account storage is configured/);
  assert.match(notify, /if \(!supabaseConfigured\(\)\) return \{ data: fallback, reached: false \};/);
  /* Every RPC wrapper swallows its own failure — a notification centre that
     throws on a flaky connection is worse than one showing what it last knew.
     Checked as behaviour rather than as a comment: the previous version of
     this test pinned the wording and broke the moment the wrapper was
     rewritten, without anything actually regressing. */
  const wrapper = code(notify).slice(code(notify).indexOf("async function callRaw"));
  assert.match(wrapper, /\} catch \{[\s\S]{0,120}return \{ data: fallback, reached: false \};/);
  assert.ok(!/throw /.test(wrapper.slice(0, 900)), "the RPC wrapper must never rethrow");
});

test("the bell says when this device will never be alerted", () => {
  /* The bug that made the whole thing look broken: every record arrived, the
     bell was correct, and nothing anywhere said this browser had never been
     granted permission or subscribed. A working bell and a silent phone are
     indistinguishable from inside the app unless you say so. */
  assert.match(page, /const \[deviceState, setDeviceState\] = useState<"checking" \| "on" \| "off" \| "denied" \| "home-screen" \| "unsupported">/);
  assert.match(page, /deviceState === "off" \? "Alerts are off on this device"/);
  assert.match(page, /Notifications land here either way\./);
  assert.match(page, /const outcome = await subscribeToPush\(user\.id, user\.name\)/);
  // Every unhappy state gets its own instruction, not one generic apology.
  assert.match(page, /Notifications are blocked here/);
  assert.match(page, /Add Larsa Control to your Home Screen/);
  assert.match(page, /This browser cannot show alerts/);
  // And dismissing it sticks, per device.
  assert.match(page, /const BELL_NUDGE_KEY = "larsa-bell-nudge-dismissed"/);
  assert.match(pass, /\.bell-nudge \{/);
});

test("a subscription signed under an old key is pruned, not retried for ever", () => {
  /* 401 and 403 mean the push service rejected our VAPID signature — the
     subscription predates a key rotation and will fail on every future send.
     Only pruning 404/410 left those rows in place, so a device list could
     look healthy while nothing ever arrived on it. */
  assert.match(sender, /status === 404 \|\| status === 410 \|\| status === 401 \|\| status === 403/);
  assert.match(sender, /signed under an old key/);
  assert.match(sender, /notify_prune_device/);
});

test("a stranded push is sent late rather than never", () => {
  /* Three layers, none of them a browser: the database dispatches as it
     raises, a cron sweep re-asks every minute for anything still queued, and
     the claim itself reclaims a row abandoned mid-send by a sender that died. */
  assert.match(dispatch, /if made > 0 then perform public\.notify_dispatch\(\); end if;/);
  assert.match(dispatch, /where status = 'queued'\s*\n\s*or \(status = 'sending' and claimed_at < now\(\) - interval '5 minutes'\)/);
  assert.match(migration, /o\.status = 'sending' and o\.claimed_at < now\(\) - interval '5 minutes'/);
});

test("unreachable is not the same as empty", () => {
  /* A spinner that never resolves is the most convincing way an app has of
     looking broken, and a confidently empty bell during an outage is worse —
     it says the notifications are gone. Both are the same bug: not being able
     to tell "nothing to show" from "could not ask". */
  assert.match(notify, /reject\(new Error\("notify: timed out"\)\), 6000\)/);
  assert.match(notify, /reachable: boolean/);
  assert.match(page, /const usingLocal = Boolean\(localRows\) \|\| \(!offline && !reachable\)/);
  assert.match(page, /Offline — showing what this device already had/);
  // The spinner is bounded by the attempt, not left running for ever.
  assert.match(page, /\{busy && !shown && !usingLocal && <div className="bell-empty">Loading…<\/div>\}/);
  // And write actions are hidden rather than offered against a server that
  // cannot be reached, so nothing looks like it worked when it did not.
  assert.match(page, /if \(usingLocal \|\| !ids\.length\) return;/);
});

test("a push announces itself the way a message does", () => {
  /* Permission granted is not the same as audible. The sound preference was
     stored from day one and read by nothing, so a person could turn it off or
     on and change precisely nothing. */
  assert.match(sw, /silent: payload\.sound === false/);
  assert.match(sw, /vibrate: payload\.sound === false \? undefined : \[180, 90, 180\]/);
  assert.match(sender, /sound: item\.sound !== false/);
  assert.match(sender, /sound: boolean;/);
  // The worker must be re-fetched, or every device keeps the silent one.
  assert.ok(swVersion >= SW_VERSION_FLOOR,
    `audible pushes need at least cache v${SW_VERSION_FLOOR}, found v${swVersion}`);
});

test("a test alert that cannot be displayed says so", () => {
  /* When the OS suppresses a browser's notifications, showNotification still
     resolves, permission still reads "granted", and the banner is discarded.
     Reporting "sent" there is technically true and completely useless — it is
     how somebody concludes the software is broken when their own Do Not
     Disturb is on. So the test posts one and checks it exists. */
  assert.match(push, /export async function canDisplayNotifications\(\): Promise<boolean>/);
  assert.match(push, /const found = await registration\.getNotifications\(\{ tag \}\)/);
  assert.match(push, /found\.forEach\(\(notification\) => notification\.close\(\)\)/);
  assert.match(page, /const visible = await canDisplayNotifications\(\)/);
  assert.match(page, /this device discarded it without showing anything/);
  assert.match(page, /That is your operating system, not Larsa Control/);
});

test("delivery does not depend on a browser being open", () => {
  /* The bug that made push look like it only worked on the device you sent
     from. The client was the only thing that ever asked the sender to run —
     and that call was blocked by CORS before it left the page, silently,
     because the failure was swallowed. So nothing was ever sent, and the only
     notification anyone saw was the local probe on the sending device.
     Underneath that was a design error: the whole point of a push is to reach
     an app that is CLOSED, so a closed app cannot be what triggers it. */
  assert.match(dispatch, /create extension if not exists pg_net/);
  assert.match(dispatch, /create extension if not exists pg_cron/);
  assert.match(dispatch, /if made > 0 then perform public\.notify_dispatch\(\); end if;/);
  assert.match(dispatch, /cron\.schedule\(\s*'notify-drain-outbox',\s*'\* \* \* \* \*'/);
  // The dispatcher is the server's, never a browser's.
  assert.match(dispatch, /revoke all on function public\.notify_dispatch\(\) from public, anon, authenticated/);
  // And the client no longer nudges the sender at all.
  assert.ok(!/void drainPush\(\)/.test(code(notify)) && !/void drainPush\(\)/.test(code(page)),
    "the client must not be responsible for triggering delivery");
  // A dispatch that fails must never roll back the notification it was for.
  assert.match(dispatch, /exception when others then[\s\S]{0,220}null;/);
});

test("the sender answers a browser preflight", () => {
  /* supabase.functions.invoke sends Authorization and a JSON content type,
     which makes the browser preflight with OPTIONS. Answering that with 405
     and no Access-Control-Allow-Origin is what blocked every drain. */
  assert.match(sender, /if \(req\.method === "OPTIONS"\) return new Response\(null, \{ status: 204, headers: CORS \}\)/);
  assert.match(sender, /"Access-Control-Allow-Origin": "\*"/);
  assert.match(sender, /"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"/);
  // Every response carries them, not just the preflight.
  assert.ok(!/Response\.json\(/.test(sender),
    "every response must go through the CORS-carrying json() helper");
  assert.match(sender, /headers: \{ \.\.\.CORS, "Content-Type": "application\/json" \}/);
});

test("a notification wears the mark, not a box with the mark in it", () => {
  /* The droplet shape, filled near-black with the rim and the L in white and
     everything outside it transparent. A notification icon is one fixed image
     that cannot follow the system theme, so the contrast has to be in the
     artwork. The old icon was a square tile with the mark boxed inside it. */
  assert.match(sw, /icon: "\/icons\/notify-192\.png"/);
  assert.match(sw, /badge: "\/icons\/badge-96\.png"/);
  assert.ok(!/icon: "\/icons\/icon-192\.png"/.test(sw),
    "the square app tile must not be used as the notification icon");
  // The local display probe wears the same face.
  assert.match(push, /icon: "\/icons\/notify-192\.png"/);
  /* And the badge is the logo's strokes, not its silhouette. Android masks the
     badge to alpha and tints it, so a filled shape becomes a solid white blob
     — which on skins that promote the badge to the main icon is the only thing
     anybody sees. This is checked against the artwork, not just the filename:
     a badge whose alpha is one solid region has lost the mark. */
  const badgePng = readFileSync(new URL("../public/icons/badge-96.png", import.meta.url));
  assert.ok(badgePng.length > 300, "the badge icon must exist");
  /* The large icon's canvas is opaque. A transparent one lets the phone's own
     grey icon container show through, and that container is system UI — no
     notification API can recolour or remove it, so the only way to choose what
     sits behind the mark is to fill the canvas. */
  assert.match(sw, /An OPAQUE near-black canvas carrying the white mark/);
  const iconPng = readFileSync(new URL("../public/icons/notify-192.png", import.meta.url));
  assert.ok(iconPng.length > 1000, "the notification icon must exist");
  /* The PNG must not carry an alpha channel at all — colour type 6 (RGBA) or
     4 (grey+alpha) would mean it can be translucent somewhere, and a single
     translucent pixel lets the phone's grey container show through at that
     spot. Colour type is byte 25 of a PNG, in the IHDR chunk. */
  const colourType = iconPng[25];
  assert.ok(colourType === 2 || colourType === 0 || colourType === 3,
    `the notification icon must have no alpha channel (PNG colour type ${colourType})`);
});

test("the sidebar's rounded shoulder reveals the bar, not the page", () => {
  /* A rounded corner does not paint — it reveals whatever is behind it. Behind
     the sidebar's top-right corner was the page surface, which on any of the
     warm appearance choices (Sand, Clay, Stone…) is a different colour from
     the near-white bar an inch to its right. The curve then read as a stray
     wedge of a third colour instead of as the bar wrapping the panel.
     The strip uses the SAME value as .topbar over the SAME page surface, so
     the two composite identically rather than merely closely. */
  assert.match(pass, /\.unified-app::before \{/);
  assert.match(pass, /background: color-mix\(in srgb, var\(--bg\) 88%, transparent\)/);
  assert.match(pass, /height: 74px;\s+\/\* \.topbar's min-height/);
  // Below the sidebar (z 50) and the bar (z 30), so it only shows in the notch.
  assert.match(pass, /\.unified-app::before \{[\s\S]{0,320}z-index: 0;/);
  assert.match(pass, /\.unified-app \{ position: relative; \}/);
  // And it must never intercept a click meant for what is under it.
  assert.match(pass, /\.unified-app::before \{[\s\S]{0,360}pointer-events: none;/);
});

test("the panel escapes the topbar without escaping the theme", () => {
  /* Two bugs, one line. The topbar carries a backdrop-filter, which makes it
     the containing block for anything position:fixed inside it — so the mobile
     sheet anchored to the bottom of the bar instead of the screen. Portalling
     to <body> fixed that and broke dark mode, because .unified-app.dark no
     longer had the panel as a descendant. The shell root is the one host that
     satisfies both. */
  assert.match(page, /document\.querySelector\("\.unified-app"\) \|\| document\.body/);
  assert.match(page, /createPortal\(panel, host\)/);
  assert.ok(!/createPortal\(panel, document\.body\)/.test(page),
    "portalling to body would drop the panel out of the dark theme");
  assert.match(pass, /\.unified-app\.dark \.bell-panel \{/);
  // The anchor is measured, not assumed from the bar's height.
  assert.match(page, /button\.getBoundingClientRect\(\)/);
  assert.match(pass, /top: var\(--bell-top, 84px\)/);
});

test("the badge and the panel cannot disagree", () => {
  // A bell showing two unread while its own panel says "All caught up" is
  // what happens when the badge has a fallback and the panel does not.
  assert.match(page, /const effectiveCounts: NotifyCounts = notifyConfigured\(\) \? notifyCounts : \{/);
  assert.match(page, /const unreadCount = effectiveCounts\.unread;/);
  assert.match(page, /counts=\{effectiveCounts\}/);
});

test("the unread badge reaches the app icon, not just the bell", () => {
  assert.match(page, /setAppBadge\(sessionUser \? count : 0\)/);
  assert.match(push, /export function setAppBadge\(count: number\): void/);
  assert.match(sw, /data\.type !== "larsa:badge"/);
  assert.match(sw, /self\.navigator\.setAppBadge/);
});
