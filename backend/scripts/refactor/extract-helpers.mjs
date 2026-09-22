#!/usr/bin/env node
// extract-helpers.mjs --out server/<area>.js --names f1,f2,… [--header "…"] [--apply]
//
// Moves top-level helper functions out of server.js into server/<area>.js.
// The functions travel verbatim (no re-indentation, so a multi-line template
// literal keeps its text); inside them a reference to another moved name is
// left alone, a reference to an import is re-imported, and a reference to
// any other server.js binding becomes `deps.<name>` — the same routeDeps
// object of live getters the route families read. The module keeps `deps` in
// one module-level variable set by `bind<Area>(routeDeps)`, which server.js
// calls right under routeDeps, above every other statement, because an
// imported function is callable from the first line just as the hoisted
// declaration was. A `let`/`const` may move too when its initializer needs
// nothing from server.js and nothing that stays assigns it.
// Refused: a moved function that assigns a server binding.
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
const outRel = arg("--out");
const names = arg("--names", "").split(",").filter(Boolean);
const headerText = arg("--header", "");
const area = path.basename(outRel, ".js").split(/[^a-z0-9]+/i).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const bindName = `bind${area}`;

const file = path.join(B, "server.js");
const outFile = path.join(B, outRel);
if (fs.existsSync(outFile)) throw new Error(`${outRel} exists`);
const src = fs.readFileSync(file, "utf8");
if (src.includes("\r\n")) throw new Error("server.js is CRLF");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", loc: true, range: true, comment: true });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");

const imports = new Map();
for (const node of ast.body) {
  if (node.type !== "ImportDeclaration") continue;
  for (const sp of node.specifiers) {
    const kind = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportNamespaceSpecifier" ? "namespace" : "named";
    imports.set(sp.local.name, { source: node.source.value, kind, imported: kind === "named" ? sp.imported.name : null });
  }
}

const problems = [];
const moved = [];
const movedNames = new Set();
for (const name of names) {
  const stmt = ast.body.find((n) => (n.type === "FunctionDeclaration" && n.id.name === name) || (n.type === "VariableDeclaration" && n.declarations.some((d) => d.id.type === "Identifier" && d.id.name === name)));
  if (!stmt) { problems.push(`${name}: no top-level function or variable`); continue; }
  if (moved.includes(stmt)) continue;
  moved.push(stmt);
  if (stmt.type === "FunctionDeclaration") movedNames.add(name);
  else stmt.declarations.forEach((d) => movedNames.add(d.id.name));
}
moved.sort((a, b) => a.range[0] - b.range[0]);
const inMoved = (pos) => moved.some((s) => s.range[0] <= pos && pos < s.range[1]);

function dynamicImportsIn(root) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "ImportExpression") out.push(n);
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "range" || key === "parent") continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c));
      else if (v && typeof v.type === "string") walk(v);
    }
  };
  walk(root);
  return out;
}

function findParent(root, target) {
  let found = null;
  const walk = (n, parent) => {
    if (found || !n || typeof n.type !== "string") return;
    if (n === target) { found = parent; return; }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "range" || key === "parent") continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c, n));
      else if (v && typeof v.type === "string") walk(v, n);
    }
  };
  walk(root, null);
  return found;
}

// Every reference to a module-scope binding, wherever it is made.
const moduleRefs = [];
for (const scope of scopeManager.scopes) for (const ref of scope.references) if (ref.resolved && ref.resolved.scope === moduleScope) moduleRefs.push(ref);

const usedImports = new Map();
const deps = new Set();
const pieces = [];
for (const stmt of moved) {
  const index = ast.body.indexOf(stmt);
  const prev = ast.body[index - 1];
  const leading = ast.comments.filter((c) => c.range[0] >= (prev ? prev.range[1] : 0) && c.range[1] <= stmt.range[0] && !(prev && c.loc.start.line === prev.loc.end.line));
  const start = leading.length ? leading[0].range[0] : stmt.range[0];
  let end = stmt.range[1];
  const next = ast.body[index + 1];
  const own = ast.comments.filter((c) => c.range[0] >= end && c.loc.start.line === stmt.loc.end.line && (!next || c.range[1] <= next.range[0]));
  if (own.length) end = own[own.length - 1].range[1];
  const edits = [];
  for (const ref of moduleRefs) {
    const id = ref.identifier;
    if (id.range[0] < stmt.range[0] || id.range[1] > stmt.range[1]) continue;
    const nm = id.name;
    if (movedNames.has(nm)) continue;
    if (imports.has(nm)) { usedImports.set(nm, imports.get(nm)); continue; }
    if (stmt.type === "VariableDeclaration") { problems.push(`${nm}: the initializer of ${stmt.declarations.map((d) => d.id.name).join(",")} needs it from server.js`); continue; }
    if (ref.isWrite()) { problems.push(`line ${id.loc.start.line}: assigns server binding ${nm}`); continue; }
    deps.add(nm);
    const parent = findParent(stmt, id);
    const shorthand = parent && parent.type === "Property" && parent.shorthand && parent.value === id;
    edits.push({ at: id.range[0] - start, len: id.range[1] - id.range[0], text: shorthand ? `${nm}: deps.${nm}` : `deps.${nm}` });
  }
  // A lazy import's path is relative to the file it is written in, and
  // nothing checks it until the line runs: searchAndPersistCdsRecord kept
  // "./cds-ingest-pipeline.js" after it moved on 2026-09-20 and the live CDS
  // search failed silently. The literal is rewritten like the static imports.
  for (const node of dynamicImportsIn(stmt)) {
    if (node.source.type !== "Literal" || typeof node.source.value !== "string") { problems.push(`line ${node.loc.start.line}: dynamic import of a computed path`); continue; }
    const raw = node.source.value;
    if (!raw.startsWith("./") && !raw.startsWith("../")) continue;
    const upLevels = "../".repeat(outRel.split("/").length - 1);
    edits.push({ at: node.source.range[0] + 1 - start, len: node.source.range[1] - node.source.range[0] - 2, text: raw.startsWith("./") ? upLevels + raw.slice(2) : upLevels + raw });
  }
  let text = src.slice(start, end);
  edits.sort((a, b) => b.at - a.at);
  for (const e of edits) text = text.slice(0, e.at) + e.text + text.slice(e.at + e.len);
  const at = stmt.range[0] - start;
  text = text.slice(0, at) + "export " + text.slice(at);
  pieces.push({ start, end, text });
}
// A local named `deps` inside a moved function would shadow the module's.
for (const scope of scopeManager.scopes) {
  if (scope === moduleScope || !inMoved(scope.block.range[0])) continue;
  if (scope.set.has("deps")) problems.push(`line ${scope.block.loc.start.line}: a local named deps`);
}
// What stays must not assign what moves.
for (const ref of moduleRefs) {
  if (movedNames.has(ref.identifier.name) && ref.isWrite() && !ref.init && !inMoved(ref.identifier.range[0])) problems.push(`line ${ref.identifier.loc.start.line}: server.js assigns ${ref.identifier.name}, which would move`);
}
if (problems.length) { console.error("refused:\n  " + [...new Set(problems)].join("\n  ")); process.exit(1); }

const depth = outRel.split("/").length - 1;
const up = "../".repeat(depth);
const bySource = new Map();
for (const [local, imp] of usedImports) {
  if (!bySource.has(imp.source)) bySource.set(imp.source, { default: null, namespace: null, named: [] });
  const g = bySource.get(imp.source);
  if (imp.kind === "default") g.default = local;
  else if (imp.kind === "namespace") g.namespace = local;
  else g.named.push(imp.imported === local ? local : `${imp.imported} as ${local}`);
}
const importLines = [];
for (const [rawSource, g] of bySource) {
  const source = rawSource.startsWith("./") ? up + rawSource.slice(2) : rawSource.startsWith("../") ? up + rawSource : rawSource;
  if (g.namespace) importLines.push(`import * as ${g.namespace} from "${source}";`);
  const parts = [];
  if (g.default) parts.push(g.default);
  if (g.named.length) parts.push(`{ ${g.named.sort().join(", ")} }`);
  if (parts.length) importLines.push(`import ${parts.join(", ")} from "${source}";`);
}
const header = (headerText ? headerText.split("\\n").map((l) => `// ${l}`.trimEnd()).join("\n") + "\n" : "") +
  `// \`deps\` is server.js's routeDeps object: live getters onto the bindings\n// these functions read there (${[...deps].sort().join(", ") || "none"}).\n`;
const wrapped = header.split("\n").flatMap((line) => {
  if (line.length <= 78 || !line.startsWith("// these functions")) return [line];
  const words = line.slice(3).split(" "); const rows = []; let row = "//";
  for (const w of words) { if ((row + " " + w).length > 78) { rows.push(row); row = "//"; } row += " " + w; }
  rows.push(row); return rows;
}).join("\n");
const moduleText = `${wrapped}${importLines.length ? importLines.join("\n") + "\n" : ""}\nlet deps;\nexport function ${bindName}(serverDeps) { deps = serverDeps; }\n\n${pieces.map((p) => p.text).join("\n\n")}\n`;

// server.js: the statements out; routeDeps regenerated with the new getters
// and, the first time, lifted to sit right under the imports; the bind call
// under it; the import of what server.js still names.
const routeDepsStmt = ast.body.find((n) => n.type === "VariableDeclaration" && n.declarations[0].id.name === "routeDeps");
if (!routeDepsStmt) throw new Error("routeDeps not found");
const getterNames = new Set(routeDepsStmt.declarations[0].init.properties.map((p) => p.key.name));
for (const d of deps) getterNames.add(d);
const depsText = "const routeDeps = {\n" + [...getterNames].sort().map((n) => `  get ${n}() { return ${n}; },`).join("\n") + "\n};";
const lastImport = ast.body.filter((n) => n.type === "ImportDeclaration").pop();
const lifted = ast.body[ast.body.indexOf(lastImport) + 1] === routeDepsStmt || src.slice(lastImport.range[1], routeDepsStmt.range[0]).includes("// ─── routeDeps ─");
const stillNamed = [...movedNames].filter((n) => moduleRefs.some((r) => r.identifier.name === n && !inMoved(r.identifier.range[0])));
const importText = `\nimport { ${[bindName, ...stillNamed].join(", ")} } from "./${outRel}";`;
const edits = pieces.map((p) => ({ at: p.start, end: p.end, text: "" }));
if (lifted) {
  edits.push({ at: routeDepsStmt.range[0], end: routeDepsStmt.range[1], text: depsText });
  // Bind calls follow the object; add this one after the last of them.
  let tail = routeDepsStmt.range[1];
  for (let i = ast.body.indexOf(routeDepsStmt) + 1; i < ast.body.length; i++) {
    const s = ast.body[i];
    if (s.type === "ExpressionStatement" && s.expression.type === "CallExpression" && /^bind[A-Z]/.test(s.expression.callee.name || "")) tail = s.range[1]; else break;
  }
  edits.push({ at: tail, end: tail, text: `\n${bindName}(routeDeps);` });
  edits.push({ at: lastImport.range[1], end: lastImport.range[1], text: importText });
} else {
  edits.push({ at: routeDepsStmt.range[0], end: routeDepsStmt.range[1], text: "// routeDeps itself is declared under the imports." });
  const block = `${importText}\n\n// ─── routeDeps ────────────────────────────────────────────────────────\n// Live getters onto this module's bindings, read by the route families\n// (routes/*.js) and by the helper modules (server/*.js) that moved out of\n// this file. A getter runs when it is read, so the object can sit above the\n// declarations it names: a binding is current at request time, and a read\n// before its declaration fails exactly as the direct reference did. The\n// bind calls come first of all because an imported helper, like the hoisted\n// function it replaces, may be called from any line below.\n${depsText}\n${bindName}(routeDeps);`;
  edits.push({ at: lastImport.range[1], end: lastImport.range[1], text: block });
}
edits.sort((a, b) => b.at - a.at || b.end - a.end);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
out = out.replace(/\n{4,}/g, "\n\n\n");

console.log(`${outRel}: ${moved.length} statements, ${moduleText.split("\n").length} lines, ${deps.size} deps (${[...deps].filter((d) => !routeDepsStmt.declarations[0].init.properties.some((p) => p.key.name === d)).length} new getters), ${importLines.length} imports`);
console.log(`server.js: ${src.split("\n").length} -> ${out.split("\n").length} lines`);
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, moduleText);
fs.writeFileSync(file, out);
