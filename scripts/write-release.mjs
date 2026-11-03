#!/usr/bin/env node

/* A tiny, deployment-specific marker for already-open tabs.
 *
 * Service-worker update events only fire when sw.js itself changes. Most app
 * releases change JavaScript or an engine instead, so relying on that event
 * leaves an old tab running indefinitely. This file changes on every build;
 * the app fetches it without cache and reloads only when the value differs
 * from the build it originally opened. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "public", "larsa-release.json");
const source = process.env.VERCEL_GIT_COMMIT_SHA
  || process.env.GITHUB_SHA
  || process.env.CF_PAGES_COMMIT_SHA
  || "local";
const builtAt = new Date().toISOString();

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify({ release: `${source}:${builtAt}`, builtAt })}\n`, "utf8");
console.log(`Release marker written for ${source.slice(0, 12)}.`);
