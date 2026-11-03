// Manual (re)ingest of the on-disk parsed/validated CDS cache into the
// cds_records table. The server also does this automatically at boot when the
// table is empty; run this after updating the parsed files.
//
//   node scripts/ingest-cds-cache.mjs           # keeps a stored record that is ahead of its file
//   node scripts/ingest-cds-cache.mjs --force   # writes every committed file, whatever is stored
//
// Without --force a stored record of a later cycle, or of the same cycle read
// by a newer parser (the June-December refresh writes those), is kept over
// the committed file, as at boot (cds-store.js storedCdsIsAhead). --force
// puts the committed files back over everything, the way this script always
// forced a refresh before that rule existed.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRAGStatements } from "../storage/rag-engine.js";
import { ingestParsedCdsCache } from "../cds/cds-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The database the server opens (server.js): DB_PATH, else counselor.db in
// DATA_DIR, else backend/data. A fixed backend/data path missed the
// persistent disk wherever DATA_DIR points elsewhere.
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const dbPath = process.env.DB_PATH || path.join(dataDir, "counselor.db");
const force = process.argv.includes("--force");

const db = new Database(dbPath);
const ragStmts = prepareRAGStatements(db);

const result = await ingestParsedCdsCache(ragStmts, { force });
const count = db.prepare("SELECT COUNT(*) AS c FROM cds_records").get().c;

console.log(`Ingested ${result.ingested} record(s), skipped ${result.skipped}${force ? " (--force: every committed file written)" : ""}.`);
if (result.keptNewer) {
  console.log(`Of those skipped, kept ${result.keptNewer} newer stored record(s) over the committed file; run with --force to overwrite them.`);
}
if (result.errors.length) {
  console.log(`Errors (${result.errors.length}):`);
  for (const e of result.errors) console.log("  -", e);
}
console.log(`cds_records now holds ${count} row(s).`);
db.close();
