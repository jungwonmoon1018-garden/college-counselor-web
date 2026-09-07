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
