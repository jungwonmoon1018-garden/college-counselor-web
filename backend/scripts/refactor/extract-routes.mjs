// Move route families out of server.js into routes/<family>.js.
// Each family becomes `export function register<Family>Routes(app, deps)`
// holding the route statements verbatim, with every reference to a
// server.js binding rewritten to `deps.<name>` (resolved by eslint-scope,
// so shadowed names and property keys are untouched) and every reference
// to an import re-imported by the new module. server.js loses the
// statements and gains, before its /api/health route, one `routeDeps`
// object of getters (live values, no TDZ) and the register calls.
// Usage: node extract-routes.mjs [--apply] [family ...]   (family: api/consent)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const eslintScope = require("eslint-scope");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const wanted = args.filter((a) => !a.startsWith("--")).map((f) => (f.startsWith("/") ? f : "/" + f));

const file = `${B}/server.js`;
const src = fs.readFileSync(file, "utf8");
if (src.includes("\r\n")) throw new Error("server.js is CRLF");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", loc: true, range: true, comment: true });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");

// Import bindings: local name -> { source, kind, imported }.
const imports = new Map();
for (const node of ast.body) {
  if (node.type !== "ImportDeclaration") continue;
  for (const sp of node.specifiers) {
    const kind = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportNamespaceSpecifier" ? "namespace" : "named";
    imports.set(sp.local.name, { source: node.source.value, kind, imported: kind === "named" ? sp.imported.name : null });
  }
}

function routeOf(stmt) {
  if (stmt.type !== "ExpressionStatement") return null;
  const e = stmt.expression;
  if (e.type !== "CallExpression" || e.callee.type !== "MemberExpression") return null;
  if (e.callee.object.type !== "Identifier" || e.callee.object.name !== "app") return null;
  const verb = e.callee.property.name;
  if (!["get", "post", "put", "delete", "patch"].includes(verb)) return null;
  const first = e.arguments[0];
  return first && first.type === "Literal" && typeof first.value === "string" ? { verb, path: first.value } : null;
}

// Route statements by family, with the comments that sit right above each
// (between the previous top-level statement and the route).
const families = new Map();
for (let i = 0; i < ast.body.length; i++) {
  const stmt = ast.body[i];
  const r = routeOf(stmt);
  if (!r) continue;
  const fam = "/" + r.path.split("/").slice(1, 3).join("/");
  if (fam === "/api/health") continue;
  const prevEnd = i > 0 ? ast.body[i - 1].range[1] : 0;
  const leading = ast.comments.filter((c) => c.range[0] >= prevEnd && c.range[1] <= stmt.range[0]);
  const start = leading.length ? Math.min(stmt.range[0], leading[0].range[0]) : stmt.range[0];
  if (!families.has(fam)) families.set(fam, []);
  families.get(fam).push({ stmt, start, end: stmt.range[1], path: r.path });
}

// Module-scope references inside a range: identifier nodes to rewrite.
function referencesIn(range) {
  const refs = [];
  for (const scope of scopeManager.scopes) {
    if (scope.block.range[0] < range[0] || scope.block.range[1] > range[1]) continue;
    for (const ref of scope.references) {
      if (ref.resolved && ref.resolved.scope === moduleScope) refs.push(ref);
    }
  }
  // The module scope itself holds the references made directly in the
  // route call expression (the `app` object, top-level arguments).
  for (const ref of moduleScope.references) {
    if (ref.identifier.range[0] >= range[0] && ref.identifier.range[1] <= range[1] && ref.resolved && ref.resolved.scope === moduleScope) refs.push(ref);
  }
  const seen = new Set();
  return refs.filter((r) => { const k = r.identifier.range[0]; if (seen.has(k)) return false; seen.add(k); return true; });
}

function toCamel(fam) {
  return fam.replace(/^\/api\//, "").split(/[^a-z0-9]+/i).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

const allDeps = new Set();
const modules = [];
const removals = [];
const registerCalls = [];
for (const [fam, routes] of families) {
  if (wanted.length && !wanted.includes(fam)) continue;
  const name = toCamel(fam);
  const fileName = fam.replace(/^\/api\//, "") + ".js";
  const usedImports = new Map();
  const deps = new Set();
  const pieces = [];
  for (const route of routes) {
    const range = [route.start, route.end];
    let text = src.slice(range[0], range[1]);
    const edits = [];
    for (const ref of referencesIn([route.stmt.range[0], route.stmt.range[1]])) {
      const id = ref.identifier;
      const nm = id.name;
      if (nm === "app") continue;
      if (imports.has(nm)) { usedImports.set(nm, imports.get(nm)); continue; }
      if (ref.isWrite()) throw new Error(`${fam}: route assigns module binding ${nm}`);
      deps.add(nm);
      allDeps.add(nm);
      // Shorthand property `{ stmts }` must become `{ stmts: deps.stmts }`.
      const parent = findParent(route.stmt, id);
      const shorthand = parent && parent.type === "Property" && parent.shorthand && parent.value === id;
      edits.push({ at: id.range[0] - range[0], len: id.range[1] - id.range[0], text: shorthand ? `${nm}: deps.${nm}` : `deps.${nm}` });
    }
    edits.sort((a, b) => b.at - a.at);
    for (const e of edits) text = text.slice(0, e.at) + e.text + text.slice(e.at + e.len);
    pieces.push(text.split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n"));
    removals.push({ start: route.start, end: route.end });
  }
  const importLines = [];
  const bySource = new Map();
  for (const [local, imp] of usedImports) {
    if (!bySource.has(imp.source)) bySource.set(imp.source, { default: null, namespace: null, named: [] });
    const g = bySource.get(imp.source);
    if (imp.kind === "default") g.default = local;
    else if (imp.kind === "namespace") g.namespace = local;
    else g.named.push(imp.imported === local ? local : `${imp.imported} as ${local}`);
  }
  for (const [rawSource, g] of bySource) {
    // The module sits one level down from server.js.
    const source = rawSource.startsWith("./") ? "../" + rawSource.slice(2) : rawSource.startsWith("../") ? "../" + rawSource : rawSource;
    if (g.namespace) importLines.push(`import * as ${g.namespace} from "${source}";`);
    const parts = [];
    if (g.default) parts.push(g.default);
    if (g.named.length) parts.push(`{ ${g.named.sort().join(", ")} }`);
    if (parts.length) importLines.push(`import ${parts.join(", ")} from "${source}";`);
  }
  const header = `// routes/${fileName} — the ${fam} routes, moved out of server.js on\n// 2026-09-16 so the server file holds setup and helpers only. \`deps\` is\n// the server's routeDeps object: live getters onto the module bindings\n// these handlers use (${[...deps].sort().join(", ") || "none"}).\n`;
  const body = `${header}${importLines.length ? importLines.join("\n") + "\n" : ""}\nexport function register${name}Routes(app, deps) {\n${pieces.join("\n\n")}\n}\n`;
  modules.push({ fam, name, fileName, body, routes: routes.length, deps: [...deps].sort() });
  registerCalls.push(`register${name}Routes(app, routeDeps);`);
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

for (const m of modules) console.log(`${m.fam} -> routes/${m.fileName}: ${m.routes} routes, ${m.deps.length} deps`);
console.log("routeDeps size:", allDeps.size);
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }

// Write the modules.
fs.mkdirSync(`${B}/routes`, { recursive: true });
for (const m of modules) fs.writeFileSync(`${B}/routes/${m.fileName}`, m.body);

// Rewrite server.js: remove the statements (back to front), add imports and
// the routeDeps + register block before the health route.
let out = src;
const healthStmt = ast.body.find((s) => { const r = routeOf(s); return r && r.path === "/api/health"; });
if (!healthStmt) throw new Error("health route not found");
const healthLeading = ast.comments.filter((c) => c.range[1] <= healthStmt.range[0] && c.range[0] >= ast.body[ast.body.indexOf(healthStmt) - 1].range[1]);
const insertAt = healthLeading.length ? healthLeading[0].range[0] : healthStmt.range[0];
const depsLines = [...allDeps].sort().map((n) => `  get ${n}() { return ${n}; },`);
const block =
  "// ─── Route families (routes/*.js) ─────────────────────────────────────\n" +
  "// The handlers moved out of this file on 2026-09-16 read the server's\n" +
  "// bindings through live getters, so a binding declared or reassigned\n" +
  "// later (the catalog scout's list, the pillar auth) is current at request\n" +
  "// time. Registration order among a family's routes is unchanged; the\n" +
  "// families register here, after every route that stayed and before the\n" +
  "// health route, the pillar mount, the static files and the error handler.\n" +
  "const routeDeps = {\n" + depsLines.join("\n") + "\n};\n" +
  registerCalls.join("\n") + "\n\n";
const edits = [...removals.map((r) => ({ at: r.start, end: r.end, text: "" })), { at: insertAt, end: insertAt, text: block }].sort((a, b) => b.at - a.at);
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
// Collapse the runs of blank lines the removals leave behind.
out = out.replace(/\n{4,}/g, "\n\n\n");
const lastImport = ast.body.filter((n) => n.type === "ImportDeclaration").pop();
const importText = modules.map((m) => `import { register${m.name}Routes } from "./routes/${m.fileName}";`).join("\n") + "\n";
out = out.slice(0, lastImport.range[1] + 1) + importText + out.slice(lastImport.range[1] + 1);
fs.writeFileSync(file, out);
console.log("server.js rewritten:", src.split("\n").length, "->", out.split("\n").length, "lines");
