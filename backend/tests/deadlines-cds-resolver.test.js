// Two paths looked a target school's Common Data Set up by an exact slug of
// its name, so the IPEDS baseline's "Columbia University in the City of New
// York" and every "Georgia Tech" or "NYU" silently had none: the narrative
// draft, the course plan and the EC tools were tailored without those
// schools' C7 priorities, and the context bundle's cdsContext was always
// empty. Both now go through the canonical resolver in cds-store.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initRAGTables, prepareRAGStatements } from "../storage/rag-engine.js";
import { ingestParsedCdsCache, resolveCdsRecordForSchool } from "../cds/cds-store.js";
import { bindNarrativeCalendar, getSchoolPriorities } from "../server/narrative-calendar.js";
import { readServerSource } from "./helpers/server-source.mjs";

const C7_PRIORITY_WEIGHTS = Object.freeze({ very_important: 1.0, important: 0.7, considered: 0.35, not_considered: 0.0 });

async function seededStmts() {
  const db = new Database(":memory:");
  initRAGTables(db);
  const stmts = prepareRAGStatements(db);
  await ingestParsedCdsCache(stmts);
  return stmts;
}

test("baseline names and short forms reach the stored Common Data Set", async () => {
  const stmts = await seededStmts();
  const cases = [
    ["Columbia University in the City of New York", "columbia-university"],
    ["Georgia Tech", "georgia-institute-of-technology"],
    ["NYU", "new-york-university"],
    ["University of Michigan-Ann Arbor", "university-of-michigan"],
    ["Purdue University", "purdue-university"],
  ];
  for (const [name, slug] of cases) {
    assert.equal(resolveCdsRecordForSchool(stmts, name)?.slug, slug, name);
  }
  assert.equal(resolveCdsRecordForSchool(stmts, "Nowhere Community College"), null);
  assert.equal(resolveCdsRecordForSchool(stmts, ""), null);
});

test("getSchoolPriorities finds the C7 priorities for those names", async () => {
  const stmts = await seededStmts();
  bindNarrativeCalendar({ ragStmts: stmts, C7_PRIORITY_WEIGHTS });
  const priorities = await getSchoolPriorities(["Columbia University in the City of New York", "Georgia Tech", "NYU", "Nowhere Community College"]);
  assert.deepEqual(priorities.map((p) => p.hasData), [true, true, true, false]);
  for (const p of priorities.slice(0, 3)) {
    assert.ok(p.admitRate > 0 && p.admitRate < 100, `${p.school} ${p.admitRate}`);
  }
  // The C7 factors where the stored set has them (NYU's parsed set has none).
  assert.ok(Object.keys(priorities[0].c7 || {}).length > 0, priorities[0].school);
  assert.ok(Object.keys(priorities[1].c7 || {}).length > 0, priorities[1].school);
});

// The helper reads route code with the `deps.` prefix stripped.
test("no route or server helper looks a record up by an ad-hoc slug", () => {
  const source = readServerSource();
  assert.doesNotMatch(source, /loadValidatedRecord\((?:deps\.)?ragStmts,\s*slugify\(/);
  assert.doesNotMatch(source, /rag\?\.goalSchoolNames/);
  assert.equal(source.match(/resolveCdsRecordForSchool\((?:deps\.)?ragStmts, name\)/g)?.length, 2);
});
