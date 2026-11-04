import test from "node:test";
import assert from "node:assert/strict";

import {
  TEST_CATALOG,
  deriveTotal,
  sectionEntries,
  formatSections,
  validateTestEntry,
  normalizeTestScores,
  normalizeTestDate,
  entryLabel,
  acceptedTotals,
  normalizeClassRank,
  formatClassRank,
} from "../academics/test-catalog.js";
import * as frontendScores from "../../frontend/src/profile/test-scores.js";
import { TEST_CATALOG as FRONTEND_CATALOG, TEST_SCORE_LIMITS, withSection, withScale, formToEntry, entryToForm, scoreLimits, scaleChoices } from "../../frontend/src/profile/test-scores.js";

test("the frontend catalog is a mirror of the backend one", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(FRONTEND_CATALOG)), JSON.parse(JSON.stringify(TEST_CATALOG)));
  assert.equal(TEST_SCORE_LIMITS.sat.label, "400-1600");
  assert.equal(TEST_SCORE_LIMITS.ielts.label, "0-9.0");
});

test("totals derive from sections the way each test scores", () => {
  assert.equal(deriveTotal("sat", { readingWriting: 720, math: 780 }), 1500);
  assert.equal(deriveTotal("psat", { readingWriting: 690, math: 690 }), 1380);
  // ACT: the enhanced composite is the rounded mean of English, Math and
  // Reading; Science and Writing never count. A sitting dated before April
  // 2025 averaged all four.
  assert.equal(deriveTotal("act", { english: 35, math: 31, reading: 34, science: 32, writing: 9 }), 33);
  assert.equal(deriveTotal("act", { english: 35, math: 36, reading: 34, science: 28 }), 35);
  assert.equal(deriveTotal("act", { english: 34, math: 33, reading: 34 }), 34); // 33.67 rounds up
  assert.equal(deriveTotal("act", { english: 34, math: 33, reading: 34, science: 33 }, { date: "2024-06" }), 34); // 33.5 rounds up
  assert.equal(deriveTotal("act", { english: 35, math: 36, reading: 34, science: 28 }, { date: "2024-06" }), 33);
  assert.equal(deriveTotal("act", { english: 35, math: 36, reading: 34 }, { date: "2024-06" }), null);
  assert.equal(deriveTotal("act", { english: 34, math: 33 }), null);
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

// The enhanced ACT (online from April 2025, every national date from
// September 2025) averages English, Math and Reading; Science is reported
// on its own. The form used to average all four, auto-fill a 35 as 33 and
// then refuse the real 35, and the server set the entry aside.
test("the enhanced ACT composite is accepted, and the legacy four-section one still is", () => {
  const sections = { english: 35, math: 36, reading: 34, science: 28 };
  assert.deepEqual(validateTestEntry({ test: "act", totalScore: 35, sections }), { ok: true, errors: [] });
  assert.equal(validateTestEntry({ test: "act", totalScore: 33, sections }).ok, true); // the pre-2025 mean, undated
  const wrong = validateTestEntry({ test: "act", totalScore: 31, sections });
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors[0], /English, Math, Reading average to 35 \(33 with Science, as the ACT counted it before April 2025\), not 31/);
  // A sitting dated before April 2025 is held to the four-section mean only.
  assert.equal(validateTestEntry({ test: "act", totalScore: 33, sections, date: "2024-06" }).ok, true);
  assert.match(validateTestEntry({ test: "act", totalScore: 35, sections, date: "2024-06" }).errors[0], /English, Math, Reading, Science average to 33, not 35/);
  assert.deepEqual(acceptedTotals("act", sections), [35, 33]);
  assert.deepEqual(acceptedTotals("act", sections, { date: "2024-06" }), [33]);
  // The server stores it rather than setting it aside.
  assert.deepEqual(normalizeTestScores([{ test: "act", totalScore: 35, sections, date: "2026-09" }]), [
    { test: "act", totalScore: 35, sections, date: "2026-09" },
  ]);
  assert.deepEqual(normalizeTestScores([{ test: "act", sections }]), [{ test: "act", totalScore: 35, sections }]);
});

test("the ACT form fills the enhanced composite and keeps a typed legacy one", () => {
  const fill = (form) => ["english", "math", "reading", "science"].reduce((f, key, i) => withSection(f, key, ["35", "36", "34", "28"][i]), form);
  assert.equal(fill(entryToForm({ test: "act" })).totalScore, "35");
  assert.equal(fill({ ...entryToForm({ test: "act" }), date: "2024-06" }).totalScore, "33");
  // A student who typed her real composite first keeps it when a format
  // yields it, and an inconsistent one is refilled.
  assert.equal(fill({ ...entryToForm({ test: "act" }), totalScore: "33" }).totalScore, "33");
  assert.equal(fill({ ...entryToForm({ test: "act" }), totalScore: "30" }).totalScore, "35");
  const entry = formToEntry(fill(entryToForm({ test: "act" })));
  assert.equal(frontendScores.validateTestEntry(entry).ok, true);
});

// From January 2026 TOEFL iBT reports a 1-6 band in half steps beside the
// 0-120 score. A band 5 used to be stored as 5 of 120 and a 5.5 refused.
test("the TOEFL band scale is its own scale, and a bare low total asks for it", () => {
  assert.deepEqual(validateTestEntry({ test: "toefl", scale: "band", totalScore: 5.5 }), { ok: true, errors: [] });
  const bandSections = { reading: 6, listening: 5.5, speaking: 5, writing: 5.5 };
  assert.equal(validateTestEntry({ test: "toefl", scale: "band", totalScore: 5.5, sections: bandSections }).ok, true);
  assert.match(validateTestEntry({ test: "toefl", scale: "band", totalScore: 4, sections: bandSections }).errors[0], /average to 5.5, not 4/);
  assert.match(validateTestEntry({ test: "toefl", scale: "band", totalScore: 6.5 }).errors[0], /TOEFL \(1-6 band\) scores must be 1-6 in steps of 0.5/);
  const bare = validateTestEntry({ test: "toefl", totalScore: 5 });
  assert.equal(bare.ok, false);
  assert.equal(bare.reason, "scale_needed");
  assert.match(bare.errors[0], /looks like a TOEFL \(1-6 band\) score/);
  assert.match(validateTestEntry({ test: "toefl", totalScore: 5.5 }).errors[0], /TOEFL scores must be 0-120/);
  assert.equal(validateTestEntry({ test: "toefl", totalScore: 100 }).ok, true);
  assert.match(validateTestEntry({ test: "toefl", scale: "bogus", totalScore: 100 }).errors[0], /Unknown TOEFL scale/);
  assert.equal(entryLabel({ test: "toefl", scale: "band", totalScore: 5.5 }), "TOEFL (1-6 band)");
  assert.equal(entryLabel({ test: "toefl", totalScore: 100 }), "TOEFL");
  assert.equal(formatSections({ test: "toefl", scale: "band", sections: { reading: 5.5, listening: 6 } }), "Reading 5.5, Listening 6");
  // Stored with its scale; a bare 5 or an unknown scale is not stored.
  assert.deepEqual(normalizeTestScores([
    { test: "toefl", scale: "band", totalScore: "5.5" },
    { test: "toefl", totalScore: 5 },
    { test: "toefl", scale: "bogus", totalScore: 100 },
  ]), [{ test: "toefl", totalScore: 5.5, scale: "band" }]);
});

test("PSAT 8/9 is accepted on its own 240-1440 scale", () => {
  assert.equal(validateTestEntry({ test: "psat", scale: "8/9", totalScore: 300, sections: { readingWriting: 150, math: 150 } }).ok, true);
  assert.equal(validateTestEntry({ test: "psat", scale: "8/9", totalScore: 900, sections: { readingWriting: 450, math: 450 } }).ok, true);
  assert.match(validateTestEntry({ test: "psat", scale: "8/9", totalScore: 230 }).errors[0], /PSAT 8\/9 scores must be 240-1440/);
  assert.match(validateTestEntry({ test: "psat", totalScore: 300 }).errors[0], /PSAT scores must be 320-1520/);
  assert.equal(entryLabel({ test: "psat", scale: "8/9" }), "PSAT 8/9");
  assert.deepEqual(normalizeTestScores([{ test: "psat", scale: "8/9", sections: { readingWriting: 150, math: 150 } }]), [
    { test: "psat", totalScore: 300, scale: "8/9", sections: { readingWriting: 150, math: 150 } },
  ]);
});

test("the survey form carries the scale and offers the choices", () => {
  assert.deepEqual(scaleChoices("toefl").map((c) => c.value), ["", "band"]);
  assert.deepEqual(scaleChoices("psat").map((c) => c.value), ["", "8/9"]);
  assert.deepEqual(scaleChoices("sat"), []);
  assert.equal(scoreLimits("toefl", "band").max, 6);
  assert.equal(scoreLimits("toefl").max, 120);
  let form = withScale(entryToForm({ test: "toefl" }), "band");
  form = ["reading", "listening", "speaking", "writing"].reduce((f, key, i) => withSection(f, key, ["6", "5.5", "5", "5.5"][i]), form);
  assert.equal(form.totalScore, "5.5");
  const entry = formToEntry(form);
  assert.deepEqual(entry, { test: "toefl", totalScore: 5.5, scale: "band", sections: { reading: 6, listening: 5.5, speaking: 5, writing: 5.5 } });
  assert.equal(entryToForm(entry).scale, "band");
  assert.equal(frontendScores.validateTestEntry(entry).ok, true);
});

// Older builds and hand-written requests sent other date spellings, and the
// date vanished without a word.
test("test dates in common spellings are kept by month", () => {
  assert.equal(normalizeTestDate("2026-03"), "2026-03");
  assert.equal(normalizeTestDate("2026-3"), "2026-03");
  assert.equal(normalizeTestDate("2026/03/14"), "2026-03");
  assert.equal(normalizeTestDate("3/2026"), "2026-03");
  assert.equal(normalizeTestDate("March 2026"), "2026-03");
  assert.equal(normalizeTestDate("Sept. 2025"), "2025-09");
  assert.equal(normalizeTestDate("2026년 3월"), "2026-03");
  assert.equal(normalizeTestDate(""), "");
  assert.equal(normalizeTestDate("March"), null);
  assert.equal(normalizeTestDate("2026-13"), null);
  assert.equal(normalizeTestDate("Smarch 2026"), null);
  assert.deepEqual(normalizeTestScores([{ test: "sat", totalScore: 1500, date: "March 2026" }]), [{ test: "sat", totalScore: 1500, date: "2026-03" }]);
});

// The client validates with its own copy; the two must agree on every case,
// not only on the catalog data.
test("the frontend validator agrees with the backend one", () => {
  const cases = [
    { test: "act", totalScore: 35, sections: { english: 35, math: 36, reading: 34, science: 28 } },
    { test: "act", totalScore: 31, sections: { english: 35, math: 36, reading: 34, science: 28 } },
    { test: "act", totalScore: 35, sections: { english: 35, math: 36, reading: 34, science: 28 }, date: "2024-06" },
    { test: "toefl", totalScore: 5 },
    { test: "toefl", scale: "band", totalScore: 5.5 },
    { test: "psat", scale: "8/9", totalScore: 300 },
    { test: "psat", totalScore: 300 },
    { test: "sat", totalScore: 1500, sections: { readingWriting: 720, math: 790 } },
  ];
  for (const entry of cases) assert.deepEqual(frontendScores.validateTestEntry(entry), validateTestEntry(entry), JSON.stringify(entry));
});
