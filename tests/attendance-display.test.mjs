import test from "node:test";
import assert from "node:assert/strict";
import { resolveClockDisplay } from "../lib/attendance-display.mjs";

const latestIn = { status: "In", time: "2026-10-13T14:00:00.000Z", type: "Office" };

test("a newer pending Out is shown as pending without inventing a second punch", () => {
  const shown = resolveClockDisplay({
    open: { mode: "Office" },
    latest: latestIn,
    pending: { status: "Out", occurred_at: "2026-10-13T15:00:00.000Z", work_mode: "Office" },
  });
  assert.equal(shown.status, "Out");
  assert.equal(shown.pendingIsNewer, true);
});

test("an old local queue cannot override a newer cross-device server punch", () => {
  const shown = resolveClockDisplay({
    open: null,
    latest: { status: "Out", time: "2026-10-13T16:00:00.000Z", type: "Office" },
    pending: { status: "In", occurred_at: "2026-10-13T15:00:00.000Z", work_mode: "Online" },
  });
  assert.equal(shown.status, "Out");
  assert.equal(shown.mode, "Office");
  assert.equal(shown.pendingIsNewer, false);
});

test("a pending first punch remains visible before the shared log arrives", () => {
  const shown = resolveClockDisplay({
    pending: { status: "In", occurred_at: "2026-10-13T14:00:00.000Z", work_mode: "Site" },
  });
  assert.equal(shown.status, "In");
  assert.equal(shown.mode, "Site");
  assert.equal(shown.pendingIsNewer, true);
});
