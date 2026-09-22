// The IPEDS baseline row a school name resolves to. IPEDS calls a flagship
// "Purdue University-Main Campus", so the bare name a student types never
// matched it exactly, and the prefix-extension rule scored a regional
// campus ("Purdue University Northwest", one extra word) above it (two):
// on 2026-09-22 a College Fit request for "Purdue University" was
// labelled Purdue University Northwest on production.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { bindBaselineColleges, resolveBaselineCollegeRow } from "../server/baseline-colleges.js";

bindBaselineColleges({ BASELINE_PROBE_STOPWORDS: new Set(["university", "college", "of", "the", "and", "institute", "state", "school", "at", "in"]) });

function baselineDb(rows) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE baseline_colleges (unit_id TEXT PRIMARY KEY, name TEXT NOT NULL, acceptance_rate REAL)");
  const insert = db.prepare("INSERT INTO baseline_colleges (unit_id, name, acceptance_rate) VALUES (?, ?, ?)");
  for (const [unitId, name, rate] of rows) insert.run(unitId, name, rate);
  return db;
}

test("a bare name resolves to the main campus, not the regional campus with the shorter name", () => {
  const db = baselineDb([
    ["147767", "Purdue University-Main Campus", 0.53],
    ["147679", "Purdue University Northwest", 0.5],
    ["151102", "Purdue University-Fort Wayne", 0.7],
    ["151111", "Indiana University-Purdue University-Indianapolis", 0.8],
  ]);
  assert.equal(resolveBaselineCollegeRow(db, { schoolName: "Purdue University" })?.name, "Purdue University-Main Campus");
  assert.equal(resolveBaselineCollegeRow(db, { schoolName: "Purdue University Main Campus" })?.name, "Purdue University-Main Campus");
  assert.equal(resolveBaselineCollegeRow(db, { schoolName: "Purdue University Northwest" })?.name, "Purdue University Northwest", "an exact regional name still resolves to itself");
  assert.equal(resolveBaselineCollegeRow(db, { unitId: "147679" })?.name, "Purdue University Northwest", "a unit id wins over any name");
  db.close();
});

test("a prefix extension still resolves when there is no main campus, and a distinct school is refused", () => {
  const db = baselineDb([
    ["190150", "Columbia University in the City of New York", 0.04],
    ["164924", "Boston College", 0.17],
  ]);
  assert.equal(resolveBaselineCollegeRow(db, { schoolName: "Columbia University" })?.name, "Columbia University in the City of New York");
  assert.equal(resolveBaselineCollegeRow(db, { schoolName: "Boston University" }), null, "Boston University is not Boston College");
  db.close();
});
