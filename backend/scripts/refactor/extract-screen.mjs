// Move the sidebar JSX out of App.jsx into src/Sidebar.jsx.
// The <aside> becomes Sidebar's return value; the App() bindings it reads
// become props (passed as one object); the module-level helpers, styles and
// editor components only the sidebar uses move with it; anything both sides
// use moves to src/app-shared.js and is imported by both.
// Usage: node extract-sidebar.mjs [--apply]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const F = path.resolve(B, "..", "frontend", "src");
const require = createRequire(pathToFileURL(path.join(B, "package.json")).href);
const espree = require("espree");
const eslintScope = require("eslint-scope");
const apply = process.argv.includes("--apply");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const TAG = arg("--tag", "main");
const NTH = Number(arg("--nth", "0"));
const NAME = arg("--name", "SurveyScreen");
const PROPS = arg("--props", "surveyProps");
const FILE = arg("--file", NAME + ".jsx");
const SHARED = "app-shared.js";

const file = `${F}/App.jsx`;
const src = fs.readFileSync(file, "utf8");
if (src.includes("\r\n")) throw new Error("App.jsx is CRLF");
const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "module", range: true, loc: true, comment: true, ecmaFeatures: { jsx: true } });
const scopeManager = eslintScope.analyze(ast, { ecmaVersion: 2024, sourceType: "module" });
const moduleScope = scopeManager.scopes.find((s) => s.type === "module");
const appDecl = ast.body.find((n) => n.type === "ExportDefaultDeclaration" && n.declaration.type === "FunctionDeclaration" && n.declaration.id.name === "App");
const appFn = appDecl.declaration;
const appScope = scopeManager.acquire(appFn);
// A binding of App() or of a block inside App() that encloses the target
// (the survey declares STEPS inside its screen branch) becomes a prop.
const enclosesTarget = (scope, target) => scope === appScope || (scope.block.range[0] >= appFn.range[0] && scope.block.range[1] <= appFn.range[1] && scope.block.range[0] <= target.range[0] && scope.block.range[1] >= target.range[1]);

function walk(n, fn, parent = null) {
  if (!n || typeof n.type !== "string") return;
  if (fn(n, parent) === false) return;
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "range" || key === "parent") continue;
    const v = n[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c, fn, n));
    else if (v && typeof v.type === "string") walk(v, fn, n);
  }
}

let aside = null;
let asideReturn = null;
let seen = 0;
walk(appFn, (n) => { if (aside) return false; if (n.type === "JSXElement" && n.openingElement.name.type === "JSXIdentifier" && n.openingElement.name.name === TAG) { if (seen++ === NTH) { aside = n; } return false; } });
walk(appFn, (n) => { if (n.type === "ReturnStatement" && n.range[0] <= aside.range[0] && n.range[1] >= aside.range[1]) asideReturn = n; });
if (!aside || !asideReturn) throw new Error("aside or its return not found");

// Imports of App.jsx.
const imports = new Map();
const importDecls = ast.body.filter((n) => n.type === "ImportDeclaration");
for (const node of importDecls) for (const sp of node.specifiers) imports.set(sp.local.name, { node, sp });

// Top-level declaration node for a module-scope name.
const topDecl = new Map();
for (const node of ast.body) {
  if (node.type === "FunctionDeclaration" && node.id) topDecl.set(node.id.name, node);
  else if (node.type === "VariableDeclaration") for (const d of node.declarations) if (d.id.type === "Identifier") topDecl.set(d.id.name, node);
}

// References (resolved) whose identifier lies inside a range.
function refsInRange(range) {
  const out = [];
  for (const scope of scopeManager.scopes) {
    for (const ref of scope.references) {
      if (ref.identifier.range[0] >= range[0] && ref.identifier.range[1] <= range[1] && ref.resolved) out.push(ref);
    }
  }
  return out;
}
// JSX component names inside a range (eslint-scope does not resolve JSX identifiers).
function jsxNamesInRange(node) {
  const names = new Set();
  walk(node, (n) => { if (n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier" && /^[A-Z]/.test(n.name.name)) names.add(n.name.name); });
  return names;
}

// Names the aside needs from module scope (helpers, styles, editors) and
// from App's scope (props).
const propNames = new Set();
const moduleNeeds = new Set();
const importNeeds = new Set();
for (const ref of refsInRange(aside.range)) {
  const v = ref.resolved;
  if (ref.isWrite() && (enclosesTarget(v.scope, aside) || v.scope === moduleScope)) throw new Error("aside writes " + v.name);
  if (v.scope !== moduleScope && enclosesTarget(v.scope, aside)) propNames.add(v.name);
  else if (v.scope === moduleScope) (imports.has(v.name) ? importNeeds : moduleNeeds).add(v.name);
}
for (const n of jsxNamesInRange(aside)) (imports.has(n) ? importNeeds : moduleNeeds).add(n);

// Closure of moved declarations: what they reference at module scope.
const moved = new Set();
const queue = [...moduleNeeds];
while (queue.length) {
  const name = queue.shift();
  if (moved.has(name)) continue;
  const decl = topDecl.get(name);
  if (!decl) throw new Error("no top-level declaration for " + name);
  moved.add(name);
  for (const ref of refsInRange(decl.range)) {
    const v = ref.resolved;
    if (!v || v.scope !== moduleScope) continue;
    if (imports.has(v.name)) { importNeeds.add(v.name); continue; }
    if (v.name !== name) queue.push(v.name);
  }
  for (const n of jsxNamesInRange(decl)) { if (imports.has(n)) importNeeds.add(n); else queue.push(n); }
}

// Shared: a moved name referenced from App.jsx outside the aside and outside
// the moved declarations goes to app-shared.js instead.
function insideMovedOrAside(pos) {
  if (pos >= aside.range[0] && pos <= aside.range[1]) return true;
  for (const name of moved) { const d = topDecl.get(name); if (pos >= d.range[0] && pos <= d.range[1]) return true; }
  return false;
}
const shared = new Set();
for (const name of moved) {
  const v = moduleScope.set.get(name);
  const outside = v.references.some((r) => !insideMovedOrAside(r.identifier.range[0]));
  const jsxOutside = (() => { let hit = false; walk(ast, (n) => { if (n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier" && n.name.name === name && !insideMovedOrAside(n.range[0])) hit = true; }); return hit; })();
  if (outside || jsxOutside) shared.add(name);
}
const movedOnly = [...moved].filter((n) => !shared.has(n));

console.log("aside lines", aside.loc.start.line, "-", aside.loc.end.line);
console.log("props (" + propNames.size + "):", [...propNames].sort().join(", "));
console.log("moved with the sidebar (" + movedOnly.length + "):", movedOnly.sort().join(", "));
console.log("shared via app-shared.js (" + shared.size + "):", [...shared].sort().join(", "));
console.log("imports needed (" + importNeeds.size + "):", [...importNeeds].sort().join(", "));
if (!apply) { console.log("(dry run)"); process.exit(0); }

// ── Text assembly ──
const leadingCommentsOf = (node) => {
  const idx = ast.body.indexOf(node);
  const prevEnd = idx > 0 ? ast.body[idx - 1].range[1] : 0;
  const cs = ast.comments.filter((c) => c.range[0] >= prevEnd && c.range[1] <= node.range[0]);
  return cs.length ? cs[0].range[0] : node.range[0];
};
const declText = (name) => { const d = topDecl.get(name); return src.slice(leadingCommentsOf(d), d.range[1]); };
const orderedByPosition = (names) => [...names].sort((a, b) => topDecl.get(a).range[0] - topDecl.get(b).range[0]);

// Import lines for a set of import bindings, grouped by source, verbatim specifiers.
function importLinesFor(names) {
  const bySource = new Map();
  for (const name of names) {
    const { node, sp } = imports.get(name);
    const g = bySource.get(node.source.value) || { default: null, ns: null, named: [] };
    if (sp.type === "ImportDefaultSpecifier") g.default = name;
    else if (sp.type === "ImportNamespaceSpecifier") g.ns = name;
    else g.named.push(sp.imported.name === name ? name : `${sp.imported.name} as ${name}`);
    bySource.set(node.source.value, g);
  }
  const lines = [];
  for (const [source, g] of bySource) {
    const parts = [];
    if (g.default) parts.push(g.default);
    if (g.ns) parts.push(`* as ${g.ns}`);
    if (g.named.length) parts.push(`{ ${g.named.sort().join(", ")} }`);
    lines.push(`import ${parts.join(", ")} from "${source}";`);
  }
  return lines;
}

// Which imports does each destination need? Sidebar: imports referenced by the
// aside or by moved-only declarations. Shared module: imports referenced by
// shared declarations.
function importsUsedIn(ranges) {
  const out = new Set();
  for (const r of ranges) {
    for (const ref of refsInRange(r)) if (ref.resolved && ref.resolved.scope === moduleScope && imports.has(ref.resolved.name)) out.add(ref.resolved.name);
  }
  return out;
}
const sidebarRanges = [aside.range, ...movedOnly.map((n) => topDecl.get(n).range)];
const sidebarImports = importsUsedIn(sidebarRanges);
for (const r of sidebarRanges) { let node = null; walk(ast, (n) => { if (n.range && n.range[0] === r[0] && n.range[1] === r[1]) node = n; }); if (node) for (const n of jsxNamesInRange(node)) if (imports.has(n)) sidebarImports.add(n); }
const sharedRanges = [...shared].map((n) => topDecl.get(n).range);
const sharedImports = importsUsedIn(sharedRanges);

const props = [...propNames].sort();
const sidebarBody = src.slice(aside.range[0], aside.range[1]).split("\n").map((l) => (l.trim() ? "    " + l.replace(/^      /, "") : l)).join("\n");
const sidebarFile =
  `// ${NAME}, moved out of App.jsx on 2026-09-16 with the module-level\n// helpers only it uses. App passes the state and callbacks it reads as\n// one props object (${PROPS} in App.jsx); nothing here writes App state\n// except through those callbacks.\n` +
  [...importLinesFor(sidebarImports), ...(shared.size ? [`import { ${[...shared].sort().join(", ")} } from "./${SHARED}";`] : [])].join("\n") + "\n\n" +
  orderedByPosition(movedOnly).map(declText).join("\n\n") + "\n\n" +
  `export default function ${NAME}(props) {\n` +
  "  const {\n    " + props.join(",\n    ") + ",\n  } = props;\n" +
  "  return (\n" + sidebarBody + "\n  );\n}\n";
fs.writeFileSync(`${F}/${FILE}`, sidebarFile);

const sharedPath = `${F}/${SHARED}`;
const existingShared = fs.existsSync(sharedPath) ? fs.readFileSync(sharedPath, "utf8") : null;
const alreadyShared = new Set(existingShared ? [...existingShared.matchAll(/^export (?:function|const|let) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]) : []);
const newShared = [...shared].filter((n) => !alreadyShared.has(n)).sort();
if (newShared.length) {
  const body = orderedByPosition(newShared).map((n) => declText(n).replace(/^(\s*)(function |const |let )/m, "$1export $2")).join("\n\n") + "\n";
  if (existingShared) {
    const extra = importLinesFor(sharedImports).filter((l) => !existingShared.includes(l));
    fs.writeFileSync(sharedPath, (extra.length ? extra.join("\n") + "\n" : "") + existingShared.trimEnd() + "\n\n" + body);
  } else {
    fs.writeFileSync(sharedPath, "// Helpers both App.jsx and the screens moved out of it use.\n" + importLinesFor(sharedImports).join("\n") + (sharedImports.size ? "\n\n" : "\n") + body);
  }
}

// Rewrite App.jsx: remove moved declarations (with leading comments),
// replace the aside with <Sidebar {...sidebarProps} />, add sidebarProps
// before the return, add imports.
const edits = [];
for (const name of moved) { const d = topDecl.get(name); edits.push({ at: leadingCommentsOf(d), end: d.range[1], text: "" }); }
const asideIndent = (src.slice(src.lastIndexOf("\n", aside.range[0]) + 1, aside.range[0]).match(/^\s*/) || [""])[0];
edits.push({ at: aside.range[0], end: aside.range[1], text: `<${NAME} {...${PROPS}} />` });
const retIndent = (src.slice(src.lastIndexOf("\n", asideReturn.range[0]) + 1, asideReturn.range[0]).match(/^\s*/) || [""])[0];
const propsBlock = `// Everything ${NAME} reads from this component (see ${FILE}).\n${retIndent}const ${PROPS} = {\n${retIndent}  ${props.join(", ")},\n${retIndent}};\n${retIndent}`;
edits.push({ at: asideReturn.range[0], end: asideReturn.range[0], text: propsBlock });
edits.sort((a, b) => b.at - a.at);
let out = src;
for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
const lastImport = importDecls[importDecls.length - 1];
const newImports = `import ${NAME} from "./${FILE}";\n` + (newShared.length ? `import { ${newShared.join(", ")} } from "./app-shared.js";\n` : "");
out = out.slice(0, lastImport.range[1] + 1) + newImports + out.slice(lastImport.range[1] + 1);
out = out.replace(/\n{4,}/g, "\n\n\n");
fs.writeFileSync(file, out);
void asideIndent;
console.log("App.jsx", src.split("\n").length, "->", out.split("\n").length, "lines; Sidebar.jsx", sidebarFile.split("\n").length, "lines");
