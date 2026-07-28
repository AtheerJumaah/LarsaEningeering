#!/usr/bin/env node
/* Runs `next build` with LARSA_TARGET set.
 *
 * Written as a script rather than `LARSA_TARGET=static next build` in
 * package.json because that inline form is shell syntax: it works in bash and
 * fails in Windows cmd, which is where this project is actually developed.
 */
import { spawn } from "node:child_process";

const target = process.argv[2];
if (!["static", "node"].includes(target)) {
  console.error("Usage: node scripts/build-target.mjs <static|node>");
  process.exit(1);
}

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "build"],
  { stdio: "inherit", env: { ...process.env, LARSA_TARGET: target } },
);

child.on("exit", (code) => {
  if (code === 0) {
    console.log(target === "static"
      ? "\nDone. Upload the contents of  out/  to any web host."
      : "\nDone. Run  npm run start:node  to serve it, or deploy the .next/standalone folder.");
  }
  process.exit(code ?? 1);
});
