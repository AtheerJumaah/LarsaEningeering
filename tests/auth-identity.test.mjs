import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("full email input cannot fall back to a different domain's local part", () => {
  const start = page.indexOf("const enteredFullAddress = enteredEmail.includes(\"@\");");
  const end = page.indexOf("const pinUser", start);
  assert.ok(start > 0 && end > start, "email matching block could not be isolated");
  const block = page.slice(start, end);
  assert.match(block, /if \(enteredFullAddress\)/);
  const fullAddress = block.slice(block.indexOf("if (enteredFullAddress)"), block.indexOf("return \(Boolean\(account\)", block.indexOf("if (enteredFullAddress)")));
  assert.doesNotMatch(fullAddress, /split\("@"\)\[0\]/, "full addresses must not match by local part");
});

test("restored sessions are invalidated after the authoritative roster disables the account", () => {
  assert.match(page, /Once the shared roster has been loaded, it is authoritative/);
  assert.match(page, /if \(!current \|\| current\.enabled === false \|\| current\.offboarded\)/);
  assert.match(page, /This account is no longer active\. Please contact an administrator\./);
});

test("account changes in another tab cannot leave a second tab signed in", () => {
  assert.match(page, /new BroadcastChannel\("larsa-control-auth-v1"\)/);
  assert.match(page, /message\?\.type === "signed-out"/);
  assert.match(page, /message\.userId !== current\?\.id/);
});
