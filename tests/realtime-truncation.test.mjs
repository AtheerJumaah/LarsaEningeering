/* Larsa Control — a realtime frame is a notification, not a copy of the row.
 *
 * Measured live on 2026-09-07: the shared staff blob had grown to ~900 KB,
 * past the realtime transport's message-size cap. Change events for it still
 * fired, but arrived with the `data` column EMPTY — and the handler passed
 * `row.data ?? {}` straight into applyRemote, which pasted `{}` over the
 * device's good local staff store. The server copy stayed healthy (the wipe
 * never pushed), but every device that received such an event rendered as if
 * the company had no staff: empty clock screens, engine render errors, and
 * punches judged against a store with nobody in it.
 *
 * The contract now:
 *
 *   1. The realtime handler treats content-free `data` as "something changed,
 *      contents unknown" and re-fetches the authoritative row over REST
 *      (which has no such cap) instead of applying the nothing it was sent.
 *   2. applyRemote refuses, unconditionally, to paste an empty remote copy
 *      over real local content. By the time an empty row reaches it the row
 *      was read authoritatively, so the server really lost the blob — and the
 *      answer is bootstrap's answer: seed the server back from the surviving
 *      local copy, never wipe the device.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sync = await readFile(new URL("../lib/supabase/sync.ts", import.meta.url), "utf8");

const handler = sync.slice(
  sync.indexOf('.on(\n        "postgres_changes"'),
  sync.indexOf(".subscribe("),
);
assert.ok(handler.length > 100, "the postgres_changes handler could not be isolated");

const apply = sync.slice(
  sync.indexOf("function applyRemote"),
  sync.indexOf("async function refreshFromServer"),
);
assert.ok(apply.length > 300, "applyRemote could not be isolated");

test("a content-free realtime payload triggers a re-fetch, never an apply", () => {
  assert.match(handler, /if \(!hasContent\(row\.data\)\) \{/);
  assert.match(handler, /refreshFromServer\("realtime payload had no data"\);/);
  // The guard sits before the apply, and the apply no longer defaults to {}.
  assert.ok(
    handler.indexOf("hasContent(row.data)") < handler.indexOf("applyRemote("),
    "the truncation guard must run before applyRemote",
  );
  assert.doesNotMatch(handler, /applyRemote\(row\.store_key as SyncedKey, row\.data \?\? \{\}/);
});

test("applyRemote never pastes an empty remote copy over real local content", () => {
  assert.match(apply, /if \(!hasContent\(remoteData\)\) \{/);
  assert.match(apply, /refused to apply an empty remote copy/);
  // The refusal runs before the echo check and the localStorage write.
  assert.ok(
    apply.indexOf("hasContent(remoteData)") < apply.indexOf("lastKnown.get(key) === text"),
    "the guard must precede the echo check",
  );
});

test("a genuinely emptied server row is reseeded from local, not obeyed", () => {
  // Bootstrap's stance, applied here too: empty remote + real local = push.
  const refusal = apply.slice(apply.indexOf("if (!hasContent(remoteData)) {"));
  assert.match(refusal, /schedulePush\(key\);/);
});

test("the re-fetch path reads whole rows over REST, which has no frame cap", () => {
  const refresh = sync.slice(
    sync.indexOf("async function refreshFromServer"),
    sync.indexOf("let cleanupChannel"),
  );
  assert.match(refresh, /\.select\("store_key, data, updated_at"\)/);
  assert.match(refresh, /\.in\("store_key", stale\.map\(\(\{ key \}\) => key\)\)/);
});
