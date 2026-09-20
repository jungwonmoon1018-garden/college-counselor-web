// The server's source as the source-text tests read it: server.js followed
// by every route module under routes/ (the route families moved there on
// 2026-09-16) and every helper module under server/ (the helper functions
// moved there on 2026-09-20), so a test that pins a route, an audit call or
// a wiring by its text keeps working wherever the code lives. A moved module
// reads the server bindings as deps.<name> and imports its neighbours as
// ../x.js; the tests pin the wiring by the names the code used in server.js,
// so both are normalized back here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readServerSource() {
  const parts = [fs.readFileSync(path.join(ROOT, "server.js"), "utf8")];
  for (const dirName of ["routes", "server"]) {
    const dir = path.join(ROOT, dirName);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
      const text = fs.readFileSync(path.join(dir, file), "utf8")
        .replace(/\bdeps\.([A-Za-z_$][\w$]*)/g, "$1")
        .replace(/from "\.\.\//g, 'from "./');
      parts.push(`\n// ── ${dirName}/${file} ──\n${text}`);
    }
  }
  return parts.join("\n");
}
