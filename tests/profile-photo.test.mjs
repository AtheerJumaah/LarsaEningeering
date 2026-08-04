/* Larsa Control — profile photographs.
 *
 * Two decisions worth pinning, because both would be easy to undo by accident.
 *
 * WHERE IT LIVES. Not in a bucket. This deployment has no file storage at all
 * — zero buckets, zero objects — and the sign-in model is a self-asserted
 * actor on an anonymous Supabase session, so a bucket could not be scoped to
 * its owner by RLS even if one existed. The picture sits on the person's own
 * record, which is what already travels with them everywhere.
 *
 * WHICH MEANS IT HAS TO BE SMALL. That record is synced in full to every
 * device. A photograph off a phone is 3-8 MB; storing one unaltered would make
 * signing in slower for the whole company. Every picture is cropped square and
 * re-encoded before it is stored, and the browser test next door measures what
 * actually comes out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const page = await read("app/page.tsx");
const css = await read("app/globals.css");

// ------------------------------------------------------------- it is bounded
test("a photo is re-encoded, never stored as it arrived", () => {
  assert.match(page, /function prepareAvatar\(file: File\): Promise<string> \{/);
  assert.match(page, /const AVATAR_EDGE = 192;/);
  assert.match(page, /const AVATAR_MAX_BYTES = 48 \* 1024;/);
  // Square, from the middle, rather than squashed into the circle.
  assert.match(page, /Math\.round\(\(width - edge\) \/ 2\), Math\.round\(\(height - edge\) \/ 2\), edge, edge,/);
  assert.match(page, /canvas\.width = AVATAR_EDGE;\s*\n\s*canvas\.height = AVATAR_EDGE;/);
});

test("and it tries harder before giving up", () => {
  /* Being told "too large" about a photo you cannot resize is a dead end —
     the app is the thing holding the encoder. It steps the quality down. */
  assert.match(page, /const AVATAR_QUALITY_LADDER = \[0\.8, 0\.68, 0\.55, 0\.42\];/);
  assert.match(page, /for \(const quality of AVATAR_QUALITY_LADDER\) \{/);
  assert.match(page, /if \(encoded\.length <= AVATAR_MAX_BYTES\) \{ resolve\(encoded\); return; \}/);
});

test("something that is not a picture is refused before any of that", () => {
  assert.match(page, /if \(!String\(file\.type \|\| ""\)\.startsWith\("image\/"\)\) \{\s*\n\s*return Promise\.reject\(new Error\("not-an-image"\)\);/);
  // And every failure says something a person can act on.
  assert.match(page, /That file is not a picture\. Choose a JPEG or PNG\./);
  assert.match(page, /That picture would not compress small enough\. Try a different one\./);
});

// -------------------------------------------------------------- whose is whose
test("a person sets their own picture and nobody else's", () => {
  /* The same line the password draws. saveOwnProfile's allow-list is the
     enforcement — the form merely not offering the option would not be. */
  assert.match(page, /\(\["email", "phone", "location", "photo", "password", "pin", "notifyPrefs"\] as const\)/);
  // Role, access and permissions stay off that list.
  assert.match(page, /\/\/ Role, access, scope, and permissions are never editable from here\./);
});

test("an administrator can take a picture down but not put one up", () => {
  // Moderation without impersonation: the control only ever clears.
  assert.match(page, /onClick=\{\(\) => updateDraft\("photo", ""\)\}>Remove photo<\/button>/);
  assert.match(page, /Set by \{draft\.name \|\| "this person"\}\. You can take it down; only they can choose a new one\./);
  // There is no way to set one from the admin form.
  assert.doesNotMatch(page, /updateDraft\("photo", [^"]/);
});

// ------------------------------------------------------------- how it appears
test("one component covers every place a person is shown", () => {
  assert.match(page, /function PersonAvatar\(\{ person, className \}/);
  assert.match(page, /if \(!photo\) return <span className=\{className\}>\{initials\(name\)\}<\/span>;/);
  // The three places that used to hand-roll initials.
  assert.match(page, /<PersonAvatar person=\{sessionUser\} \/>/);          // sidebar account
  assert.match(page, /<PersonAvatar person=\{user\} \/>\s*\n\s*<span><b>\{user\.name\}<\/b>/);  // Users & Access list
  assert.match(page, /<PersonAvatar person=\{user\} \/>\s*\n\s*<div><small>Adding points for<\/small>/);
});

test("the picture takes the shape the layout already gave the initials", () => {
  /* Reusing the same span is what let all three places keep their own sizes
     and rounding without a single one of them changing. */
  assert.match(css, /\.person-photo \{ position: relative; overflow: hidden; color: transparent; \}/);
  assert.match(css, /\.person-photo img \{ position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; \}/);
});

test("initials remain the default, not a fallback nobody sees", () => {
  // Most people will never upload one, so that path has to stay first-class.
  assert.match(page, /Optional\. Without one your initials are shown instead\./);
  assert.match(page, /function initials\(name: string\) \{/);
});

test("the photo field is documented where it is declared", () => {
  // Anybody adding to StaffUser later needs to know why this one is a data URL.
  assert.match(page, /this deployment has no file storage at\s*\n\s*all/);
  assert.match(page, /photo\?: string;/);
});
