import test from "node:test";
import assert from "node:assert/strict";

import {
  TEST_CATALOG,
  deriveTotal,
  sectionEntries,
  formatSections,
  validateTestEntry,
  normalizeTestScores,
  normalizeClassRank,
  formatClassRank,
} from "../test-catalog.js";
import { TEST_CATALOG as FRONTEND_CATALOG, TEST_SCORE_LIMITS, withSection, formToEntry, entryToForm } from "../../frontend/src/test-scores.js";

test("the frontend catalog is a mirror of the backend one", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(FRONTEND_CATALOG)), JSON.parse(JSON.stringify(TEST_CATALOG)));
  assert.equal(TEST_SCORE_LIMITS.sat.label, "400-1600");
  assert.equal(TEST_SCORE_LIMITS.ielts.label, "0-9.0");
});

test("totals derive from sections the way each test scores", () => {
  assert.equal(deriveTotal("sat", { readingWriting: 720, math: 780 }), 1500);
  assert.equal(deriveTotal("psat", { readingWriting: 690, math: 690 }), 1380);
  // ACT: the composite is the rounded mean of the four subject scores;
  // Writing never counts.
  assert.equal(deriveTotal("act", { english: 35, math: 31, reading: 34, science: 32, writing: 9 }), 33);
  assert.equal(deriveTotal("act", { english: 34, math: 33, reading: 34, science: 33 }), 34); // 33.5 rounds up
  assert.equal(deriveTotal("act", { english: 34, math: 33, reading: 34 }), null);
  assert.equal(deriveTotal("toefl", { reading: 28, listening: 27, speaking: 25, writing: 28 }), 108);
  // IELTS: mean to the nearest half band, .25 and .75 rounding up.
  assert.equal(deriveTotal("ielts", { listening: 8, reading: 7.5, writing: 7, speaking: 7.5 }), 7.5);
  assert.equal(deriveTotal("ielts", { listening: 8, reading: 8, writing: 7, speaking: 7 }), 7.5);
  assert.equal(deriveTotal("ielts", { listening: 8, reading: 8, writing: 8, speaking: 7 }), 8);
  assert.equal(deriveTotal("duolingo", { literacy: 120, comprehension: 130, conversation: 110, production: 100 }), null);
  assert.equal(deriveTotal("clep", {}), null);
});

test("section entries follow catalog order and ignore stray keys", () => {
  const entry = { test: "act", totalScore: 33, sections: { science: 32, english: 35, bogus: 40, math: "31" } };
  assert.deepEqual(sectionEntries(entry).map((s) => [s.key, s.value]), [["english", 35], ["math", 31], ["science", 32]]);
  assert.equal(formatSections(entry), "English 35, Math 31, Science 32");
  assert.equal(formatSections({ test: "clep", totalScore: 60 }), "");
});

test("validation enforces ranges, steps and section consistency", () => {
  assert.deepEqual(validateTestEntry({ test: "sat", totalScore: 1500, sections: { readingWriting: 720, math: 780 } }), { ok: true, errors: [] });
  assert.match(validateTestEntry({ test: "sat", totalScore: 1505 }).errors[0], /400-1600 in steps of 10/);
  assert.match(validateTestEntry({ test: "sat", totalScore: 1500, sections: { readingWriting: 720, math: 790 } }).errors[0], /must add up to the total/);
  assert.match(validateTestEntry({ test: "sat", totalScore: 1500, sections: { math: 810 } }).errors[0], /SAT Math must be 200-800/);
  assert.match(validateTestEntry({ test: "act", totalScore: 30, sections: { english: 35, math: 31, reading: 34, science: 32 } }).errors[0], /average to 33, not 30/);
  assert.equal(validateTestEntry({ test: "act", totalScore: 34, sections: { english: 35, math: 31, reading: 34, science: 32 } }).ok, true); // within rounding
  assert.match(validateTestEntry({ test: "act", totalScore: 33, sections: { writing: 13 } }).errors[0], /ACT Writing must be 2-12/);
  assert.match(validateTestEntry({ test: "ielts", totalScore: 7.25 }).errors[0], /0-9 in steps of 0\.5/);
  assert.equal(validateTestEntry({ test: "ielts", totalScore: 7.5, sections: { listening: 8, reading: 7.5, writing: 7, speaking: 7.5 } }).ok, true);
  assert.match(validateTestEntry({ test: "gre", totalScore: 320 }).errors[0], /Unknown test/);
  assert.match(validateTestEntry({ test: "toefl", sections: { reading: "x" } }).errors.join(" "), /Enter a TOEFL score/);
});

test("normalization keeps known tests with numeric fields and drops bad entries", () => {
  const stored = normalizeTestScores([
    { test: "SAT", totalScore: "1500", date: "2026-03", subject: "", sections: { readingWriting: "720", math: 780, extra: 1 } },
    { test: "act", sections: { english: 35, math: 31, reading: 34, science: 32 } }, // total derived
    { test: "sat_subject", totalScore: 780, subject: "  Math Level 2  ", date: "March" },
    { test: "sat", totalScore: 1700 },
    { test: "gre", totalScore: 320 },
    null,
  ]);
  assert.deepEqual(stored, [
    { test: "sat", totalScore: 1500, sections: { readingWriting: 720, math: 780 }, date: "2026-03" },
    { test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32 } },
    { test: "sat_subject", totalScore: 780, subject: "Math Level 2" },
  ]);
  assert.deepEqual(normalizeTestScores("nope"), []);
});

test("class rank is kept as a share from the top, derived from rank and size when both are known", () => {
  assert.deepEqual(normalizeClassRank({ rank: 12, size: 400 }), { topPercent: 3, rank: 12, size: 400 });
  assert.deepEqual(normalizeClassRank({ topPercent: 5 }), { topPercent: 5 });
  assert.deepEqual(normalizeClassRank({ rank: "7" }), { rank: 7 });
  assert.equal(normalizeClassRank({ topPercent: 0 }), null);
  assert.equal(normalizeClassRank({ rank: 500, size: 400 }), null);
  assert.equal(normalizeClassRank({}), null);
  assert.equal(formatClassRank({ rank: 12, size: 400 }), "top 3% (12 of 400)");
  assert.equal(formatClassRank({ topPercent: 5 }), "top 5%");
  assert.equal(formatClassRank({ rank: 7 }), "rank 7");
});

test("the survey form derives a total from sections and round-trips an entry", () => {
  let form = entryToForm({ test: "act", totalScore: 33, sections: { english: 35, math: 31 } });
  assert.equal(form.sections.english, "35");
  assert.equal(form.sections.reading, "");
  form = withSection(withSection(form, "reading", "34"), "science", "32");
  assert.equal(form.totalScore, "33");
  const entry = formToEntry({ ...form, date: "2026-04" });
  assert.deepEqual(entry, { test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32 }, date: "2026-04" });
  // A test without a derivation rule keeps the typed total.
  const duo = withSection(entryToForm({ test: "duolingo", totalScore: 125 }), "literacy", "130");
  assert.equal(duo.totalScore, "125");
});
