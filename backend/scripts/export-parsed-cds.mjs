// Export ingested Common Data Set rows to the on-disk parsed cache
// (tools/cds-cache/parsed/<slug>.json), which the repository commits and
// the server ingests at boot (cds-store.js ensureCdsStoreSeeded). Run it
// after `refresh-cds.mjs` so the records the refresh validated into the
// local database reach every deployment; the file is the row as
// loadValidatedRecord shapes it, with the latest validation alongside.
//
//   node scripts/export-parsed-cds.mjs --slugs boston-university,rice-university
//   node scripts/export-parsed-cds.mjs --year 2025-26      # every row of that cycle
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { prepareRAGStatements } from "../rag-engine.js";
import { loadAllValidatedRecords, loadLatestValidation } from "../cds-validator.js";
import { DEFAULT_PARSED_CDS_DIR } from "../cds-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data", "counselor.db");

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

const slugs = (readArg("--slugs") || "").split(",").map((s) => s.trim()).filter(Boolean);
const year = readArg("--year");
if (!slugs.length && !year) {
  console.error("Usage: node scripts/export-parsed-cds.mjs --slugs a,b,c | --year 2025-26");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const stmts = prepareRAGStatements(db);
const records = loadAllValidatedRecords(stmts).filter((r) => (slugs.length ? slugs.includes(r.slug) : r.yearLabel === year));
let written = 0;
for (const record of records) {
  const validation = loadLatestValidation(stmts, record.slug);
  const out = { source: "cds", extractionMethod: record.sourceKind === "xlsx" ? "xlsx" : ((record.parserNotes || []).some((n) => /^ocr/.test(n)) ? "ocr" : "pdfjs"), ...record, validation: validation ? { school: record.school, slug: record.slug, status: validation.status, discrepancies: validation.discrepancies, overrides: validation.overrides, scopeFromPDF: validation.scopeFromPDF } : null };
  fs.writeFileSync(path.join(DEFAULT_PARSED_CDS_DIR, `${record.slug}.json`), JSON.stringify(out, null, 2) + "\n");
  written += 1;
  console.log(`${record.slug} | ${record.yearLabel || record.year || "?"} | v${record.parserVersion} | admit ${record.overallAdmitRate ?? "-"} | SAT ${record.enrolledSAT ? `${record.enrolledSAT.p25}-${record.enrolledSAT.p75}` : "-"} | ${validation?.status || "no validation"}`);
}
console.log(`Wrote ${written} parsed record(s) to ${DEFAULT_PARSED_CDS_DIR}.`);
db.close();
