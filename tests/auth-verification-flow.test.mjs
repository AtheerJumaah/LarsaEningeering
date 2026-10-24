import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readPage = () => readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("expired email verification stays in-session and cannot silently kick the user out", async () => {
  const page = await readPage();
  assert.match(page, /const requestEmailVerification = useCallback/);
  assert.match(page, /setVerifyStage\(\{ user, email: user\.email, method \}\)/);
  assert.doesNotMatch(page, /For security, please sign in and verify your email again/);

  const watchdog = page.slice(
    page.indexOf("A kept browser session ends with the same verification window"),
    page.indexOf("const clickWhenReady", page.indexOf("A kept browser session ends with the same verification window")),
  );
  assert.doesNotMatch(watchdog, /window\.setTimeout\(signOut/);
  assert.match(watchdog, /requestEmailVerification\(current, "email"\)/);
});

test("online sign-in uses the server verification stamp instead of a stale local flag", async () => {
  const page = await readPage();
  const signIn = page.slice(page.indexOf("const signIn = async"), page.indexOf("const signOut = useCallback"));
  assert.match(signIn, /const initialProven = periodic\s*\?\s*Boolean\(periodic\.lastVerifiedAt\)/);
  assert.match(signIn, /: refreshed\.emailVerified === true;/);
});
