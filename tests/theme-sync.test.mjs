import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("theme is an account preference with local fallback", () => {
  assert.match(page, /theme\?: "light" \| "dark";/);
  assert.match(page, /accessUsers\.find\(\(user\) => user\.id === sessionUser\.id\)\?\.theme \|\| sessionUser\.theme/);
  assert.match(page, /\["email", "phone", "location", "photo", "password", "pin", "notifyPrefs", "theme"\] as const/);
  assert.match(page, /pushSyncedKeyNow\("larsaStaffV8"\);/);
  assert.match(page, /setThemePreference\(!dark\)/);
});

test("the first synced attendance status warms auth before a punch", () => {
  assert.match(page, /if \(status !== "synced"\) return;[\s\S]*void warmAttendanceAuth\(\);/);
});
