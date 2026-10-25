import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "larsa-push-queue-"));
const source = fileURLToPath(new URL("../lib/supabase/push-queue.ts", import.meta.url));
execFileSync(process.execPath, [
  fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
  source,
  "--outDir", dir,
  "--module", "es2022",
  "--target", "es2022",
  "--strict",
  "--skipLibCheck",
], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
const { createPushQueue } = await import(pathToFileURL(join(dir, "push-queue.js")).href);

test("an immediate save waits for an in-flight write and flushes the newer edit", async () => {
  let localValue = 1;
  let serverValue = 0;
  let releaseFirst;
  const firstWriteBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const sent = [];
  const push = createPushQueue(async () => {
    const snapshot = localValue;
    sent.push(snapshot);
    if (sent.length === 1) await firstWriteBlocked;
    serverValue = snapshot;
  }, () => localValue !== serverValue);

  const backgroundWrite = push("staff");
  await Promise.resolve();
  localValue = 2;
  let immediateSaveFinished = false;
  const immediateSave = push("staff").then(() => { immediateSaveFinished = true; });

  await Promise.resolve();
  assert.equal(immediateSaveFinished, false, "save must not claim completion while the first request is unresolved");
  releaseFirst();
  await Promise.all([backgroundWrite, immediateSave]);

  assert.deepEqual(sent, [1, 2], "the newer organization snapshot must be sent after the in-flight one");
  assert.equal(serverValue, 2, "the server-confirmed state must contain the latest edit");
});

test("a save that makes no progress yields to the UI and stops without claiming success", async()=>{
  let calls=0;let painted=false;
  const push=createPushQueue(async()=>{calls++},()=>true);
  setTimeout(()=>{painted=true},0);
  await assert.rejects(push('unused-store'),/not been confirmed/);
  assert.equal(calls,5);
  assert.equal(painted,true,'save retries must allow browser tasks to run');
  calls=0;await assert.rejects(push('unused-store'),/not been confirmed/);
  assert.equal(calls,5,'a failed drain releases its slot for a later retry');
});
