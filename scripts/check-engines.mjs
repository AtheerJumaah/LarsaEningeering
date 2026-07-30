#!/usr/bin/env node
/* Guards the bundler-wrapped engine files in public/engines.
 *
 * Those files store the real page as a JSON string inside
 * <script type="__bundler/template">. An HTML parser ends that script tag at
 * the FIRST literal "</script" it sees -- so if the JSON encoding leaves any
 * "</script>" unescaped, the browser silently truncates the template and the
 * page dies at runtime with "Error unpacking: Unterminated string in JSON".
 * Nothing in a normal build catches that, because the file is valid HTML and
 * valid JSON in isolation -- it only breaks once a browser parses it.
 *
 * This script reproduces exactly what the browser does, so the failure shows
 * up in CI instead of in someone's face.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const DIR = "public/engines";
const TAG = '<script type="__bundler/template">';
let failed = false;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
  const path = join(DIR, file);
  const content = readFileSync(path, "utf8");
  const tagAt = content.indexOf(TAG);

  if (tagAt === -1) {
    console.log(`  ok   ${file} (plain HTML, no bundler template)`);
    continue;
  }

  const body = content.slice(tagAt + TAG.length);
  const end = body.indexOf("</script"); // where the browser stops reading
  const raw = end === -1 ? body : body.slice(0, end);

  try {
    const inner = JSON.parse(raw);
    console.log(`  ok   ${file} (template parses, ${inner.length} chars)`);
  } catch (error) {
    failed = true;
    console.error(`  FAIL ${file}: template does not parse as the browser reads it`);
    console.error(`       ${error.message}`);
    console.error(
      `       Almost always an unescaped "</script>" inside the JSON string.`,
    );
    console.error(
      `       Re-encode with forward slashes escaped: JSON.stringify(s).replaceAll("/", "\\\\/")`,
    );
  }
}

/* The check above proves the HTML shell and the packed template survive a
 * browser parse. It says nothing about the JavaScript inside the ordinary
 * <script> blocks -- and a syntax error there kills the whole engine, which
 * renders as a completely blank page with no clue on screen. That shipped
 * once: an edit inserted a literal backslash-n instead of a real newline, the
 * HTML stayed perfectly valid, this script still said "ok", and the accounting
 * engine went white. Parsing every inline script with the real JS parser is
 * what catches it.
 *
 * A bundler-wrapped file has to be unpacked first, otherwise the script tags
 * found are the escaped ones inside the JSON string, which are not JavaScript
 * yet and never parse.
 */
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
  const path = join(DIR, file);
  const raw = readFileSync(path, "utf8");
  const tagAt = raw.indexOf(TAG);
  let source = raw;
  let note = "";
  if (tagAt !== -1) {
    const body = raw.slice(tagAt + TAG.length);
    const end = body.indexOf("</script");
    try {
      source = JSON.parse(end === -1 ? body : body.slice(0, end));
      note = " inside packed template";
    } catch {
      continue; // the template check above already reported this file
    }
  }
  const blocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(([tag]) => !/type="__bundler\/template"/.test(tag));
  let index = 0;
  let bad = 0;
  for (const [, code] of blocks) {
    index += 1;
    if (!code.trim()) continue;
    try {
      new vm.Script(code, { filename: `${file}#script${index}` });
    } catch (error) {
      failed = true;
      bad += 1;
      const lineAt = source.slice(0, source.indexOf(code)).split("\n").length;
      console.error(`  FAIL ${file} script #${index}${note}: ${error.message}`);
      console.error(`       block starts around line ${lineAt}`);
      const offending = String(error.stack || "").split("\n")[1];
      if (offending) console.error(`       ${offending.trim().slice(0, 160)}`);
    }
  }
  if (!bad) console.log(`  ok   ${file} (${blocks.length} inline script block(s) parse${note})`);
}

if (failed) {
  console.error("\nEngine check failed.");
  process.exit(1);
}
console.log("\nAll engine files parse correctly.");
