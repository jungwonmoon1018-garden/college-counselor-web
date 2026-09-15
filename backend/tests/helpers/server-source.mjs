// The server's source as the source-text tests read it: server.js followed
// by every route module under routes/ (the route families moved there on
// 2026-09-16), so a test that pins a route, an audit call or a wiring by
// its text keeps working wherever the handler lives. A route module reads
// the server bindings as deps.<name> and imports its neighbours as ../x.js;
// the tests pin the wiring by the names the handlers used in server.js, so
// both are normalized back here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readServerSource() {
  const parts = [fs.readFileSync(path.join(ROOT, "server.js"), "utf8")];
  const routesDir = path.join(ROOT, "routes");
  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith(".js")).sort()) {
    const text = fs.readFileSync(path.join(routesDir, file), "utf8")
      .replace(/\bdeps\.([A-Za-z_$][\w$]*)/g, "$1")
      .replace(/from "\.\.\//g, 'from "./');
    parts.push(`\n// ── routes/${file} ──\n${text}`);
  }
  return parts.join("\n");
}
