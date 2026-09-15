import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateRecord, CORRECTIONS } from "../cds-validator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARSED = path.join(__dirname, "..", "tools", "cds-cache", "parsed");

// The scope strings extractDocumentScope reads from the two Columbia
// documents (September 2026): the cover names the unit, A1 names the
// institution identically on both.
const COLUMBIA_COLLEGE_SCOPE = "Columbia College Columbia Engineering 2024–25 COMMON DATA SET · Columbia University in the City of New York";
const GENERAL_STUDIES_SCOPE = "2024–25 COMMON DATA SET Columbia General Studies · Columbia University in the City of New York";

test("the cached Columbia record is the Columbia College and Engineering CDS and validates clean", () => {
  const record = JSON.parse(fs.readFileSync(path.join(PARSED, "columbia-university.json"), "utf8"));
  assert.equal(record.yearLabel, "2024-25");
  assert.match(record.sourceUrl, /^https:\/\/opir\.columbia\.edu\//);
  assert.deepEqual(record.b1, { applied: 60247, admitted: 2325, enrolled: 1483 });
  assert.equal(record.overallAdmitRate, 0.0386);
  assert.deepEqual(record.enrolledSAT, { p25: 1510, p75: 1560 });
  assert.equal(record.c7.interview, "not_considered"); // General Studies rated interviews very important
  assert.equal(record.extras.dates.regularClosing.mmdd, "01-01"); // General Studies closed May 15
  assert.equal(record.extras.dates.edClosing.mmdd, "11-01");
  assert.equal(record.extras.applicationFeeUsd, 85);
  assert.equal(record._uncorrected, undefined);

  const v = validateRecord(record, CORRECTIONS["columbia-university"], record.validation.scopeFromPDF);
  assert.equal(v.status, "ok", JSON.stringify(v));
  assert.deepEqual(v.overrides, {});
  assert.match(record.validation.scopeFromPDF, /Columbia College Columbia Engineering/);
});

test("a General Studies document under Columbia's slug is a scope mismatch and is overridden", () => {
  const generalStudies = {
    school: "Columbia University", slug: "columbia-university",
    b1: { applied: 509, admitted: 152, enrolled: 75 }, overallAdmitRate: 0.2986,
    enrolledSAT: { p25: 1460, p75: 1530 },
  };
  const truth = CORRECTIONS["columbia-university"];
  const v = validateRecord(generalStudies, truth, GENERAL_STUDIES_SCOPE);
  assert.equal(v.status, "scope_mismatch");
  assert.equal(v.discrepancies[0].field, "scope");
  assert.match(v.discrepancies[0].note, /General Studies/);
  assert.equal(v.overrides.overallAdmitRate, 0.0386);
  assert.deepEqual(v.overrides.enrolledSAT, { p25: 1510, p75: 1560 });
  assert.equal(v.overrides.b1.applied, 60247);

  // The same numbers under the right cover are only an admit-rate drift.
  const drift = validateRecord(generalStudies, truth, COLUMBIA_COLLEGE_SCOPE);
  assert.notEqual(drift.status, "scope_mismatch");
  assert.ok(drift.discrepancies.some((d) => d.field === "overallAdmitRate"));
});

// ─── Truth speaks for one cycle ───
// The registry's figures were read from 2023-24 documents (Columbia's from
// its 2024-25 set). A record of another cycle keeps only the truth's scope
// check and is judged on its own consistency, so a 2025-26 admit rate is
// never "corrected" back to the 2023-24 one.
test("a record of another cycle is not overridden by the registry's figures and reads as consistent", async () => {
  const { checkConsistency, persistAndValidate } = await import("../cds-validator.js");
  const stmts = { cds: { upsert: { run() {} }, insertValidation: { run(...args) { this.last = args; } } } };
  const record = {
    slug: "johns-hopkins-university", school: "Johns Hopkins University", yearLabel: "2025-26",
    overallAdmitRate: 0.058, b1: { applied: 45000, admitted: 2610, enrolled: 1400 },
    enrolledSAT: { p25: 1530, p75: 1570 }, enrolledACT: { p25: 34, p75: 35 },
  };
  const { validation, finalRecord } = await persistAndValidate(stmts, record, {});
  assert.equal(validation.status, "consistent", JSON.stringify(validation));
  assert.equal(validation.truthCycle, "2023-24");
  assert.equal(finalRecord.overallAdmitRate, 0.058);
  assert.deepEqual(finalRecord.enrolledSAT, { p25: 1530, p75: 1570 });
  assert.deepEqual(validation.overrides, {});
  // The same record labeled with the registry's cycle is checked against
  // it: the 2023-24 rate was 6.44%, so 5.8% is a drift and is overridden.
  const same = await persistAndValidate(stmts, { ...record, yearLabel: "2023-24" }, {});
  assert.equal(same.validation.overrides.overallAdmitRate, 0.0644);
  // Consistency on its own.
  assert.equal(checkConsistency({ overallAdmitRate: 0.1, b1: { applied: 100, admitted: 10, enrolled: 5 } }).status, "consistent");
  assert.equal(checkConsistency({ overallAdmitRate: 0.2, b1: { applied: 100, admitted: 10 } }).status, "inconsistent");
  assert.equal(checkConsistency({ b1: { applied: 100, admitted: 120 } }).status, "inconsistent");
  assert.equal(checkConsistency({ enrolledSAT: { p25: 740, p75: 800 } }).status, "inconsistent");
  assert.equal(checkConsistency({ c7: { rigor: "very_important" } }).status, "no_truth");
});
