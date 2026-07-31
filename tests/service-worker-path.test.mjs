import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("embedded engines register the root service worker", async () => {
  const accountingEngine = await readFile(
    new URL("public/engines/accounting.html", root),
    "utf8",
  );

  assert.ok(!accountingEngine.includes("./service-worker.js"));
  assert.equal(
    accountingEngine.match(/serviceWorker\.register\(["']\/sw\.js["']\)/g)?.length,
    2,
  );
});

test("the root service worker cache changes with this release", async () => {
  const serviceWorker = await readFile(new URL("public/sw.js", root), "utf8");

  assert.match(serviceWorker, /const CACHE_NAME = "larsa-control-v12";/);
});
