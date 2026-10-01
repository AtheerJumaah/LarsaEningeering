import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cardTools = readFileSync(new URL("../app/CardTools.tsx", import.meta.url), "utf8");

test("CardTools never observes a missing document body during hydration", () => {
  assert.match(cardTools, /const body = document\.body;/);
  assert.match(cardTools, /if \(body instanceof HTMLElement\) \{\s*observer\.observe\(body, \{ childList: true, subtree: true \}\);\s*\}/);
  assert.doesNotMatch(cardTools, /observer\.observe\(document\.body,/);
});
