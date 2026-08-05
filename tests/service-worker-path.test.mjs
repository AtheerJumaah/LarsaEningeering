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

test("the root service worker cache is versioned and evicts what it replaces", async () => {
  /* This used to pin the release number (v12), as did two other tests (v9,
     v13) — three pins that could never all be true again. What actually
     matters is the MECHANISM: a versioned name, and an activate handler that
     deletes every cache that does not match it. Audited 2026-08: current
     name larsa-control-v27, all three engines in CORE_FILES. */
  const serviceWorker = await readFile(new URL("public/sw.js", root), "utf8");
  assert.match(serviceWorker, /const CACHE_NAME = "larsa-control-v\d+";/);
  assert.match(serviceWorker, /\.keys\(\)/);
  assert.match(serviceWorker, /key !== CACHE_NAME\)\.map\(\(key\) => caches\.delete\(key\)\)/);
});
