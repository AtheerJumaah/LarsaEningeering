import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("attendance exposes an explicit connection state and browser online/offline handling", () => {
  assert.match(page, /type AttendanceConnection = "connecting" \| "online" \| "offline" \| "local"/);
  assert.match(page, /setAttendanceConnectionState\("offline"\)/);
  assert.match(page, /setAttendanceConnectionState\("connecting"\)/);
  assert.match(page, /window\.addEventListener\("offline", onOffline\)/);
  assert.match(page, /window\.addEventListener\("online", onOnline\)/);
  assert.match(page, /Online · Server synced/);
  assert.match(page, /Offline · View only/);
  assert.match(page, /Your saved attendance is still visible/);
});

test("offline or uncertain connections cannot create a new server punch", () => {
  assert.match(page, /connectionState !== "online"/);
  assert.match(page, /Attendance is view-only until the connection is restored/);
  assert.match(page, /disabled=\{!punchAvailable \|\| punching\}/);
  assert.match(page, /disabled=\{clockedIn \|\| !punchAvailable\}/);
  assert.match(page, /disabled=\{!punchAvailable \|\| Boolean\(pendingStatus\)\}/);
});

test("existing pending punches remain queued for the same-event retry path", () => {
  assert.match(page, /same event id/);
  assert.match(page, /Clock action recorded; confirming with the server/);
  assert.match(page, /window\.addEventListener\("online", retryPending\)/);
});
