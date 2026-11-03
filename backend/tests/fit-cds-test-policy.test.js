// tests/fit-cds-test-policy.test.js — a test policy that was not read is
// unknown, not "required" (fit-6). Until parser version 8 an unread C8A row
// was stored as "test_required": 175 of the 299 committed records said so,
// UCLA (test-blind) among them. The parser now stores null, and a stored
// record from an older parse is read against its own evidence
// (readCdsTestPolicy).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cdsRecordToPositioningResult, readCdsTestPolicy } from "../cds/cds-store.js";
import { CDS_PARSER_VERSION, extractTestPolicy, extractTestPolicyPositional } from "../cds/cds-pdf-parser.js";
import { buildPositioningForTarget, buildStudentModel } from "../colleges/positioning-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARSED_DIR = path.join(__dirname, "..", "tools", "cds-cache", "parsed");
const parsed = (slug) => JSON.parse(fs.readFileSync(path.join(PARSED_DIR, `${slug}.json`), "utf8"));

test("the parsers leave a test policy they did not read unknown, and the version moved", () => {
  assert.ok(CDS_PARSER_VERSION >= 8, `version ${CDS_PARSER_VERSION}`);
  assert.equal(extractTestPolicyPositional([]), null);
  assert.equal(extractTestPolicy("Require SAT or ACT Recommend Not required for admission, but considered if submitted"), null);
  assert.equal(extractTestPolicy("We are test-optional."), "test_optional");
  assert.equal(extractTestPolicy("UC campuses are test-blind."), "test_blind");
  const source = fs.readFileSync(path.join(__dirname, "..", "cds", "cds-pdf-parser.js"), "utf8");
  assert.ok(source.includes("positional.testPolicy = extractTestPolicyPositional(items) ?? null;"));
});

test("an old stored 'required' is read against the record's own evidence", () => {
  const old = { testPolicy: "test_required", parserVersion: 6 };
  // A required school's class nearly all sent a score.
  assert.deepEqual(readCdsTestPolicy({ ...old, extras: { submitting: { satPct: 79, actPct: 27 } }, enrolledSAT: { p25: 1500, p75: 1580 } }), { value: "test_required", basis: "cds" });
  // Under 80% of the class submitting: admitted without scores.
  assert.deepEqual(readCdsTestPolicy({ ...old, extras: { submitting: { satPct: 55, actPct: 18 } }, enrolledSAT: { p25: 1350, p75: 1530 } }), { value: "test_optional", basis: "submission_share" });
  // No bands and C7 rating tests not considered (GPA and rigor considered): test-blind.
  assert.deepEqual(readCdsTestPolicy({ ...old, c7: { gpa: "very_important", rigor: "very_important", test_scores: "not_considered" } }), { value: "test_blind", basis: "c7_not_considered" });
  // A C7 that reads rigor "not considered" is a misread; with no bands the policy is unknown.
  assert.deepEqual(readCdsTestPolicy({ ...old, c7: { gpa: "very_important", rigor: "not_considered", test_scores: "not_considered" } }), { value: null, basis: "unsupported_default" });
  // Bands but a misread C7 (MIT's stored C7): the C7 does not decide.
  assert.deepEqual(readCdsTestPolicy({ ...old, enrolledSAT: { p25: 1520, p75: 1570 }, c7: { gpa: "very_important", rigor: "not_considered", test_scores: "not_considered" } }), { value: "test_required", basis: "cds" });
  // Nothing backs it at all: unknown.
  assert.deepEqual(readCdsTestPolicy(old), { value: null, basis: "unsupported_default" });
  // A version-8 parse is trusted as read, and optional or blind readings always are.
  assert.deepEqual(readCdsTestPolicy({ testPolicy: "test_required", parserVersion: 8 }), { value: "test_required", basis: "cds" });
  assert.deepEqual(readCdsTestPolicy({ testPolicy: "test_optional", parserVersion: 6 }), { value: "test_optional", basis: "cds" });
  assert.deepEqual(readCdsTestPolicy({ testPolicy: null }), { value: null, basis: "not_read" });
});

test("no committed UCLA record reads required, and the read sees the corrected policy", () => {
  for (const slug of ["university-of-california-los-angeles", "university-of-california-los-angeles-ucla"]) {
    // Stored as "test_required" by a version-6 parse when this was written;
    // a re-parse may correct the file itself, and the read must hold either way.
    const record = parsed(slug);
    const read = readCdsTestPolicy(record);
    assert.notEqual(read.value, "test_required", `${slug}: ${JSON.stringify(read)}`);
    const cds = cdsRecordToPositioningResult(record, { validated: true, verification: "validated" });
    assert.notEqual(cds.parsed.testPolicy, "test_considered_or_required", slug);
    const noScore = buildStudentModel({ gpa_unweighted: 3.9, major_interest: "Biology" }, [], null);
    const positioning = buildPositioningForTarget(noScore, { name: record.school, acceptanceRate: 9, avgGpaAdmitted: 3.9, topMajors: [] }, cds, {});
    assert.notEqual(positioning.profileComparison.tests.policy, "test_considered_or_required", slug);
    assert.equal(positioning.profileComparison.tests.score, 42, `${slug}: no score is not scored as a missing required one`);
  }
  // The rule's reach across the committed store, so a change to it is seen.
  const files = fs.readdirSync(PARSED_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  let required = 0;
  let readRequired = 0;
  for (const file of files) {
    const record = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, file), "utf8"));
    if (record.testPolicy === "test_required") required += 1;
    if (readCdsTestPolicy(record).value === "test_required") readRequired += 1;
  }
  assert.ok(readRequired < required, `${readRequired} of ${required} stored "required" records still read required`);
  // Michigan (test-optional; 73% of its 2025-26 class submitted a score) reads optional.
  assert.equal(readCdsTestPolicy(parsed("university-of-michigan")).value, "test_optional");
});
