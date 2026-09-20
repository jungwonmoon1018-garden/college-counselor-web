#!/usr/bin/env node
// module-graph.mjs <file> [--json out.json] [--min N]
//
// The dependency picture of one module's top level, the thing to read before
// moving anything out of it: for every top-level statement, the module-level
// bindings it declares, the ones it reads (imports apart), the ones it
// writes, and whether it is "free" — reachable from imports and other free
// statements only, so it can move to another module without dragging module
// state (db handles, prepared statements, config) along.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "..", "package.json"));
const espree = require("espree");
const eslintScope = require("eslint-scope");

export function analyzeModule(file) {
  const src = fs.readFileSync(file, "utf8");
  const ast = espree.parse(src, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true }, loc: true, range: true, comment: true, tokens: false });
  const manager = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: "module", childVisitorKeys: null, fallback: "iteration" });
  const moduleScope = manager.globalScope.childScopes.find((s) => s.type === "module");
  const statements = ast.body.map((node, index) => ({ index, node, declares: [], reads: new Set(), writes: new Set(), importsUsed: new Set(), evalReads: new Set() }));
  const at = (pos) => statements.find((s) => s.node.range[0] <= pos && pos < s.node.range[1]);
  const owner = new Map(); // binding name -> statement index
  const imported = new Map(); // local name -> { source, specifierText }
  for (const variable of moduleScope.variables) {
    const def = variable.defs[0];
    if (!def) continue;
    if (def.type === "ImportBinding") {
      imported.set(variable.name, { source: def.parent.source.value, node: def.node });
      continue;
    }
    const stmt = at(def.name.range[0]);
    if (stmt) { stmt.declares.push(variable.name); owner.set(variable.name, stmt.index); }
  }
  // Whether a reference runs while the module is being evaluated (top-level
  // code, not inside any function): those are the ones that care about order.
  const evalTime = (ref) => {
    let scope = ref.from;
    while (scope && scope !== moduleScope) {
      if (scope.type === "function" || scope.type === "class-field-initializer" || scope.type === "class-static-block") return scope.type !== "function" ? true : false;
      scope = scope.upper;
    }
    return true;
  };
  for (const variable of moduleScope.variables) {
    for (const ref of variable.references) {
      const stmt = at(ref.identifier.range[0]);
      if (!stmt) continue;
      if (imported.has(variable.name)) { stmt.importsUsed.add(variable.name); continue; }
      if (owner.get(variable.name) === stmt.index) {
        if (ref.isWrite() && !ref.init) stmt.selfWrites = true;
        continue;
      }
      stmt.reads.add(variable.name);
      if (ref.isWrite() && !ref.init) stmt.writes.add(variable.name);
      if (evalTime(ref)) stmt.evalReads.add(variable.name);
    }
  }
  // eslint-scope does not count `<Name />` as a reference; resolve JSX element
  // names by hand, walking up from the innermost scope that encloses them.
  const scopeAt = (pos) => {
    let best = moduleScope;
    for (const scope of manager.scopes) {
      const [a, b] = scope.block.range;
      if (a <= pos && pos < b && scope.block.range[1] - scope.block.range[0] <= best.block.range[1] - best.block.range[0]) best = scope;
    }
    return best;
  };
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "JSXOpeningElement") {
      let nameNode = n.name;
      while (nameNode.type === "JSXMemberExpression") nameNode = nameNode.object;
      if (nameNode.type === "JSXIdentifier" && !/^[a-z]/.test(nameNode.name)) {
        let scope = scopeAt(nameNode.range[0]);
        while (scope && scope !== moduleScope && !scope.set.has(nameNode.name)) scope = scope.upper;
        if (scope === moduleScope && moduleScope.set.has(nameNode.name)) {
          const stmt = at(nameNode.range[0]);
          if (stmt) {
            if (imported.has(nameNode.name)) stmt.importsUsed.add(nameNode.name);
            else if (owner.get(nameNode.name) !== stmt.index) stmt.reads.add(nameNode.name);
          }
        }
      }
    }
    for (const key of Object.keys(n)) {
      if (key === "loc" || key === "range" || key === "parent") continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  // Free statements: a declaration whose reads are all owned by free
  // statements (fixpoint), that nobody else writes to, and that is const-like.
  const writtenFromOutside = new Set();
  for (const s of statements) for (const w of s.writes) writtenFromOutside.add(w);
  const declarative = (s) => ["FunctionDeclaration", "ClassDeclaration", "VariableDeclaration", "ExportNamedDeclaration"].includes(s.node.type) && s.declares.length > 0;
  const free = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of statements) {
      if (free.has(s.index) || !declarative(s)) continue;
      if (s.writes.size || s.declares.some((n) => writtenFromOutside.has(n))) continue;
      if ([...s.reads].every((n) => free.has(owner.get(n)))) { free.add(s.index); grew = true; }
    }
  }
  const usedBy = new Map();
  for (const s of statements) for (const n of s.reads) {
    if (!usedBy.has(n)) usedBy.set(n, new Set());
    usedBy.get(n).add(s.index);
  }
  return { src, ast, statements, owner, imported, free, usedBy, moduleScope };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const min = Number(args[args.indexOf("--min") + 1]) || 1;
  const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  const { statements, free, usedBy, owner } = analyzeModule(file);
  let freeLines = 0; let stateLines = 0;
  const rows = [];
  for (const s of statements) {
    const lines = s.node.loc.end.line - s.node.loc.start.line + 1;
    if (s.node.type === "ImportDeclaration") continue;
    const isFree = free.has(s.index);
    if (isFree) freeLines += lines; else stateLines += lines;
    const users = new Set();
    for (const n of s.declares) for (const u of usedBy.get(n) || []) users.add(u);
    rows.push({ start: s.node.loc.start.line, end: s.node.loc.end.line, lines, type: s.node.type, declares: s.declares, free: isFree, reads: [...s.reads], stateReads: [...s.reads].filter((n) => !free.has(owner.get(n))), writes: [...s.writes], users: users.size });
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
  for (const r of rows) {
    if (r.lines < min) continue;
    console.log(`${String(r.start).padStart(5)}-${String(r.end).padEnd(5)} ${String(r.lines).padStart(4)} ${r.free ? "free " : "state"} ${r.declares.join(",") || r.type}${r.free ? "" : "  <- " + r.stateReads.slice(0, 8).join(",")}${r.writes.length ? "  WRITES " + r.writes.join(",") : ""}`);
  }
  console.log(`free: ${freeLines} lines; bound to module state: ${stateLines} lines`);
}
