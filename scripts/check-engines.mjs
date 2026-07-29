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

if (failed) {
  console.error("\nEngine check failed.");
  process.exit(1);
}
console.log("\nAll engine files parse correctly.");
