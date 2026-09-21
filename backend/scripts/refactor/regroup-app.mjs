#!/usr/bin/env node
// regroup-app.mjs --names threadList,renameThreadTitle --before refreshThreadList [--apply]
// regroup-app.mjs --names lookupCollege --after removeTargetSchool [--apply]
//
// Moves top-level declarations inside App() next to the code they belong
// with, so that a concern becomes one contiguous run extract-hook.mjs can
// take. Only declarations that are not effects may move (useState, useRef,
// useCallback, useMemo, plain consts): React pairs hooks with calls by
// order, and a new order is as good as the old one as long as it is the same
// on every render — but effects RUN in order, so an effect never moves.
// A move is allowed only when nothing can observe it at render time:
//   - everything the statement reads while rendering (initializer arguments,
//     dependency arrays — not the bodies of callbacks, which run later) is
//     declared above its new place;
//   - every render-time reference to what it declares sits below its new place.
// The statements travel verbatim with the comments above them, in the order
// they had.
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
const beforeName = arg("--before"); const afterName = arg("--after");
if (!names.length || (!beforeName && !afterName)) throw new Error("--names and one of --before/--after");

const file = path.join(F, "App.jsx");
const src = fs.readFileSync(file, "utf8");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", range: true, loc: true, comment: true, ecmaFeatures: { jsx: true } });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const appFn = ast.body.find((n) => n.type === "ExportDefaultDeclaration" && n.declaration.id?.name === "App").declaration;
const appScope = scopeManager.acquire(appFn);
const body = appFn.body.body;
const stmtOf = (name) => {
  const v = appScope.set.get(name);
  if (!v || !v.defs[0]) throw new Error(`no App() binding ${name}`);
  return body.find((s) => s.range[0] <= v.defs[0].name.range[0] && v.defs[0].name.range[1] <= s.range[1]);
};
const moving = [...new Set(names.map(stmtOf))].sort((a, b) => a.range[0] - b.range[0]);
const anchor = stmtOf(beforeName || afterName);
if (moving.includes(anchor)) throw new Error("the anchor is one of the moved statements");

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
for (const s of moving) {
  if (s.type !== "VariableDeclaration") problems.push(`line ${s.loc.start.line}: only declarations move (this is ${s.type})`);
  walk(s, (n) => { if (n.type === "CallExpression" && /^use(Layout)?Effect$/.test(n.callee.name || "")) problems.push(`line ${n.loc.start.line}: an effect never moves`); });
}
// A reference made while App() renders: its scope is App()'s own, not a
// nested function's — except a function React calls during the render itself
// (a lazy useState initializer, a useMemo factory).
const eager = [];
walk(appFn.body, (n) => {
  if (n.type === "CallExpression" && /^use(State|Memo|Reducer)$/.test(n.callee.name || "")) {
    for (const a of n.arguments) if (/Function/.test(a.type)) eager.push(a.range);
  }
});
const renderTime = (ref) => ref.from === appScope
  || (ref.from.type === "block" && ref.from.variableScope === appScope)
  || eager.some(([a, b]) => ref.identifier.range[0] >= a && ref.identifier.range[1] <= b);
// Where the statements will sit: measured in positions of the ORIGINAL text.
const anchorIndex = body.indexOf(anchor);
const newPos = beforeName ? anchor.range[0] : anchor.range[1];
for (const s of moving) {
  const declared = appScope.variables.filter((v) => v.defs[0] && v.defs[0].name.range[0] >= s.range[0] && v.defs[0].name.range[1] <= s.range[1]);
  // What it reads at render time must be declared above the new place.
  for (const v of appScope.variables) {
    if (declared.includes(v) || !v.defs[0]) continue;
    const readsHere = v.references.some((r) => renderTime(r) && r.identifier.range[0] >= s.range[0] && r.identifier.range[1] <= s.range[1]);
    if (!readsHere) continue;
    const declStmt = body.find((b) => b.range[0] <= v.defs[0].name.range[0] && v.defs[0].name.range[1] <= b.range[1]);
    if (!declStmt) continue; // a parameter
    const declaredAbove = moving.includes(declStmt) ? moving.indexOf(declStmt) < moving.indexOf(s) : declStmt.range[1] <= newPos;
    if (!declaredAbove) problems.push(`${declared.map((d) => d.name).join(",")} reads ${v.name} while rendering, which would then be declared below it (line ${declStmt.loc.start.line})`);
  }
  // Render-time references to what it declares must sit below the new place.
  for (const d of declared) for (const r of d.references) {
    if (!renderTime(r) || (r.identifier.range[0] >= s.range[0] && r.identifier.range[1] <= s.range[1])) continue;
    const user = body.find((b) => b.range[0] <= r.identifier.range[0] && r.identifier.range[1] <= b.range[1]);
    if (!user) continue; // the return / JSX at the end reads everything; it is below by construction
    const below = moving.includes(user) ? moving.indexOf(user) > moving.indexOf(s) : user.range[0] >= newPos;
    if (!below) problems.push(`${d.name} is read while rendering at line ${r.identifier.loc.start.line}, above its new place`);
  }
}
if (problems.length) { console.error("refused:\n  " + [...new Set(problems)].join("\n  ")); process.exit(1); }

// Text surgery: cut each statement with the comments above it, paste them at the anchor.
const lineStart = (pos) => src.lastIndexOf("\n", pos - 1) + 1;
const lineEnd = (pos) => { const i = src.indexOf("\n", pos); return i < 0 ? src.length : i + 1; };
const cuts = moving.map((s) => {
  const index = body.indexOf(s); const prev = body[index - 1];
  const leading = ast.comments.filter((c) => c.range[0] >= (prev ? prev.range[1] : appFn.body.range[0] + 1) && c.range[1] <= s.range[0] && !(prev && c.loc.start.line === prev.loc.end.line));
  // Only the comment block directly above (no blank line between) belongs to the statement.
  let from = s.range[0];
  for (let i = leading.length - 1; i >= 0; i--) {
    const between = src.slice(leading[i].range[1], from);
    if (/\n\s*\n/.test(between)) break;
    from = leading[i].range[0];
  }
  return { start: lineStart(from), end: lineEnd(s.range[1]) };
});
const pasteAt = beforeName ? (() => {
  const prev = body[anchorIndex - 1];
  const leading = ast.comments.filter((c) => c.range[0] >= (prev ? prev.range[1] : 0) && c.range[1] <= anchor.range[0] && !(prev && c.loc.start.line === prev.loc.end.line));
  let from = anchor.range[0];
  for (let i = leading.length - 1; i >= 0; i--) { if (/\n\s*\n/.test(src.slice(leading[i].range[1], from))) break; from = leading[i].range[0]; }
  return lineStart(from);
})() : lineEnd(anchor.range[1]);
const block = cuts.map((c) => src.slice(c.start, c.end)).join("");
const edits = [...cuts.map((c) => ({ at: c.start, end: c.end, text: "" })), { at: pasteAt, end: pasteAt, text: block }].sort((a, b) => b.at - a.at || b.end - a.end);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
console.log(`${moving.length} statement(s) (${names.join(", ")}) move ${beforeName ? "before " + beforeName : "after " + afterName}`);
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }
fs.writeFileSync(file, out);
