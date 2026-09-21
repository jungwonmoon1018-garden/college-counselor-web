#!/usr/bin/env node
// wrap-statements.mjs --out server/jobs.js --name registerServerJobs --from L1 --to L2 [--header "…"] [--append] [--apply]
//
// Moves a contiguous run of server.js's top-level STATEMENTS (timers, job
// registration, a mount block — code that runs once at boot) into
// `export function <name>(deps) { … }` in a server/ module and leaves
// `<name>(routeDeps);` exactly where the run was, so what runs when does not
// change. Inside the run a reference to an import is re-imported and a
// reference to any other server.js binding becomes `deps.<name>` (routeDeps
// gains the getters it lacks). The text is indented one level, except lines
// that begin inside a multi-line template literal, whose content must not
// change. Refused: a run that declares something used outside it (move a
// function with extract-helpers.mjs instead), assigns a server binding, has
// a top-level await, or holds an import/export.
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
const append = args.includes("--append");
const outRel = arg("--out"); const fnName = arg("--name");
const from = Number(arg("--from")); const to = Number(arg("--to"));
const headerText = arg("--header", "");

const file = path.join(B, "server.js");
const outFile = path.join(B, outRel);
if (fs.existsSync(outFile) && !append) throw new Error(`${outRel} exists (pass --append to add to it)`);
const src = fs.readFileSync(file, "utf8");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", loc: true, range: true, comment: true });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");

const picked = ast.body.filter((s) => s.loc.start.line >= from && s.loc.end.line <= to);
if (!picked.length) throw new Error("no whole statements in that range");
const first = ast.body.indexOf(picked[0]); const last = ast.body.indexOf(picked[picked.length - 1]);
if (last - first + 1 !== picked.length) throw new Error("not a contiguous run");
const prev = ast.body[first - 1];
const leading = ast.comments.filter((c) => c.range[0] >= (prev ? prev.range[1] : 0) && c.range[1] <= picked[0].range[0] && !(prev && c.loc.start.line === prev.loc.end.line) && c.loc.start.line >= from);
const start = leading.length ? leading[0].range[0] : picked[0].range[0];
const end = picked[picked.length - 1].range[1];
const inRun = (pos) => pos >= picked[0].range[0] && pos < end;

const imports = new Map();
for (const node of ast.body) {
  if (node.type !== "ImportDeclaration") continue;
  for (const sp of node.specifiers) {
    const kind = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportNamespaceSpecifier" ? "namespace" : "named";
    imports.set(sp.local.name, { source: node.source.value, kind, imported: kind === "named" ? sp.imported.name : null });
  }
}

const problems = [];
for (const s of picked) if (/^(Import|Export)/.test(s.type)) problems.push(`line ${s.loc.start.line}: ${s.type} cannot be wrapped`);
function walk(n, fn, inFunction = false) {
  if (!n || typeof n.type !== "string") return;
  fn(n, inFunction);
  const nested = inFunction || /Function/.test(n.type);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "range") continue;
    const v = n[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, nested)); else if (v && typeof v.type === "string") walk(v, fn, nested);
  }
}
const templates = [];
for (const s of picked) walk(s, (n, inFunction) => {
  if (n.type === "AwaitExpression" && !inFunction) problems.push(`line ${n.loc.start.line}: top-level await`);
  if (n.type === "TemplateLiteral" && n.loc.end.line > n.loc.start.line) templates.push([n.loc.start.line, n.loc.end.line]);
});

// What the run declares at module level must not be needed outside it.
for (const v of moduleScope.variables) {
  const def = v.defs[0];
  if (!def || def.type === "ImportBinding" || !inRun(def.name.range[0])) continue;
  if (v.references.some((r) => !inRun(r.identifier.range[0]))) problems.push(`${v.name} is declared in the run and used outside it`);
}
function findParent(root, target) {
  let found = null;
  const visit = (n, parent) => {
    if (found || !n || typeof n.type !== "string") return;
    if (n === target) { found = parent; return; }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "range") continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && visit(c, n)); else if (v && typeof v.type === "string") visit(v, n);
    }
  };
  visit(root, null);
  return found;
}
const usedImports = new Map(); const deps = new Set(); const edits = [];
for (const scope of scopeManager.scopes) {
  for (const ref of scope.references) {
    const id = ref.identifier;
    if (!ref.resolved || ref.resolved.scope !== moduleScope || !inRun(id.range[0])) continue;
    const def = ref.resolved.defs[0];
    if (def && def.type !== "ImportBinding" && inRun(def.name.range[0])) continue; // the run's own
    if (imports.has(id.name)) { usedImports.set(id.name, imports.get(id.name)); continue; }
    if (ref.isWrite()) { problems.push(`line ${id.loc.start.line}: assigns server binding ${id.name}`); continue; }
    deps.add(id.name);
    const owner = picked.find((s) => id.range[0] >= s.range[0] && id.range[1] <= s.range[1]);
    const parent = findParent(owner, id);
    const shorthand = parent && parent.type === "Property" && parent.shorthand && parent.value === id;
    edits.push({ at: id.range[0] - start, len: id.range[1] - id.range[0], text: shorthand ? `${id.name}: deps.${id.name}` : `deps.${id.name}` });
  }
}
for (const scope of scopeManager.scopes) {
  if (scope === moduleScope || !inRun(scope.block.range[0])) continue;
  if (scope.set.has("deps")) problems.push(`line ${scope.block.loc.start.line}: a local named deps`);
}
// A dynamic import's path is relative to the file it is written in.
const relativeTo = (rawSource) => {
  if (!rawSource.startsWith(".")) return rawSource;
  const next = path.posix.relative(path.posix.dirname(outRel), path.posix.normalize(rawSource));
  return next.startsWith(".") ? next : "./" + next;
};
for (const s of picked) walk(s, (n) => {
  if (n.type !== "ImportExpression") return;
  if (n.source.type !== "Literal" || typeof n.source.value !== "string") { problems.push(`line ${n.loc.start.line}: dynamic import of a computed path`); return; }
  if (n.source.value.startsWith(".")) edits.push({ at: n.source.range[0] + 1 - start, len: n.source.range[1] - n.source.range[0] - 2, text: relativeTo(n.source.value) });
});
if (problems.length) { console.error("refused:\n  " + [...new Set(problems)].join("\n  ")); process.exit(1); }

let text = src.slice(start, end);
const seen = new Set();
for (const e of edits.sort((a, b) => b.at - a.at)) {
  if (seen.has(e.at)) continue; seen.add(e.at);
  text = text.slice(0, e.at) + e.text + text.slice(e.at + e.len);
}
// Indent one level, leaving alone every line that begins inside a template literal.
const firstLine = src.slice(0, start).split("\n").length;
const inTemplate = (line) => templates.some(([a, b]) => line > a && line <= b);
text = text.split("\n").map((l, i) => (l.trim() && !inTemplate(firstLine + i) ? "  " + l : l)).join("\n");

const bySource = new Map();
for (const [local, imp] of usedImports) {
  if (!bySource.has(imp.source)) bySource.set(imp.source, { default: null, namespace: null, named: [] });
  const g = bySource.get(imp.source);
  if (imp.kind === "default") g.default = local; else if (imp.kind === "namespace") g.namespace = local;
  else g.named.push(imp.imported === local ? local : `${imp.imported} as ${local}`);
}
const importLines = [];
for (const [rawSource, g] of bySource) {
  let source = rawSource;
  if (rawSource.startsWith(".")) {
    source = path.posix.relative(path.posix.dirname(outRel), path.posix.normalize(rawSource));
    if (!source.startsWith(".")) source = "./" + source;
  }
  if (g.namespace) importLines.push(`import * as ${g.namespace} from "${source}";`);
  const parts = [];
  if (g.default) parts.push(g.default);
  if (g.named.length) parts.push(`{ ${g.named.sort().join(", ")} }`);
  if (parts.length) importLines.push(`import ${parts.join(", ")} from "${source}";`);
}
const header = headerText ? headerText.split("\\n").map((l) => `// ${l}`.trimEnd()).join("\n") + "\n" : "";
const fnText = `export function ${fnName}(deps) {\n${text}\n}\n`;
let moduleText;
if (append && fs.existsSync(outFile)) {
  // Merge the imports per source: a second `import { x } from "./a.js"` beside
  // an existing one that already names x is a redeclaration, not a no-op.
  const existing = fs.readFileSync(outFile, "utf8");
  const existingAst = espree.parse(existing, { ecmaVersion: 2024, sourceType: "module", range: true });
  const merged = new Map();
  const note = (source, kind, text) => {
    if (!merged.has(source)) merged.set(source, { default: null, namespace: null, named: new Set() });
    const g = merged.get(source);
    if (kind === "default") g.default = text; else if (kind === "namespace") g.namespace = text; else g.named.add(text);
  };
  const importNodes = existingAst.body.filter((n) => n.type === "ImportDeclaration");
  for (const n of importNodes) for (const sp of n.specifiers) {
    if (sp.type === "ImportDefaultSpecifier") note(n.source.value, "default", sp.local.name);
    else if (sp.type === "ImportNamespaceSpecifier") note(n.source.value, "namespace", sp.local.name);
    else note(n.source.value, "named", sp.imported.name === sp.local.name ? sp.local.name : `${sp.imported.name} as ${sp.local.name}`);
  }
  for (const [rawSource, g] of bySource) {
    const source = relativeTo(rawSource);
    if (g.default) note(source, "default", g.default);
    if (g.namespace) note(source, "namespace", g.namespace);
    g.named.forEach((nm) => note(source, "named", nm));
  }
  const mergedLines = [];
  for (const [source, g] of merged) {
    if (g.namespace) mergedLines.push(`import * as ${g.namespace} from "${source}";`);
    const parts = [];
    if (g.default) parts.push(g.default);
    if (g.named.size) parts.push(`{ ${[...g.named].sort().join(", ")} }`);
    if (parts.length) mergedLines.push(`import ${parts.join(", ")} from "${source}";`);
  }
  const head = importNodes.length ? existing.slice(0, importNodes[0].range[0]) : "";
  const tail = importNodes.length ? existing.slice(importNodes[importNodes.length - 1].range[1]) : existing;
  moduleText = (head + mergedLines.join("\n") + tail).replace(/\n*$/, "\n") + "\n" + (header ? header : "") + fnText;
} else {
  moduleText = `${header}// \`deps\` is server.js's routeDeps object of live getters.\n${importLines.length ? importLines.join("\n") + "\n" : ""}\n${fnText}`;
}

// server.js: the run becomes one call; routeDeps gains the getters it lacks.
const routeDepsStmt = ast.body.find((n) => n.type === "VariableDeclaration" && n.declarations[0].id.name === "routeDeps");
const getterNames = new Set(routeDepsStmt.declarations[0].init.properties.map((p) => p.key.name));
const newGetters = [...deps].filter((d) => !getterNames.has(d));
for (const d of deps) getterNames.add(d);
const depsText = "const routeDeps = {\n" + [...getterNames].sort().map((n) => `  get ${n}() { return ${n}; },`).join("\n") + "\n};";
const lastImportNode = ast.body.filter((n) => n.type === "ImportDeclaration").pop();
const out = [
  { at: start, end, text: `${fnName}(routeDeps);` },
  { at: routeDepsStmt.range[0], end: routeDepsStmt.range[1], text: depsText },
  { at: lastImportNode.range[1], end: lastImportNode.range[1], text: `\nimport { ${fnName} } from "./${outRel}";` },
].sort((a, b) => b.at - a.at).reduce((s, e) => s.slice(0, e.at) + e.text + s.slice(e.end), src);

console.log(`${outRel}: ${fnName}() wraps ${picked.length} statements (lines ${picked[0].loc.start.line}-${picked[picked.length - 1].loc.end.line}), ${deps.size} deps (${newGetters.length} new getters${newGetters.length ? ": " + newGetters.join(", ") : ""}), ${importLines.length} imports`);
console.log(`server.js: ${src.split("\n").length} -> ${out.split("\n").length} lines`);
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, moduleText);
fs.writeFileSync(file, out);
