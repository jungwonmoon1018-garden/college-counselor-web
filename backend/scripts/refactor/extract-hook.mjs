#!/usr/bin/env node
// extract-hook.mjs --name useChatThreads (--from L1 --to L2 | --first binding --last binding) [--header "…"] [--apply]
//
// Moves a CONTIGUOUS run of App()'s top-level statements (state, refs,
// effects, callbacks) into `export function useX(ctx)` in src/hooks/useX.js
// and leaves `const { …outputs } = useX({ …inputs });` exactly where the run
// was. Because the run stays in place, every hook still runs in the same
// order — in particular every useEffect — which is what keeps behaviour
// identical; the tool re-derives the effect sequence afterwards and fails
// if it changed. The statements travel verbatim (App()'s body and a hook's
// body have the same indentation). Inputs are the App() and module bindings
// the run reads; outputs are the bindings it declares that anything outside
// it reads. Refused: a run that reads an App() binding declared AFTER it
// (the ctx object is built at the call, so that would be a temporal-dead-zone
// error, where the original closure only read it later), assigns a binding
// it does not own, or contains JSX or a return.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const F = path.resolve(B, "..", "frontend", "src");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const eslintScope = require("eslint-scope");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const apply = args.includes("--apply");
const name = arg("--name"); let from = Number(arg("--from")); let to = Number(arg("--to"));
const firstName = arg("--first"); const lastName = arg("--last");
const headerText = arg("--header", "");
if (!/^use[A-Z]/.test(name || "")) throw new Error("--name must be a hook name (useSomething)");
const file = path.join(F, "App.jsx");
const outFile = path.join(F, "hooks", `${name}.js`);
if (fs.existsSync(outFile)) throw new Error(`hooks/${name}.js exists`);

const parseOpts = { ecmaVersion: 2024, sourceType: "module", range: true, loc: true, comment: true, ecmaFeatures: { jsx: true } };
const src = fs.readFileSync(file, "utf8");
if (src.includes("\r\n")) throw new Error("App.jsx is CRLF");
const ast = espree.parse(src, parseOpts);
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
const appFn = ast.body.find((n) => n.type === "ExportDefaultDeclaration" && n.declaration.id?.name === "App").declaration;
const appScope = scopeManager.acquire(appFn);
const body = appFn.body.body;

// --first/--last name the bindings whose declarations open and close the run,
// so a caller does not have to chase line numbers between moves.
if (firstName || lastName) {
  const stmtOf = (n) => { const v = appScope.set.get(n); if (!v || !v.defs[0]) throw new Error(`no App() binding ${n}`); return body.find((s) => s.range[0] <= v.defs[0].name.range[0] && v.defs[0].name.range[1] <= s.range[1]); };
  const a0 = stmtOf(firstName); const b0 = stmtOf(lastName || firstName);
  to = b0.loc.end.line; from = a0.loc.start.line;
  // The comment block directly above the first statement belongs to it.
  const before = body[body.indexOf(a0) - 1];
  const above = ast.comments.filter((cm) => cm.range[1] <= a0.range[0] && cm.range[0] >= (before ? before.range[1] : appFn.body.range[0] + 1) && !(before && cm.loc.start.line === before.loc.end.line));
  let top = a0.range[0];
  for (let i = above.length - 1; i >= 0; i--) { if (/\n\s*\n/.test(src.slice(above[i].range[1], top))) break; top = above[i].range[0]; from = above[i].loc.start.line; }
}
const picked = body.filter((s) => s.loc.start.line >= from && s.loc.end.line <= to);
if (!picked.length) throw new Error("no whole statements in that range");
const first = body.indexOf(picked[0]); const last = body.indexOf(picked[picked.length - 1]);
if (last - first + 1 !== picked.length) throw new Error("not a contiguous run");
const prev = body[first - 1];
const leading = ast.comments.filter((c) => c.range[0] >= (prev ? prev.range[1] : appFn.body.range[0] + 1) && c.range[1] <= picked[0].range[0] && !(prev && c.loc.start.line === prev.loc.end.line) && c.loc.start.line >= from);
const lineStart = (pos) => src.lastIndexOf("\n", pos - 1) + 1;
const start = lineStart(leading.length ? leading[0].range[0] : picked[0].range[0]);
let end = picked[picked.length - 1].range[1];
const next = body[last + 1];
const trailing = ast.comments.filter((c) => c.range[0] >= end && c.loc.start.line === picked[picked.length - 1].loc.end.line && (!next || c.range[1] <= next.range[0]));
if (trailing.length) end = trailing[trailing.length - 1].range[1];
const inRun = (pos) => pos >= picked[0].range[0] && pos < picked[picked.length - 1].range[1];

function walk(n, fn) {
  if (!n || typeof n.type !== "string") return;
  fn(n);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "range") continue;
    const v = n[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn)); else if (v && typeof v.type === "string") walk(v, fn);
  }
}
const problems = [];
for (const s of picked) {
  if (s.type === "ReturnStatement") problems.push(`line ${s.loc.start.line}: a return`);
  walk(s, (n) => { if (n.type === "JSXElement" || n.type === "JSXFragment") problems.push(`line ${n.loc.start.line}: JSX`); });
}

const imports = new Map();
for (const node of ast.body) if (node.type === "ImportDeclaration") for (const sp of node.specifiers) imports.set(sp.local.name, { node, sp });

const inputs = new Set(); const usedImports = new Map();
for (const scope of scopeManager.scopes) {
  for (const ref of scope.references) {
    const id = ref.identifier;
    if (!inRun(id.range[0]) || !ref.resolved) continue;
    const v = ref.resolved;
    const def = v.defs[0];
    const declaredInRun = def && def.type !== "ImportBinding" && inRun(def.name.range[0]);
    if (declaredInRun) continue;
    if (v.scope === moduleScope && imports.has(v.name)) { usedImports.set(v.name, imports.get(v.name)); continue; }
    if (v.scope !== moduleScope && v.scope !== appScope) continue; // a local of something inside the run… cannot be: it would be declared in the run
    if (ref.isWrite()) problems.push(`line ${id.loc.start.line}: assigns ${v.name}, which the run does not own`);
    if (v.scope === appScope && def && def.name.range[0] > picked[picked.length - 1].range[1]) problems.push(`line ${id.loc.start.line}: reads ${v.name}, declared after the run (line ${def.name.loc.start.line})`);
    inputs.add(v.name);
  }
}
const outputs = [];
for (const v of appScope.variables) {
  const def = v.defs[0];
  if (!def || !inRun(def.name.range[0])) continue;
  const outside = v.references.filter((r) => !inRun(r.identifier.range[0]));
  if (outside.some((r) => r.isWrite() && !r.init)) problems.push(`${v.name} is assigned outside the run`);
  if (outside.length) outputs.push(v.name);
}
// JSX element names are not references for eslint-scope; App()'s JSX may name nothing from a hook, but check.
if (problems.length) { console.error("refused:\n  " + [...new Set(problems)].join("\n  ")); process.exit(1); }

const chunk = (list, size, pad) => { const rows = []; for (let i = 0; i < list.length; i += size) rows.push(pad + list.slice(i, i + size).join(", ") + ","); return rows.join("\n"); };
const inputNames = [...inputs].sort(); const outputNames = outputs.sort();
const groups = new Map();
for (const [local, { node, sp }] of usedImports) {
  let source = node.source.value;
  if (source.startsWith(".")) { source = path.posix.relative("hooks", path.posix.normalize(source)); if (!source.startsWith(".")) source = "./" + source; }
  if (!groups.has(source)) groups.set(source, { def: null, ns: null, named: [] });
  const g = groups.get(source);
  if (sp.type === "ImportDefaultSpecifier") g.def = local; else if (sp.type === "ImportNamespaceSpecifier") g.ns = local;
  else g.named.push(sp.imported.name === local ? local : `${sp.imported.name} as ${local}`);
}
const importLines = [];
for (const [source, g] of groups) {
  if (g.ns) importLines.push(`import * as ${g.ns} from "${source}";`);
  const parts = [];
  if (g.def) parts.push(g.def);
  if (g.named.length) parts.push(`{ ${g.named.join(", ")} }`);
  if (parts.length) importLines.push(`import ${parts.join(", ")} from "${source}";`);
}
const header = headerText ? headerText.split("\\n").map((l) => `// ${l}`.trimEnd()).join("\n") + "\n" : "";
const runText = src.slice(start, end).replace(/\s+$/, "");
const destructure = inputNames.length ? `  const {\n${chunk(inputNames, 6, "    ")}\n  } = ctx;\n` : "";
const hookText = `${header}${importLines.join("\n")}${importLines.length ? "\n\n" : ""}export function ${name}(${inputNames.length ? "ctx" : ""}) {\n${destructure}${runText}\n  return {\n${chunk(outputNames, 6, "    ")}\n  };\n}\n`;
const callText = `  const {\n${chunk(outputNames, 6, "    ")}\n  } = ${name}(${inputNames.length ? `{\n${chunk(inputNames, 6, "    ")}\n  }` : ""});`;
const lastImport = ast.body.filter((n) => n.type === "ImportDeclaration").pop();
let out = src.slice(0, start) + callText + src.slice(end);
out = out.slice(0, lastImport.range[1]) + `\nimport { ${name} } from "./hooks/${name}.js";` + out.slice(lastImport.range[1]);

// The effect sequence, before and after: effects of App() in order, a hook
// call standing for the effects of that hook's file.
function effectsOf(fnNode, source, resolveHook) {
  const list = [];
  for (const stmt of fnNode.body.body) {
    walk(stmt, (n) => {
      if (n.type !== "CallExpression" || n.callee.type !== "Identifier") return;
      if (/^use(Layout)?Effect$/.test(n.callee.name)) list.push(source.slice(n.range[0], n.range[1]).replace(/\s+/g, " "));
      else if (/^use[A-Z]/.test(n.callee.name)) list.push(...resolveHook(n.callee.name));
    });
  }
  return list;
}
const hookEffects = (hookName, overrideText) => {
  const p = path.join(F, "hooks", `${hookName}.js`);
  const text = overrideText ?? (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  if (!text) return [];
  const a = espree.parse(text, parseOpts);
  const fn = a.body.map((n) => (n.type === "ExportNamedDeclaration" ? n.declaration : n)).find((n) => n && n.type === "FunctionDeclaration" && n.id.name === hookName);
  return fn ? effectsOf(fn, text, (h) => hookEffects(h)) : [];
};
const before = effectsOf(appFn, src, (h) => hookEffects(h));
const outAst = espree.parse(out, parseOpts);
const outApp = outAst.body.find((n) => n.type === "ExportDefaultDeclaration").declaration;
const after = effectsOf(outApp, out, (h) => (h === name ? hookEffects(h, hookText) : hookEffects(h)));
if (JSON.stringify(before) !== JSON.stringify(after)) { console.error(`refused: the effect sequence changed (${before.length} before, ${after.length} after)`); process.exit(1); }

console.log(`hooks/${name}.js: ${picked.length} statements (lines ${picked[0].loc.start.line}-${picked[picked.length - 1].loc.end.line}), ${inputNames.length} inputs, ${outputNames.length} outputs, ${importLines.length} imports, ${after.length} effects in the same order`);
console.log(`App.jsx: ${src.split("\n").length} -> ${out.split("\n").length} lines`);
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, hookText);
fs.writeFileSync(file, out);
