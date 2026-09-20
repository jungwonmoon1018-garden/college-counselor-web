#!/usr/bin/env node
// split-route-module.mjs --file routes/ec.js --out routes/ec-strength.js --name EcStrength --from 707 --to 1092 [--header "…"] [--apply]
//
// Splits a run of consecutive statements out of a route module's
// register<Family>Routes(app, deps) into a register function of their own in
// a new module. The statements travel verbatim; the imports and the
// module-level helpers they use are re-imported or moved with them (a helper
// both halves use is refused: move it to a shared module first). server.js
// gets the import and calls the new register function right after the old
// one; split tail segments last-to-first and the registration order — which
// is what Express matches by — does not change.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const eslintScope = require("eslint-scope");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const apply = args.includes("--apply");
const fileRel = arg("--file"); const outRel = arg("--out"); const name = arg("--name");
const from = Number(arg("--from")); const to = Number(arg("--to"));
const headerText = arg("--header", "");
const file = path.join(B, fileRel); const outFile = path.join(B, outRel);
if (fs.existsSync(outFile)) throw new Error(`${outRel} exists`);

const src = fs.readFileSync(file, "utf8");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", loc: true, range: true, comment: true });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
const registerDecl = ast.body.map((n) => (n.type === "ExportNamedDeclaration" ? n.declaration : n)).find((n) => n && n.type === "FunctionDeclaration" && /^register\w+Routes$/.test(n.id.name));
if (!registerDecl) throw new Error("no register function");
const registerScope = scopeManager.acquire(registerDecl);
const body = registerDecl.body.body;
const picked = body.filter((s) => s.loc.start.line >= from && s.loc.end.line <= to);
if (!picked.length) throw new Error("no statements in range");
const first = body.indexOf(picked[0]); const last = body.indexOf(picked[picked.length - 1]);
if (last - first + 1 !== picked.length) throw new Error("range is not a run of consecutive statements");
if (last !== body.length - 1) console.log("note: the range is not the tail of the register function; statements after it will now register BEFORE the moved ones");

const prev = body[first - 1];
const leading = ast.comments.filter((c) => c.range[0] >= (prev ? prev.range[1] : registerDecl.body.range[0] + 1) && c.range[1] <= picked[0].range[0] && !(prev && c.loc.start.line === prev.loc.end.line));
const start = leading.length ? leading[0].range[0] : picked[0].range[0];
const end = picked[picked.length - 1].range[1];
const inRange = (pos) => pos >= picked[0].range[0] && pos < end;

const problems = [];
const usedImports = new Map(); const usedHelpers = new Set();
const imports = new Map();
for (const node of ast.body) if (node.type === "ImportDeclaration") for (const sp of node.specifiers) imports.set(sp.local.name, { node, sp });
for (const scope of scopeManager.scopes) {
  for (const ref of scope.references) {
    if (!ref.resolved || !inRange(ref.identifier.range[0])) continue;
    const v = ref.resolved;
    if (v.scope === registerScope) {
      if (!["app", "deps"].includes(v.name) && !inRange(v.defs[0].name.range[0])) problems.push(`uses ${v.name}, declared in the register function outside the range`);
    } else if (v.scope === moduleScope) {
      if (imports.has(v.name)) usedImports.set(v.name, imports.get(v.name));
      else usedHelpers.add(v.name);
    }
  }
}
// A binding declared in the range must not be used after it.
for (const v of registerScope.variables) {
  if (!v.defs[0] || !inRange(v.defs[0].name.range[0])) continue;
  if (v.references.some((r) => !inRange(r.identifier.range[0]))) problems.push(`${v.name} is declared in the range and used outside it`);
}
// Module-level helpers: move with the range when only the range uses them.
const helperPieces = [];
for (const h of usedHelpers) {
  const v = moduleScope.set.get(h);
  const stmt = ast.body.find((n) => n.range[0] <= v.defs[0].name.range[0] && v.defs[0].name.range[1] <= n.range[1]);
  const outside = v.references.some((r) => !inRange(r.identifier.range[0]) && !(r.identifier.range[0] >= stmt.range[0] && r.identifier.range[1] <= stmt.range[1]));
  if (outside) problems.push(`module helper ${h} is used on both sides`);
  else helperPieces.push(stmt);
}
if (problems.length) { console.error("refused:\n  " + [...new Set(problems)].join("\n  ")); process.exit(1); }
for (const stmt of helperPieces) {
  for (const scope of scopeManager.scopes) for (const ref of scope.references) {
    if (!ref.resolved || ref.resolved.scope !== moduleScope) continue;
    if (ref.identifier.range[0] < stmt.range[0] || ref.identifier.range[1] > stmt.range[1]) continue;
    if (imports.has(ref.identifier.name)) usedImports.set(ref.identifier.name, imports.get(ref.identifier.name));
  }
}

const groups = new Map();
for (const [local, { node, sp }] of usedImports) {
  const key = node.source.value;
  if (!groups.has(key)) groups.set(key, { def: null, ns: null, named: [] });
  const g = groups.get(key);
  if (sp.type === "ImportDefaultSpecifier") g.def = local;
  else if (sp.type === "ImportNamespaceSpecifier") g.ns = local;
  else g.named.push(sp.imported.name === local ? local : `${sp.imported.name} as ${local}`);
}
const importLines = [];
for (const [source, g] of groups) {
  if (g.ns) importLines.push(`import * as ${g.ns} from "${source}";`);
  const parts = [];
  if (g.def) parts.push(g.def);
  if (g.named.length) parts.push(`{ ${g.named.sort().join(", ")} }`);
  if (parts.length) importLines.push(`import ${parts.join(", ")} from "${source}";`);
}
const header = headerText ? headerText.split("\\n").map((l) => `// ${l}`.trimEnd()).join("\n") + "\n" : "";
const helpersText = [...new Set(helperPieces)].sort((a, b) => a.range[0] - b.range[0]).map((s) => src.slice(s.range[0], s.range[1])).join("\n\n");
const moduleText = `${header}${importLines.length ? importLines.join("\n") + "\n" : ""}\n${helpersText ? helpersText + "\n\n" : ""}export function register${name}Routes(app, deps) {\n  ${src.slice(start, end)}\n}\n`;

const edits = [{ at: start, end, text: "" }, ...[...new Set(helperPieces)].map((s) => ({ at: s.range[0], end: s.range[1], text: "" }))];
edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
out = out.replace(/\n{3,}\}/g, "\n}").replace(/\n{4,}/g, "\n\n\n");

const serverFile = path.join(B, "server.js");
let server = fs.readFileSync(serverFile, "utf8");
const oldRegister = `${registerDecl.id.name}(app, routeDeps);`;
const anchors = server.split(oldRegister).length - 1;
if (anchors !== 1) throw new Error(`server.js: ${anchors} calls of ${registerDecl.id.name}`);
// Right after the old call. Split the tail segments last-to-first and the
// calls end up in the order the routes had inside the one function.
const lines = server.split("\n");
const idx = lines.findIndex((l) => l.trim() === oldRegister);
lines.splice(idx + 1, 0, `register${name}Routes(app, routeDeps);`);
const importAnchor = lines.findIndex((l) => l.includes(`from "./${fileRel}"`));
lines.splice(importAnchor + 1, 0, `import { register${name}Routes } from "./${outRel}";`);
server = lines.join("\n");

console.log(`${fileRel} -> ${outRel}: ${picked.length} statements (${from}-${to}), ${helperPieces.length} helpers, ${importLines.length} imports; ${src.split("\n").length} -> ${out.split("\n").length} lines`);
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }
fs.writeFileSync(outFile, moduleText);
fs.writeFileSync(file, out);
fs.writeFileSync(serverFile, server);
