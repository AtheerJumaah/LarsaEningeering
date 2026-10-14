import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("Home office coverage counts active Office sessions, not scheduled shifts", () => {
  const start = page.indexOf("const inToday =");
  const end = page.indexOf("const devOpen =", start);
  assert.ok(start >= 0 && end > start);
  const block = page.slice(start, end);
  assert.match(block, /sessions\.some\(\(session\) =>/);
  assert.match(block, /session\.mode === "Office"/);
  assert.match(block, /isActiveClockSession\(session\)/);
  assert.doesNotMatch(block, /store\?\.schedule/);
});
