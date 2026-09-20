#!/usr/bin/env node
// move-modules.mjs --map <map.json> [--log rewrites.txt] [--apply]
//
// Moves modules into folders and keeps every reference to them working.
// The map is { "backend/cds-store.js": "backend/cds/cds-store.js", … },
// paths from the repository root. For every tracked .js/.jsx/.mjs file under
// backend/ and frontend/ the tool reads each string literal that is a
// relative path ("./x.js", "../y/z"): when it resolves, from the file's
// OLD place, to something that exists, it is rewritten so that it resolves
// to the same thing from the file's NEW place — the target's new place when
// the target moves too. That covers static and dynamic imports, re-exports,
// new URL("…", import.meta.url) and path.resolve(__dirname, "../x.js") in
// tests. It does not cover a path assembled from segments
// (path.join(__dirname, "tools", "cds-cache")): those lines are listed for
// every moved file, to be fixed by hand. Files move with `git mv`.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.resolve(B, "..");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const mapFile = args[args.indexOf("--map") + 1];
const rawMap = JSON.parse(fs.readFileSync(mapFile, "utf8"));
const abs = (p) => path.resolve(ROOT, p);
const moves = new Map(Object.entries(rawMap).map(([from, to]) => [abs(from), abs(to)]));
for (const [from, to] of moves) {
  if (!fs.existsSync(from)) throw new Error(`missing: ${path.relative(ROOT, from)}`);
  if (fs.existsSync(to)) throw new Error(`exists: ${path.relative(ROOT, to)}`);
}

const tracked = execFileSync("git", ["ls-files", "backend", "frontend"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => /\.(js|jsx|mjs)$/.test(f) && !f.startsWith("backend/tools/") && !f.startsWith("backend/generated/") && !f.includes("/dist/"));

function parse(src) {
  const base = { ecmaVersion: "latest", range: true, loc: true, ecmaFeatures: { jsx: true } };
  try { return espree.parse(src, { ...base, sourceType: "module" }); } catch { /* fall through */ }
  try { return espree.parse(src.replace(/^#!.*/, (m) => " ".repeat(m.length)), { ...base, sourceType: "module" }); } catch { return null; }
}
function walk(n, fn) {
  if (!n || typeof n.type !== "string") return;
  fn(n);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "range") continue;
    const v = n[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn)); else if (v && typeof v.type === "string") walk(v, fn);
  }
}
const posix = (p) => p.split(path.sep).join("/");
// A relative path that names something: "./x.js", "../tools/cds-cache". A
// string made only of dots and slashes (".", "..", "./", "../..") is far
// more often a separator or a traversal guard than a path — the first
// version of this tool rewrote host.split(".") to split("..") in every
// moved file — so those are never rewritten, only listed when the line
// looks like path arithmetic.
const DOTS_ONLY = /^\.{1,2}(\/\.{1,2})*\/?$/;
const isRelative = (v) => (v.startsWith("./") || v.startsWith("../")) && !DOTS_ONLY.test(v);

let rewritten = 0; const unparsed = []; const review = []; const outputs = []; const log = [];
for (const rel of tracked) {
  const oldPath = abs(rel);
  const newPath = moves.get(oldPath) || oldPath;
  const src = fs.readFileSync(oldPath, "utf8");
  const ast = parse(src);
  if (!ast) { unparsed.push(rel); continue; }
  const edits = [];
  walk(ast, (n) => {
    let value = null; let range = null;
    if (n.type === "Literal" && typeof n.value === "string") { value = n.value; range = [n.range[0] + 1, n.range[1] - 1]; }
    else if (n.type === "TemplateLiteral" && n.expressions.length === 0) { value = n.quasis[0].value.cooked; range = [n.range[0] + 1, n.range[1] - 1]; }
    if (value == null || !isRelative(value)) return;
    const target = path.resolve(path.dirname(oldPath), value);
    if (!fs.existsSync(target)) return;
    const targetNew = moves.get(target) || target;
    let next = posix(path.relative(path.dirname(newPath), targetNew)) || ".";
    if (!next.startsWith(".")) next = "./" + next;
    if (value.endsWith("/") && !next.endsWith("/")) next += "/";
    if (next !== value) edits.push({ at: range[0], end: range[1], text: next, line: n.loc.start.line, from: value });
  });
  if (moves.has(oldPath)) {
    src.split("\n").forEach((line, i) => {
      // Any path built from this module's own location: segments are not rewritten.
      if (/(__dirname|MODULE_DIR|import\.meta\.url)/.test(line) && /path\.(join|resolve)\(|new URL\(/.test(line) && !/const __dirname\s*=/.test(line)) review.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  if (!edits.length && newPath === oldPath) continue;
  let out = src;
  edits.sort((a, b) => b.at - a.at);
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  rewritten += edits.length;
  for (const e of edits) log.push(`${rel}:${e.line}: ${e.from} -> ${e.text}`);
  outputs.push({ oldPath, newPath, out, edits: edits.length });
}

console.log(`${moves.size} files move; ${rewritten} path literals rewritten in ${outputs.filter((o) => o.edits).length} files`);
if (args.includes("--log")) fs.writeFileSync(args[args.indexOf("--log") + 1], log.join("\n") + "\n");
if (unparsed.length) console.log("not parsed (left alone):", unparsed.join(", "));
if (review.length) console.log("segment-built paths in moved files — fix by hand:\n  " + review.join("\n  "));
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }

for (const [from, to] of moves) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  execFileSync("git", ["mv", posix(path.relative(ROOT, from)), posix(path.relative(ROOT, to))], { cwd: ROOT });
}
for (const o of outputs) fs.writeFileSync(o.newPath, o.out);
console.log("moved and rewritten");
