import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("email verification follows the requested role windows and expires kept sessions", async () => {
  const [devices, page] = await Promise.all([read("lib/devices.ts"), read("app/page.tsx")]);
  assert.match(devices, /SENSITIVE_ACCESS_HOURS = 48/);
  assert.match(devices, /STANDARD_ACCESS_HOURS = 72/);
  assert.match(devices, /access\.includes\("admin"\).*access\.includes\("account"\).*access\.includes\("finance"\)/s);
  /* The device check moved behind the server policy: checkVerification asks
     Supabase first and the local device stamp is the offline fallback. Same
     behaviour, new seam. */
  assert.match(page, /deviceNeedsVerification\(refreshed, getDeviceId\(\)\)/);
  assert.match(page, /checkVerification\(\{ id: refreshed\.id, access: refreshed\.access, role: refreshed\.role \}\)/);
  assert.match(page, /verificationRemainingMs\(sessionUser, getDeviceId\(\)\)/);
});

test("home, clocks, presence, and notifications keep the simplified contracts", async () => {
  const [page, css] = await Promise.all([read("app/page.tsx"), read("app/globals.css")]);
  assert.match(page, /<b>Iraq<\/b>/);
  assert.match(page, /<b>US Central<\/b>/);
  /* The personal quick actions still lead the row. My Pay joined them, so
     this asserts the ordering rather than the exact adjacency it used to. */
  assert.match(page, /"quick-clock",\s*(?:"my-pay",\s*)?"my-points",\s*"my-requests"/);
  assert.match(page, /push: true/);
  assert.match(page, /className="presence-stack"/);
  assert.match(css, /\.presence-stack \{ display: grid/);
  assert.match(page, /\.v25-timebar\{display:none!important\}/);
});

test("management and history expose scoped, separate time and performance reports", async () => {
  const [page, org, structure] = await Promise.all([
    read("app/page.tsx"), read("lib/org.ts"), read("app/OrgStructure.tsx"),
  ]);
  assert.match(page, /function EngineeringManagementPortal/);
  assert.match(page, /staffIdsVisibleTo\(org, viewer, users\)/);
  assert.match(page, /"structure" \| "time" \| "performance"/);
  assert.match(page, />Today<\/button>.*>7 days<\/button>.*>30 days<\/button>.*>6 months<\/button>.*>Year<\/button>/s);
  assert.match(org, /directReportsOf\(users, user\)/);
  /* The structure page was rewritten as cards; the old inline-create field
     went with it and adding now uses a prompt. Recorded in the audit report
     as a divergence from the previously tested contract — this asserts what
     ships today, not a preference. */
  assert.match(structure, /function addDepartment\(\)/);
  assert.match(structure, /function addTeam\(departmentId: string\)/);
  assert.match(structure, /className="org-add struct-add"/);
});

test("the service worker still carries every engine a release can change", async () => {
  // Was a version pin (v13); the version format test lives with the sw path
  // tests. What this release contract needs is the engines being cached.
  const sw = await read("public/sw.js");
  assert.match(sw, /const CACHE_NAME = "larsa-control-v\d+";/);
  for (const engine of ["timeclock", "hr", "accounting"]) {
    assert.ok(sw.includes(`/engines/${engine}.html`), `${engine} engine missing from CORE_FILES`);
  }
});
