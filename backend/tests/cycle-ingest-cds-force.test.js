// scripts/ingest-cds-cache.mjs, the manual re-ingest of the committed CDS
// cache. ingestParsedCdsCache now keeps a stored record that is ahead of the
// committed file (a later cycle, or the same cycle read by a newer parser),
// so a boot never puts last year's seed back over a refreshed row. The
// script is documented as the way to force a refresh, so --force still
// writes every file. The script runs against a throwaway database here
// (DB_PATH), never backend/data.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { initRAGTables } from "../storage/rag-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(BACKEND_ROOT, "scripts", "ingest-cds-cache.mjs");
const SLUG = "austin-college";
const COMMITTED = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, "tools", "cds-cache", "parsed", `${SLUG}.json`), "utf8"));

let tmpDir;
let dbPath;

function runScript(args = []) {
  const env = { ...process.env, DATA_DIR: tmpDir, DB_PATH: dbPath };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: BACKEND_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

function storedRow() {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT year_label, parser_version FROM cds_records WHERE slug = ?").get(SLUG);
  } finally {
    db.close();
  }
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-ingest-force-"));
  dbPath = path.join(tmpDir, "counselor.db");
  const db = new Database(dbPath);
  initRAGTables(db);
  db.close();
});

after(() => {
  const resolved = tmpDir ? path.resolve(tmpDir) : "";
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("college-counselor-ingest-force-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("a plain re-ingest keeps a newer stored record, and --force writes the committed file over it", { timeout: 300_000 }, async () => {
  const first = await runScript();
  assert.equal(first.code, 0, first.output);
  assert.equal(storedRow()?.year_label, COMMITTED.yearLabel, first.output);

  // The refresh read the same cycle with a newer parser than the file's.
  const db = new Database(dbPath);
  db.prepare("UPDATE cds_records SET parser_version = 99 WHERE slug = ?").run(SLUG);
  db.close();

  const plain = await runScript();
  assert.equal(plain.code, 0, plain.output);
  assert.equal(storedRow().parser_version, 99, plain.output);
  assert.match(plain.output, /kept \d+ newer stored record/);

  const forced = await runScript(["--force"]);
  assert.equal(forced.code, 0, forced.output);
  assert.notEqual(storedRow().parser_version, 99, forced.output);
  assert.equal(storedRow().year_label, COMMITTED.yearLabel);
  assert.match(forced.output, /--force/);
});
