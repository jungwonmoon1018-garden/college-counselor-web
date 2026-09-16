// Drop the import specifiers a JSX module no longer references (after a
// component moved out). Usage: node prune-app-imports.mjs <file.jsx>
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const eslintScope = require("eslint-scope");
const file = process.argv[2];
const src = fs.readFileSync(file, "utf8");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", range: true, ecmaFeatures: { jsx: true } });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
const jsxNames = new Set();
(function walk(n) {
  if (!n || typeof n.type !== "string") return;
  if (n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier") jsxNames.add(n.name.name);
  if (n.type === "JSXOpeningElement" && n.name.type === "JSXMemberExpression") { let o = n.name; while (o.type === "JSXMemberExpression") o = o.object; jsxNames.add(o.name); }
  for (const key of Object.keys(n)) { if (key === "loc" || key === "range" || key === "parent") continue; const v = n[key]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === "string") walk(v); }
})(ast);
const used = (name) => {
  const v = moduleScope.set.get(name);
  return (v && v.references.length > 0) || jsxNames.has(name);
};
const edits = [];
let dropped = 0;
for (const node of ast.body) {
  if (node.type !== "ImportDeclaration" || node.specifiers.length === 0) continue;
  const keep = node.specifiers.filter((sp) => used(sp.local.name));
  if (keep.length === node.specifiers.length) continue;
  dropped += node.specifiers.length - keep.length;
  let text;
  if (keep.length === 0) text = `import "${node.source.value}";`;
  else {
    const def = keep.find((sp) => sp.type === "ImportDefaultSpecifier");
    const named = keep.filter((sp) => sp.type === "ImportSpecifier").map((sp) => (sp.imported.name === sp.local.name ? sp.local.name : `${sp.imported.name} as ${sp.local.name}`));
    const parts = [];
    if (def) parts.push(def.local.name);
    if (named.length) parts.push(`{ ${named.join(", ")} }`);
    text = `import ${parts.join(", ")} from "${node.source.value}";`;
  }
  edits.push({ at: node.range[0], end: node.range[1], text });
}
edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
fs.writeFileSync(file, out);
console.log(file.split("/").pop(), "dropped", dropped, "unused import specifiers");
