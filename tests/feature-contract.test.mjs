import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("keeps the requested growth and project work areas", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  [
    'id: "performance-center"',
    'id: "staff-development"',
    'id: "performance-history"',
    'id: "project-portal"',
    '"staff-development": ["view", "add", "edit", "delete", "approve", "export", "manage"]',
    'type ProjectAccessMode = "none" | "assigned" | "all"',
    "Full history",
    "Weekly Target",
  ].forEach((requirement) => assert.ok(page.includes(requirement), requirement));
});

test("keeps responsive and installable app contracts", async () => {
  const [css, manifestText, serviceWorker] = await Promise.all([
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("public/manifest.webmanifest", root), "utf8"),
    readFile(new URL("public/sw.js", root), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.match(css, /@media \(max-width: 1024px\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "any");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === "/?view=staff-development"));
  assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === "/?view=project-portal"));
  assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === "/?view=quick-clock"));
  assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === "/?view=my-settings"));
  assert.match(serviceWorker, /larsa-control-v9/);
});

test("keeps the embedded staff launcher null-safe before sign-in", async () => {
  const staffEngine = await readFile(new URL("public/engines/timeclock.html", root), "utf8");

  assert.ok(staffEngine.includes(
    "if(window.currentUser||(typeof currentUser!=='undefined'&&currentUser))",
  ));
  assert.ok(!staffEngine.includes(
    "if(window.currentUser||typeof currentUser!=='undefined')",
  ));
});
test("keeps the version 9 work areas and settings", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");

  [
    'id: "quick-clock"',
    'id: "week-schedule"',
    'id: "my-settings"',
    'id: "accounting-hub"',
    "NOTIFY_EVENTS",
    "raiseNotification",
    "ACCOUNTING_TREE",
    "buildHomeSummary",
    "autoBuildWeek",
    "shiftColour",
  ].forEach((requirement) => assert.ok(page.includes(requirement), requirement));
});

test("keeps every accounting area inside a group", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  const accountingIds = [...page.matchAll(/engineItem\("accounting", "([\w-]+)"/g)].map((m) => m[1]);
  const tree = page.slice(page.indexOf("const ACCOUNTING_TREE"), page.indexOf("const ICONS"));
  assert.ok(accountingIds.length >= 23, `expected the accounting items, saw ${accountingIds.length}`);
  const missing = accountingIds.filter((id) => !tree.includes(`"${id}"`));
  assert.deepEqual(missing, [], `these accounting areas are not in any group: ${missing.join(", ")}`);
});

test("keeps the responsive layers for phone, tablet, and laptop", async () => {
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /overflow-x: hidden/);
});
