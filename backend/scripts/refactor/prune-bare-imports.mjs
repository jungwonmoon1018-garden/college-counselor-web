#!/usr/bin/env node
// prune-bare-imports.mjs [--apply]
// prune-imports.mjs leaves `import "./x.js";` behind when every specifier of
// a declaration moved out with the code that used it. Such a line only pins
// when x.js is evaluated; once a module under routes/ or server/ imports x.js
// itself the line says nothing, so it goes. One that nothing else imports
// stays, because then it is the only thing loading the module.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const apply = process.argv.includes("--apply");
const file = path.join(B, "server.js");
const src = fs.readFileSync(file, "utf8");
const importedElsewhere = new Set();
for (const dir of ["routes", "server"]) {
  for (const name of fs.readdirSync(path.join(B, dir)).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(B, dir, name), "utf8");
    for (const m of text.matchAll(/from "\.\.\/([^"]+)"/g)) importedElsewhere.add("./" + m[1]);
  }
}
let dropped = 0; let kept = 0;
const out = src.split("\n").filter((line) => {
  const m = line.match(/^import "(\.\/[^"]+)";$/);
  if (!m) return true;
  if (importedElsewhere.has(m[1])) { dropped += 1; return false; }
  kept += 1;
  return true;
}).join("\n");
console.log(`bare imports: ${dropped} dropped, ${kept} kept`);
if (apply) fs.writeFileSync(file, out);
