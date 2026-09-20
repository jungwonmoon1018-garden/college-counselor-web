#!/usr/bin/env node
// extract-callback.mjs --out handlers.js --names send,handleLogin [--apply]
//
// Moves the bodies of App()'s large `const name = useCallback(fn, deps)`
// handlers into a sibling module. The function travels verbatim as
// `export [async] function name(ctx, ...params)`, opening with one
// destructuring of `ctx`; App keeps the hook, its dependency array and the
// name, and the callback becomes `(...args) => nameImpl({ …bindings }, ...args)`.
// The object is built when the callback runs, from the same render's
// bindings the closure held, so what the body sees does not change.
// Refused: a body that assigns an App binding, reads one that is ever
// reassigned, contains JSX, or uses `this` / `arguments`.
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
const names = arg("--names", "").split(",").filter(Boolean);
const outName = arg("--out");
const headerText = arg("--header", "");
const file = path.join(F, "App.jsx");
const outFile = path.join(F, outName);
if (fs.existsSync(outFile)) throw new Error(`${outName} exists`);

const src = fs.readFileSync(file, "utf8");
if (src.includes("\r\n")) throw new Error("App.jsx is CRLF");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", range: true, loc: true, comment: true, ecmaFeatures: { jsx: true } });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
const appFn = ast.body.find((n) => n.type === "ExportDefaultDeclaration" && n.declaration.id?.name === "App").declaration;

const imports = new Map();
for (const node of ast.body) {
  if (node.type !== "ImportDeclaration") continue;
  for (const sp of node.specifiers) imports.set(sp.local.name, { source: node.source.value, sp });
}

function walk(n, fn) {
  if (!n || typeof n.type !== "string") return;
  if (fn(n) === false) return;
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "range" || key === "parent") continue;
    const v = n[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn)); else if (v && typeof v.type === "string") walk(v, fn);
  }
}

const usedImports = new Map();
const pieces = [];
const edits = [];
const problems = [];
for (const name of names) {
  const decl = appFn.body.body.find((s) => s.type === "VariableDeclaration" && s.declarations.length === 1 && s.declarations[0].id.name === name);
  const call = decl?.declarations[0].init;
  if (!call || call.type !== "CallExpression" || call.callee.name !== "useCallback") { problems.push(`${name}: not a useCallback in App()`); continue; }
  const fn = call.arguments[0];
  if (!["ArrowFunctionExpression", "FunctionExpression"].includes(fn.type) || fn.body.type !== "BlockStatement") { problems.push(`${name}: callback has no block body`); continue; }
  let bad = null;
  walk(fn.body, (n) => {
    if (n.type === "JSXElement" || n.type === "JSXFragment") bad = "contains JSX";
    if (n.type === "ThisExpression") bad = "uses this";
    if (n.type === "Identifier" && n.name === "arguments") bad = "uses arguments";
  });
  if (bad) { problems.push(`${name}: ${bad}`); continue; }

  // Every reference made inside the callback that resolves outside it.
  const ctx = new Set();
  const paramRefs = [];
  const inParams = (id) => fn.params.some((p) => id.range[0] >= p.range[0] && id.range[1] <= p.range[1]);
  for (const scope of scopeManager.scopes) {
    if (scope.block.range[0] < fn.range[0] || scope.block.range[1] > fn.range[1]) continue;
    for (const ref of scope.references) {
      const v = ref.resolved;
      if (!v) continue; // a global
      const [a, b] = v.scope.block.range;
      if (a >= fn.range[0] && b <= fn.range[1]) continue; // the callback's own
      if (v.scope === moduleScope && imports.has(v.name)) { usedImports.set(v.name, imports.get(v.name)); continue; }
      if (ref.isWrite()) problems.push(`${name}: assigns ${v.name}`);
      if (v.references.some((r) => r.isWrite() && !r.init)) problems.push(`${name}: reads ${v.name}, which is reassigned`);
      ctx.add(v.name);
      // A default parameter runs before the body's destructuring of ctx.
      if (inParams(ref.identifier)) paramRefs.push(ref.identifier);
    }
  }
  const ctxNames = [...ctx].sort();
  // The comments above the hook describe the body, so they travel with it
  // (a comment on the previous statement's own last line is that one's).
  const prev = appFn.body.body[appFn.body.body.indexOf(decl) - 1];
  const leading = ast.comments.filter((c) => c.range[1] <= decl.range[0] && c.range[0] >= prev.range[1] && c.loc.start.line !== prev.loc.end.line);
  if (leading.length) edits.push({ at: leading[0].range[0], end: decl.range[0], text: "" });
  const comment = leading.map((c) => src.slice(c.range[0], c.range[1])).join("\n");
  const params = fn.params.map((p) => {
    let text = src.slice(p.range[0], p.range[1]);
    for (const id of paramRefs.filter((r) => r.range[0] >= p.range[0] && r.range[1] <= p.range[1]).sort((x, y) => y.range[0] - x.range[0])) {
      text = text.slice(0, id.range[0] - p.range[0]) + "ctx." + id.name + text.slice(id.range[1] - p.range[0]);
    }
    return text;
  }).join(", ");
  const bodyText = src.slice(fn.body.range[0] + 1, fn.body.range[1] - 1);
  // The body sat two levels deep (App > useCallback); one level now.
  const dedented = bodyText.split("\n").map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n");
  const destructure = ctxNames.length ? `\n  const {\n${chunk(ctxNames, 6).map((row) => "    " + row.join(", ") + ",").join("\n")}\n  } = ctx;` : "";
  pieces.push(`${comment ? comment.split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n") + "\n" : ""}export ${fn.async ? "async " : ""}function ${name}(ctx${params ? ", " + params : ""}) {${destructure}${dedented.replace(/\s+$/, "")}\n}`);
  const callText = `(...args) => ${name}Impl({\n${chunk(ctxNames, 6).map((row) => "      " + row.join(", ") + ",").join("\n")}\n    }, ...args)`;
  edits.push({ at: fn.range[0], end: fn.range[1], text: callText });
  console.log(`${name}: ${fn.loc.end.line - fn.loc.start.line + 1} lines, ${ctxNames.length} bindings through ctx`);
}
function chunk(list, size) { const rows = []; for (let i = 0; i < list.length; i += size) rows.push(list.slice(i, i + size)); return rows; }

if (problems.length) { console.error("refused:\n  " + [...new Set(problems)].join("\n  ")); process.exit(1); }

const groups = new Map();
for (const [local, { source, sp }] of usedImports) {
  if (!groups.has(source)) groups.set(source, { def: null, ns: null, named: [] });
  const g = groups.get(source);
  if (sp.type === "ImportDefaultSpecifier") g.def = local;
  else if (sp.type === "ImportNamespaceSpecifier") g.ns = local;
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
const moduleText = `${header}${importLines.join("\n")}${importLines.length ? "\n\n" : ""}${pieces.join("\n\n")}\n`;

let out = src;
const lastImport = ast.body.filter((n) => n.type === "ImportDeclaration").pop();
edits.push({ at: lastImport.range[1], end: lastImport.range[1], text: `\nimport { ${names.map((n) => `${n} as ${n}Impl`).join(", ")} } from "./${outName}";` });
edits.sort((a, b) => b.at - a.at);
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
console.log(`App.jsx ${src.split("\n").length} -> ${out.split("\n").length} lines; ${outName} ${moduleText.split("\n").length} lines`);
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }
fs.writeFileSync(outFile, moduleText);
fs.writeFileSync(file, out);
