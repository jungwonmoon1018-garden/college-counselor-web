// An old encoding accident (UTF-8 read as a Korean code page and written
// back) had replaced every em dash, arrow and box-drawing rule in five
// backend files: the milestone titles the counselor reads said "GPA
// improved: 3.80", two question marks, "3.90", the percentile reads said
// "Exceptional", two question marks, "top 5%", and comment banners turned
// into runs of rare Hangul that swallowed the line after them (debt-8). The
// damage sat unnoticed from the first commit. This test reads every source
// file under backend/ and frontend/src and fails on the accident's traces:
//   - U+FFFD, the replacement character;
//   - C1 control characters (U+0080-U+009F), what a "─" rule became;
//   - the banner run, a question mark before the syllable pair the "═"
//     rule decoded to (real Korean never uses that pair);
//   - two question marks glued to the next word after a space, between
//     words or numbers, where an em dash or an arrow and its space were lost
//     (the ?? operator is written with a space on both sides).
// backend/data/ holds real student data and is never read. A line that
// carries a damaged form on purpose, to test its repair, says
// "encoding-fixture" on that line.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_SRC = path.resolve(BACKEND, "..", "frontend", "src");
// Generated or fetched data is not source: the parsed Common Data Set cache
// holds what schools published, as they published it.
const SKIP_DIRS = new Set(["node_modules", "data", "public", "dist", "coverage", ".db-backups", "graphify-out", "cds-cache"]);
const SOURCE_EXT = /\.(?:m?js|cjs|jsx|ts|tsx|json|css|html|md|sql)$/;

// Built from code points so this file never holds the forms it looks for.
const BANNER_PAIR = String.fromCodePoint(0xba25, 0xbe27);
const TRACES = [
  ["replacement character", /\uFFFD/],
  ["C1 control character", /[\u0080-\u009F]/],
  ["mojibake banner", new RegExp(`\\?${BANNER_PAIR[0]}|${BANNER_PAIR}`)],
  ["lost dash or arrow", /[\w)}\]] \?\?[\w$({]/],
];

// Two test files belong to other work in flight on this branch and still
// carry the damage; each may hold no more damaged lines than it does now.
// Remove an entry when its file is repaired.
const PENDING_REPAIR = Object.freeze({});

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) yield* sourceFiles(path.join(dir, entry.name));
    } else if (SOURCE_EXT.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

export function encodingTraces(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.includes("encoding-fixture")) return;
    const trace = TRACES.find(([, re]) => re.test(line));
    if (trace) found.push({ line: index + 1, kind: trace[0] });
  });
  return found;
}

test("the trace patterns catch the accident's forms and leave real code and Korean alone", () => {
  const q = "??";
  const damaged = [
    `title: \`GPA \${direction}: \${prev} ${q}\${next}\``,
    `return "Exceptional ${q}top 5% nationally";`,
    `// ?${BANNER_PAIR}?${BANNER_PAIR}${q}// RAG ENGINE`,
    `// ?\u0080?\u0080?\u0080 Factor 1`,
    `const label = "bad \uFFFD byte";`,
  ];
  for (const line of damaged) assert.equal(encodingTraces(line).length, 1, line);
  const clean = [
    "const value = a ?? b;",
    "x ??= fallback;",
    "evidence?.fact_value ??",
    "`SELECT replace(title, ' ??', ' → ')`",
    "// ═══ RAG ENGINE — Retrieval ───",
    "\"deadlines.snooze\": \"나중에\",",
    "const re = /얼리 디시전|조기 지원|마감일이 언제예요\\?/;",
    `return "Exceptional ${q}top"; // encoding-fixture`,
  ];
  for (const line of clean) assert.deepEqual(encodingTraces(line), [], line);
});

test("no source file under backend/ or frontend/src carries the encoding accident", () => {
  const problems = [];
  const pending = [];
  for (const root of [BACKEND, FRONTEND_SRC]) {
    for (const file of sourceFiles(root)) {
      const relative = path.relative(path.resolve(BACKEND, ".."), file).split(path.sep).join("/");
      const traces = encodingTraces(fs.readFileSync(file, "utf8"));
      if (!traces.length) continue;
      const allowance = PENDING_REPAIR[relative];
      if (allowance != null && traces.length <= allowance) {
        pending.push(`${relative} (${traces.length})`);
        continue;
      }
      for (const trace of traces) problems.push(`${relative}:${trace.line} ${trace.kind}`);
    }
  }
  assert.deepEqual(problems, [], `restore the intended character (usually an em dash, an arrow or a box rule):\n${problems.join("\n")}`);
  if (pending.length) console.log(`[source-encoding] awaiting repair: ${pending.join(", ")}`);
});
