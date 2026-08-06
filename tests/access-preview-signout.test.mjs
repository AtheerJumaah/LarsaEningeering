import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* The owner reported: "if I preview as other user it logs out directly."
 *
 * Cause: the periodic-verification watchdog keys off sessionUser, and an
 * access preview swaps sessionUser to the previewed person — who has never
 * verified the administrator's device. verificationRemainingMs therefore
 * reported an expired window the instant a preview started, and signOut()
 * ended the administrator's own real session. The fix: the watchdog stands
 * down while previewOwner is set; the owner's verification window was
 * enforced at their own sign-in and resumes governing when the preview
 * ends. Restored accounts made this bite hardest (no device stamps at
 * all), but the defect applied to previewing anybody.
 */

test("the verification watchdog stands down during an access preview instead of signing the admin out", async () => {
  const page = await read("app/page.tsx");
  const start = page.indexOf("A kept browser session ends with the same verification window");
  assert.ok(start > -1, "could not locate the verification watchdog effect");
  const effect = page.slice(start, page.indexOf("}, [", start) + 200);
  // The preview guard must come BEFORE any verification computation.
  const guardAt = effect.indexOf("if (previewOwner) return;");
  const computeAt = effect.indexOf("verificationRemainingMs(sessionUser");
  assert.ok(guardAt > -1, "the effect must bail out while a preview is running");
  assert.ok(computeAt > guardAt, "the preview guard must run before the expiry computation");
  // And the effect must re-arm when the preview ends.
  assert.match(effect, /\}, \[previewOwner, sessionMethod, sessionUser, signOut\]\);/);
});

test("startAccessPreview still never persists the previewed identity as a real session", async () => {
  const page = await read("app/page.tsx");
  const body = page.slice(page.indexOf("const startAccessPreview = "), page.indexOf("const endAccessPreview = "));
  assert.ok(!/persistSession\(/.test(body), "a preview must stay in-memory only");
  assert.ok(!/adoptPushSubscription\(/.test(body), "a preview must never re-point push notifications");
});
