// Analyse server.js route families: for each `app.<verb>("/api/<family>…")`
// statement, the module-scope bindings it uses, whether it assigns any,
// and where it sits — so a family can be moved into routes/<family>.js as
// `registerXRoutes(app, deps)` with a destructured deps object.
// Usage: node route-families.mjs [/api/prefix ...]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const eslintScope = require("eslint-scope");
const file = path.join(B, "server.js");
const src = fs.readFileSync(file, "utf8");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", loc: true, range: true });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
const moduleNames = new Set(moduleScope.variables.map((v) => v.name));

function routeOf(stmt) {
  if (stmt.type !== "ExpressionStatement") return null;
  const e = stmt.expression;
  if (e.type !== "CallExpression" || e.callee.type !== "MemberExpression") return null;
  if (e.callee.object.type !== "Identifier" || e.callee.object.name !== "app") return null;
  const verb = e.callee.property.name;
  if (!["get", "post", "put", "delete", "patch", "use"].includes(verb)) return null;
  const first = e.arguments[0];
  const path = first && first.type === "Literal" && typeof first.value === "string" ? first.value : null;
  return { verb, path };
}

// Free references inside a node that resolve to module-scope bindings.
function moduleRefs(node) {
  const used = new Set();
  const assigned = new Set();
  const walk = (n, parent) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Identifier" && moduleNames.has(n.name)) {
      const isProp = parent && parent.type === "MemberExpression" && parent.property === n && !parent.computed;
      const isKey = parent && parent.type === "Property" && parent.key === n && !parent.computed && !parent.shorthand;
      if (!isProp && !isKey) used.add(n.name);
      if (parent && parent.type === "AssignmentExpression" && parent.left === n) assigned.add(n.name);
      if (parent && parent.type === "UpdateExpression" && parent.argument === n) assigned.add(n.name);
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "range" || key === "parent") continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c, n));
      else if (v && typeof v.type === "string") walk(v, n);
    }
  };
  walk(node, null);
  return { used, assigned };
}

// Note: a reference to a module name that is shadowed by a local binding
// inside the route (e.g. a parameter named `db`) would be over-reported;
// the scope manager settles it below.
function resolvesToModule(node) {
  const names = new Set();
  const scopes = scopeManager.scopes.filter((s) => s.block.range[0] >= node.range[0] && s.block.range[1] <= node.range[1]);
  for (const scope of scopes) {
    for (const ref of scope.references) {
      const resolved = ref.resolved;
      if (resolved && resolved.scope === moduleScope) names.add(resolved.name);
    }
    for (const t of scope.through) {
      if (t.resolved && t.resolved.scope === moduleScope) names.add(t.resolved.name);
    }
  }
  return names;
}

const families = new Map();
for (const stmt of ast.body) {
  const r = routeOf(stmt);
  if (!r || !r.path) continue;
  const fam = "/" + r.path.split("/").slice(1, 3).join("/");
  if (!families.has(fam)) families.set(fam, []);
  const refs = resolvesToModule(stmt);
  const { assigned } = moduleRefs(stmt);
  families.get(fam).push({ verb: r.verb, path: r.path, start: stmt.loc.start.line, end: stmt.loc.end.line, refs, assigned });
}

const wanted = process.argv.slice(2);
for (const [fam, routes] of [...families.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (wanted.length && !wanted.includes(fam)) continue;
  const deps = new Set();
  const assigned = new Set();
  for (const r of routes) { r.refs.forEach((n) => deps.add(n)); r.assigned.forEach((n) => assigned.add(n)); }
  const lines = routes.reduce((n, r) => n + (r.end - r.start + 1), 0);
  const ranges = routes.map((r) => `${r.start}-${r.end}`).join(",");
  console.log(`${fam}  routes=${routes.length} lines=${lines} deps=${deps.size}${assigned.size ? " ASSIGNS=" + [...assigned].join(",") : ""}`);
  if (wanted.length) {
    console.log("  ranges:", ranges);
    console.log("  deps:", [...deps].sort().join(", "));
  }
}
