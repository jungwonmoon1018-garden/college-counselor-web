// Drop the import specifiers server.js no longer references (their users
// moved to routes/*.js). A declaration left without specifiers keeps the
// bare `import "…"` so a module's side effects still run.
import fs from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const file = `${B}/server.js`;
const src = fs.readFileSync(file, "utf8");
const report = JSON.parse(execSync("npx eslint server.js --format json", { cwd: B, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0];
const unused = new Set(report.messages.filter((m) => m.ruleId === "no-unused-vars").map((m) => m.message.match(/'([^']+)'/)[1]));
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", range: true });
const edits = [];
let dropped = 0;
let bare = 0;
for (const node of ast.body) {
  if (node.type !== "ImportDeclaration" || node.specifiers.length === 0) continue;
  const keep = node.specifiers.filter((sp) => !unused.has(sp.local.name));
  if (keep.length === node.specifiers.length) continue;
  dropped += node.specifiers.length - keep.length;
  let text;
  if (keep.length === 0) {
    text = `import "${node.source.value}";`;
    bare++;
  } else {
    const def = keep.find((sp) => sp.type === "ImportDefaultSpecifier");
    const ns = keep.find((sp) => sp.type === "ImportNamespaceSpecifier");
    const named = keep.filter((sp) => sp.type === "ImportSpecifier").map((sp) => (sp.imported.name === sp.local.name ? sp.local.name : `${sp.imported.name} as ${sp.local.name}`));
    const parts = [];
    if (def) parts.push(def.local.name);
    if (ns) parts.push(`* as ${ns.local.name}`);
    if (named.length) parts.push(named.length > 4 ? `{\n  ${named.join(",\n  ")},\n}` : `{ ${named.join(", ")} }`);
    text = `import ${parts.join(", ")} from "${node.source.value}";`;
  }
  edits.push({ at: node.range[0], end: node.range[1], text });
}
edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
fs.writeFileSync(file, out);
console.log(`dropped ${dropped} unused import specifiers across ${edits.length} declarations (${bare} kept as bare side-effect imports)`);
