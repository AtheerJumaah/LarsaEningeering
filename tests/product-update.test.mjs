import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("email verification follows the requested role windows and expires kept sessions", async () => {
  const [devices, page] = await Promise.all([read("lib/devices.ts"), read("app/page.tsx")]);
  assert.match(devices, /SENSITIVE_ACCESS_HOURS = 48/);
  assert.match(devices, /STANDARD_ACCESS_HOURS = 72/);
  assert.match(devices, /access\.includes\("admin"\).*access\.includes\("account"\).*access\.includes\("finance"\)/s);
  assert.match(page, /deviceNeedsVerification\(currentUser, getDeviceId\(\)\)/);
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
  assert.match(structure, /org-inline-create/);
  assert.doesNotMatch(structure, /window\.prompt\("(?:Department|Team) name"\)/);
});

test("the service worker advances for the product update", async () => {
  assert.match(await read("public/sw.js"), /larsa-control-v13/);
});
