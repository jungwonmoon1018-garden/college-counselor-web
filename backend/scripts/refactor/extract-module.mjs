#!/usr/bin/env node
// extract-module.mjs --file <module> --out <new module> (--names a,b | --range 10-200)… [--apply]
//
// Moves top-level declarations out of a module into a new sibling module,
// verbatim and in their original order, each with the comments above it.
// Only declarations move (a top-level statement with side effects stays
// where its order matters), and only a closed set: everything a moved
// statement reads must be an import (re-imported by the new module) or move
// with it, nothing moved may be assigned from what stays, and nothing moved
// may assign what stays — so the new module never imports the old one back.
// What the old module still reads it imports from the new one; names that
// were exported stay exported through a re-export. The old module's import
// specifiers that only the moved code used are dropped.
import fs from "node:fs";
import path from "node:path";
import { analyzeModule } from "./module-graph.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const out = []; args.forEach((a, i) => { if (a === `--${name}`) out.push(args[i + 1]); }); return out; };
const apply = args.includes("--apply");
const file = path.resolve(opt("file")[0]);
const outFile = path.resolve(opt("out")[0]);
const names = opt("names").flatMap((s) => s.split(",")).filter(Boolean);
const ranges = opt("range").map((r) => r.split("-").map(Number));
const headerText = opt("header")[0] || "";
if (fs.existsSync(outFile)) throw new Error(`${outFile} exists`);

const { src, ast, statements, owner, imported } = analyzeModule(file);
if (src.includes("\r\n")) throw new Error("CRLF source");

const selected = new Set();
for (const s of statements) {
  if (s.node.type === "ImportDeclaration") continue;
  const a = s.node.loc.start.line; const b = s.node.loc.end.line;
  if (ranges.some(([from, to]) => a >= from && b <= to)) selected.add(s.index);
  if (s.declares.some((n) => names.includes(n))) selected.add(s.index);
}
for (const n of names) if (!owner.has(n)) throw new Error(`no top-level binding ${n}`);
if (!selected.size) throw new Error("nothing selected");

const problems = [];
const declared = new Set();
for (const i of selected) {
  const s = statements[i];
  const inner = s.node.type === "ExportNamedDeclaration" ? s.node.declaration : s.node;
  if (!inner || !["FunctionDeclaration", "ClassDeclaration", "VariableDeclaration"].includes(inner.type)) {
    problems.push(`line ${s.node.loc.start.line}: ${s.node.type} is not a declaration and stays`);
  }
  s.declares.forEach((n) => declared.add(n));
}
for (const i of selected) {
  const s = statements[i];
  for (const n of s.reads) if (!declared.has(n)) problems.push(`line ${s.node.loc.start.line} (${s.declares.join(",")}) reads ${n}, which stays (line ${statements[owner.get(n)].node.loc.start.line})`);
  for (const n of s.writes) if (!declared.has(n)) problems.push(`line ${s.node.loc.start.line} assigns ${n}, which stays`);
}
for (const s of statements) {
  if (selected.has(s.index)) continue;
  for (const n of s.writes) if (declared.has(n)) problems.push(`line ${s.node.loc.start.line} assigns ${n}, which would move`);
}
if (problems.length) {
  console.error("refused:\n  " + problems.join("\n  "));
  process.exit(1);
}

// A statement travels with the comments between it and the statement before
// it; a comment on the previous statement's own last line is that one's.
const pieces = [];
for (const s of statements) {
  if (!selected.has(s.index)) continue;
  const prev = statements[s.index - 1];
  let from = prev ? prev.node.range[1] : 0;
  if (prev) {
    const trailing = ast.comments.filter((c) => c.range[0] >= from && c.loc.start.line === prev.node.loc.end.line);
    if (trailing.length) from = trailing[trailing.length - 1].range[1];
  }
  const leading = ast.comments.filter((c) => c.range[0] >= from && c.range[1] <= s.node.range[0]);
  const start = leading.length ? leading[0].range[0] : s.node.range[0];
  let end = s.node.range[1];
  const next = statements[s.index + 1];
  const own = ast.comments.filter((c) => c.range[0] >= end && c.loc.start.line === s.node.loc.end.line && (!next || c.range[1] <= next.node.range[0]));
  if (own.length) end = own[own.length - 1].range[1];
  pieces.push({ s, start, end });
}

const stays = statements.filter((s) => !selected.has(s.index) && s.node.type !== "ImportDeclaration");
const readOutside = new Set();
for (const s of stays) for (const n of s.reads) if (declared.has(n)) readOutside.add(n);

const relTo = (source) => {
  if (!source.startsWith(".")) return source;
  const target = path.resolve(path.dirname(file), source);
  let rel = path.relative(path.dirname(outFile), target).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
};
const importGroups = new Map();
for (const { s } of pieces) {
  for (const local of s.importsUsed) {
    const spec = imported.get(local).node;
    const decl = ast.body.find((n) => n.type === "ImportDeclaration" && n.specifiers.includes(spec));
    const key = decl.source.value;
    if (!importGroups.has(key)) importGroups.set(key, { def: null, ns: null, named: new Set() });
    const g = importGroups.get(key);
    if (spec.type === "ImportDefaultSpecifier") g.def = local;
    else if (spec.type === "ImportNamespaceSpecifier") g.ns = local;
    else g.named.add(spec.imported.name === local ? local : `${spec.imported.name} as ${local}`);
  }
}
const importLines = [];
for (const [source, g] of importGroups) {
  if (g.ns) importLines.push(`import * as ${g.ns} from "${relTo(source)}";`);
  const parts = [];
  if (g.def) parts.push(g.def);
  if (g.named.size) parts.push(`{ ${[...g.named].join(", ")} }`);
  if (parts.length) importLines.push(`import ${parts.join(", ")} from "${relTo(source)}";`);
}

const reexports = [];
const body = pieces.map(({ s, start, end }) => {
  let text = src.slice(start, end);
  const exported = s.node.type === "ExportNamedDeclaration";
  if (exported) reexports.push(...s.declares);
  else if (s.declares.some((n) => readOutside.has(n))) {
    const at = s.node.range[0] - start;
    text = text.slice(0, at) + "export " + text.slice(at);
  }
  return text;
}).join("\n\n");
const header = headerText ? headerText.split("\\n").map((l) => `// ${l}`.trimEnd()).join("\n") + "\n" : "";
const moduleText = `${header}${importLines.length ? importLines.join("\n") + "\n\n" : ""}${body}\n`;

// The old module: statements out (back to front), an import of what it still
// reads, re-exports, and its own imports pruned of what only the moved code used.
let out = src;
const edits = pieces.map(({ start, end }) => ({ at: start, end, text: "" }));
const stillUsed = new Set();
for (const s of stays) for (const local of s.importsUsed) stillUsed.add(local);
for (const node of ast.body) {
  if (node.type !== "ImportDeclaration" || !node.specifiers.length) continue;
  const keep = node.specifiers.filter((sp) => stillUsed.has(sp.local.name));
  if (keep.length === node.specifiers.length) continue;
  let text;
  if (!keep.length) text = importGroups.has(node.source.value) ? "" : `import "${node.source.value}";`;
  else {
    const def = keep.find((sp) => sp.type === "ImportDefaultSpecifier");
    const ns = keep.find((sp) => sp.type === "ImportNamespaceSpecifier");
    const named = keep.filter((sp) => sp.type === "ImportSpecifier").map((sp) => (sp.imported.name === sp.local.name ? sp.local.name : `${sp.imported.name} as ${sp.local.name}`));
    const parts = [];
    if (def) parts.push(def.local.name);
    if (ns) parts.push(`* as ${ns.local.name}`);
    if (named.length) parts.push(`{ ${named.join(", ")} }`);
    text = `import ${parts.join(", ")} from "${node.source.value}";`;
  }
  const end = text === "" && out[node.range[1]] === "\n" ? node.range[1] + 1 : node.range[1];
  edits.push({ at: node.range[0], end, text });
}
let rel = path.relative(path.dirname(file), outFile).split(path.sep).join("/");
if (!rel.startsWith(".")) rel = "./" + rel;
const lastImport = ast.body.filter((n) => n.type === "ImportDeclaration").pop();
const needed = [...readOutside].filter((n) => !reexports.includes(n) || stays.some((s) => s.reads.has(n)));
let added = "";
if (needed.length) added += `\nimport { ${needed.join(", ")} } from "${rel}";`;
if (reexports.length) added += `\nexport { ${reexports.join(", ")} } from "${rel}";`;
const insertAt = lastImport ? lastImport.range[1] : 0;
edits.push({ at: insertAt, end: insertAt, text: added });
edits.sort((a, b) => b.at - a.at || b.end - a.end);
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
out = out.replace(/\n{4,}/g, "\n\n\n");

const movedLines = pieces.reduce((n, p) => n + src.slice(p.start, p.end).split("\n").length, 0);
console.log(`${path.basename(file)} -> ${path.basename(outFile)}: ${pieces.length} statements, ${movedLines} lines; exports ${[...readOutside].length}, re-exports ${reexports.length}, imports ${importLines.length}`);
console.log(`${path.basename(file)}: ${src.split("\n").length} -> ${out.split("\n").length} lines`);
if (!apply) { console.log("(dry run; pass --apply)"); process.exit(0); }
fs.writeFileSync(outFile, moduleText);
fs.writeFileSync(file, out);
