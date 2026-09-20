// The student app's source as the source-text tests read it: every module
// under frontend/src (tests apart), App.jsx first. App.jsx was split into
// sibling modules on 2026-09-16 and 2026-09-20 (the chat transport lives in
// chat-client.js, the send handler in chat-send.js, and so on), so a test
// that pins a behaviour by its text must not care which file holds it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "frontend", "src");

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// [relative path, text] pairs, App.jsx first, the rest in path order.
export function readFrontendSources() {
  const files = sourceFiles(SRC).sort((a, b) => a.localeCompare(b));
  const app = path.join(SRC, "App.jsx");
  const ordered = [app, ...files.filter((f) => f !== app)];
  return ordered.map((f) => [path.relative(SRC, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")]);
}

export function readFrontendSource() {
  return readFrontendSources().map(([name, text]) => `\n// ── ${name} ──\n${text}`).join("\n");
}
