import test from "node:test";
import assert from "node:assert/strict";

import { GPA_LIMITS, latestApScoreYear, normalizeSyncInput, previousFromSnapshot } from "../academics/profile-input.js";
import { GPA_LIMITS as FRONTEND_GPA_LIMITS, validateGpa } from "../../frontend/src/profile/gpa.js";
import { latestApScoreYear as clientLatestApScoreYear, validateApEntry } from "../../frontend/src/profile/ap-entry.js";

test("the app's GPA check and the server's agree", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(FRONTEND_GPA_LIMITS)), JSON.parse(JSON.stringify(GPA_LIMITS)));
  // What the app lets through, the server stores; what it refuses, the server sets aside.
  for (const [unweighted, weighted] of [["3.9", ""], ["4.33", "5.8"], ["39", ""], ["95", ""], ["3.9", "6.5"], ["3.9/4.0", ""]]) {
    const app = validateGpa({ unweighted, weighted }).ok;
    const server = normalizeSyncInput({ profile: { gpa: { unweighted, weighted: weighted || null } } }).setAside.length === 0;
    assert.equal(app, server, `unweighted ${unweighted}, weighted ${weighted}`);
  }
});

const VALID = {
  profile: {
    gpa: { unweighted: 3.86, weighted: 4.32 },
    classRank: { rank: 12, size: 400 },
    courses: [{ name: "AP Calculus BC", type: "ap", grade: "A", year: "junior" }],
    testScores: [
      { test: "sat", totalScore: 1520, sections: { readingWriting: 740, math: 780 }, date: "2026-03" },
      { test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32 } },
    ],
    apScores: [{ exam: "Calculus BC", score: 5, year: 2026 }],
  },
  activities: [{ name: "Robotics Club", role: "Captain", hoursPerWeek: 8 }],
  goals: ["Purdue University", { unitId: "243780", name: "Purdue University" }],
  majorInterest: "Computer Science",
};

const PREVIOUS = {
  gpaUnweighted: 3.7,
  gpaWeighted: 4.1,
  courses: [{ name: "Biology", type: "honors", grade: "A-" }],
  activities: [{ name: "Debate" }],
  goals: ["Rice University"],
  majorInterest: "Biology",
};

const reasons = (setAside) => setAside.map((s) => `${s.field}:${s.reason}${s.count ? `:${s.count}` : ""}`).sort();

test("a valid sync passes through unchanged, with nothing set aside", () => {
  const out = normalizeSyncInput(VALID, PREVIOUS);
  assert.deepEqual(out.setAside, []);
  assert.deepEqual(out.profile.gpa, VALID.profile.gpa);
  assert.deepEqual(out.profile.courses, VALID.profile.courses);
  assert.deepEqual(out.profile.testScores, VALID.profile.testScores);
  assert.deepEqual(out.profile.apScores, VALID.profile.apScores);
  assert.deepEqual(out.profile.classRank, VALID.profile.classRank);
  assert.deepEqual(out.activities, VALID.activities);
  assert.deepEqual(out.goals, VALID.goals);
  assert.equal(out.majorInterest, "Computer Science");
});

test("absent fields keep their old meaning: no GPA, empty lists, no major", () => {
  const out = normalizeSyncInput({ profile: { gpa: null } }, PREVIOUS);
  assert.deepEqual(out.setAside, []);
  assert.equal(out.profile.gpa, null);
  assert.deepEqual(out.profile.courses, []);
  assert.deepEqual(out.profile.testScores, []);
  assert.deepEqual(out.profile.apScores, []);
  assert.deepEqual(out.activities, []);
  assert.deepEqual(out.goals, []);
  assert.equal(out.majorInterest, null);
  assert.deepEqual(normalizeSyncInput({}).setAside, []);
});

test("a GPA sent as numeric text is read as the number; one that is not a GPA keeps the stored one", () => {
  // Numeric text used to crash the save (toFixed on a string): a 500.
  assert.deepEqual(normalizeSyncInput({ profile: { gpa: { unweighted: "3.85" } } }, PREVIOUS).profile.gpa, { unweighted: 3.85, weighted: null });

  // A missed decimal and a 100-point average: set aside, the stored GPA stays.
  for (const typed of [39, 95, -1, "3.9/4.0", "A"]) {
    const out = normalizeSyncInput({ profile: { gpa: { unweighted: typed, weighted: 4.2 } } }, PREVIOUS);
    assert.equal(out.profile.gpa.unweighted, 3.7, `unweighted ${typed}`);
    assert.equal(out.profile.gpa.weighted, 4.2);
    assert.deepEqual(reasons(out.setAside), [`gpa.unweighted:${typeof typed === "number" ? "out_of_range" : "not_a_number"}`]);
  }
  // Weighted scales reach 6.0; beyond that is set aside.
  assert.equal(normalizeSyncInput({ profile: { gpa: { unweighted: 3.9, weighted: 5.8 } } }, PREVIOUS).profile.gpa.weighted, 5.8);
  assert.deepEqual(reasons(normalizeSyncInput({ profile: { gpa: { unweighted: 3.9, weighted: 6.5 } } }, PREVIOUS).setAside), ["gpa.weighted:out_of_range"]);
  // With nothing stored, a GPA that is set aside is simply absent; a stored
  // value that is itself out of range (written before these checks) is not
  // brought back.
  assert.equal(normalizeSyncInput({ profile: { gpa: { unweighted: 39 } } }, {}).profile.gpa, null);
  assert.equal(normalizeSyncInput({ profile: { gpa: { unweighted: 39 } } }, { gpaUnweighted: 39 }).profile.gpa, null);
  // A GPA that is not an object keeps the stored one.
  const flat = normalizeSyncInput({ profile: { gpa: 3.9 } }, PREVIOUS);
  assert.deepEqual(flat.profile.gpa, { unweighted: 3.7, weighted: 4.1 });
  assert.deepEqual(reasons(flat.setAside), ["gpa:not_an_object"]);
  assert.deepEqual(GPA_LIMITS, { unweighted: { min: 0, max: 5 }, weighted: { min: 0, max: 6 } });
});

// An AP score's year is kept only when a score from it can exist: not in
// the future, not before the exam was first given (AP Precalculus, 2024).
// An entry with no exam name is dropped (2026-10-09).
test("an AP entry needs an exam name, and its year must be one a score can come from", () => {
  const now = new Date("2026-10-09T00:00:00Z");
  const out = normalizeSyncInput({
    profile: {
      apScores: [
        { score: 5, year: 2025 },
        { exam: "  ", score: 4 },
        { exam: "Precalculus", score: 5, year: 2023 },
        { exam: "AP Precalculus", score: 4, year: 2024 },
        { exam: "Biology", score: 4, year: 2027 },
        { subject: "Chemistry", score: 3, year: 2026 },
      ],
    },
  }, PREVIOUS, { now });
  assert.deepEqual(out.profile.apScores, [
    { exam: "Precalculus", score: 5 },
    { exam: "AP Precalculus", score: 4, year: 2024 },
    { exam: "Biology", score: 4 },
    { subject: "Chemistry", score: 3, year: 2026 },
  ]);
  assert.deepEqual(reasons(out.setAside), ["apScores:invalid_entry:2"]);
});

test("test scores outside the catalog's ranges, AP scores that are not 1-5, and non-object entries are dropped and counted", () => {
  const out = normalizeSyncInput({
    profile: {
      testScores: [
        { test: "sat", totalScore: 1700 },
        { test: "sat", totalScore: 1500, sections: { readingWriting: 700, math: 700 } }, // sections do not add up
        { test: "act", totalScore: 34 },
        { test: "lsat", totalScore: 170 },
      ],
      apScores: [{ exam: "Biology", score: 9 }, { exam: "Chemistry", score: "4", year: 1999 }, "AP Physics 5", { exam: "Statistics", score: 3.5 }],
      courses: [{ name: "Chemistry" }, "Physics", null],
    },
    activities: [{ name: "Band" }, 7],
    goals: ["Purdue University", "", 42],
  }, PREVIOUS);
  assert.deepEqual(out.profile.testScores, [{ test: "act", totalScore: 34 }]);
  // Numeric text is read as the score; a year no score can come from leaves the entry, not the exam.
  assert.deepEqual(out.profile.apScores, [{ exam: "Chemistry", score: 4 }]);
  assert.deepEqual(out.profile.courses, [{ name: "Chemistry" }]);
  assert.deepEqual(out.activities, [{ name: "Band" }]);
  assert.deepEqual(out.goals, ["Purdue University"]);
  assert.deepEqual(reasons(out.setAside), [
    "activities:invalid_entry:1",
    "apScores:invalid_entry:3",
    "courses:invalid_entry:2",
    "goals:invalid_entry:2",
    "testScores:invalid_entry:3",
  ]);
});

test("a list field that is not a list keeps the stored list; a non-object profile is set aside", () => {
  // A courses object crashed the save before (a 500).
  const out = normalizeSyncInput({ profile: { courses: { name: "x" }, testScores: "1500", apScores: 5 }, activities: "Debate", goals: { a: 1 }, majorInterest: 7 }, PREVIOUS);
  assert.deepEqual(out.profile.courses, PREVIOUS.courses);
  assert.deepEqual(out.activities, PREVIOUS.activities);
  assert.deepEqual(out.goals, PREVIOUS.goals);
  assert.equal(out.majorInterest, "Biology");
  assert.deepEqual(out.profile.testScores, []);
  assert.deepEqual(out.profile.apScores, []);
  assert.deepEqual(reasons(out.setAside), [
    "activities:not_a_list",
    "apScores:not_a_list",
    "courses:not_a_list",
    "goals:not_a_list",
    "majorInterest:not_text",
    "testScores:not_a_list",
  ]);
  assert.deepEqual(reasons(normalizeSyncInput({ profile: "3.9" }).setAside), ["profile:not_an_object"]);
});

test("a class rank that reads as nothing is named", () => {
  assert.deepEqual(reasons(normalizeSyncInput({ profile: { classRank: { rank: 500, size: 400 } } }).setAside), ["classRank:out_of_range"]);
  assert.deepEqual(normalizeSyncInput({ profile: { classRank: { topPercent: 5 } } }).setAside, []);
});

test("the stored values are read back from a snapshot row", () => {
  const prev = previousFromSnapshot({
    gpa_unweighted: 3.7, gpa_weighted: null,
    courses_json: '[{"name":"Biology"}]', activities_json: "not json", goals_json: null, major_interest: "Biology",
  });
  assert.deepEqual(prev, { gpaUnweighted: 3.7, gpaWeighted: null, courses: [{ name: "Biology" }], activities: [], goals: [], majorInterest: "Biology", testScores: [], apScores: [], classRank: null });
  const withScores = previousFromSnapshot({
    test_scores_json: '[{"test":"sat","totalScore":1500}]', ap_scores_json: '[{"exam":"Biology","score":5,"year":2026}]', class_rank_json: '{"rank":5,"size":400}',
  });
  assert.deepEqual(withScores.testScores, [{ test: "sat", totalScore: 1500 }]);
  assert.deepEqual(withScores.apScores, [{ exam: "Biology", score: 5, year: 2026 }]);
  assert.deepEqual(withScores.classRank, { rank: 5, size: 400 });
  assert.deepEqual(previousFromSnapshot(undefined), {});
});

// "Set aside" means "keep the stored version": a stale vault copy of a
// score, a score list sent as something else, or a rank typo used to wipe
// what the student already had, and the note never said which entry.
const STORED = {
  ...PREVIOUS,
  testScores: [
    { test: "sat", totalScore: 1500, sections: { readingWriting: 720, math: 780 }, date: "2026-03" },
    { test: "act", totalScore: 33 },
  ],
  apScores: [{ exam: "Biology", score: 5, year: 2026 }, { exam: "Chemistry", score: 4, year: 2025 }],
  classRank: { rank: 5, size: 400 },
};

test("a score list that is not a list, or a rank that reads as nothing, keeps the stored one", () => {
  const out = normalizeSyncInput({ profile: { testScores: "1500", apScores: 5, classRank: { rank: 500, size: 400 } } }, STORED);
  assert.deepEqual(out.profile.testScores, STORED.testScores);
  assert.deepEqual(out.profile.apScores, STORED.apScores);
  assert.deepEqual(out.profile.classRank, { topPercent: 1.3, rank: 5, size: 400 });
  assert.deepEqual(out.setAside.find((s) => s.field === "classRank"), { field: "classRank", reason: "out_of_range", kept: true });
  // With nothing stored the rank is still named, and nothing is invented.
  const fresh = normalizeSyncInput({ profile: { classRank: { rank: 500, size: 400 } } });
  assert.equal(fresh.profile.classRank, null);
  assert.deepEqual(fresh.setAside, [{ field: "classRank", reason: "out_of_range" }]);
  // An absent rank is a clear, not a set-aside.
  assert.equal(normalizeSyncInput({ profile: {} }, STORED).profile.classRank, undefined);
});

test("a bad entry is replaced by its stored twin and named by place, label and reason", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const out = normalizeSyncInput({
    profile: {
      testScores: [
        { test: "sat", totalScore: 1700, date: "2026-03" }, // the stored 1500 stands in
        { test: "act", totalScore: 34 },
        { test: "sat", totalScore: 1700 }, // no stored twin: dropped
      ],
      apScores: [{ exam: "Biology", score: 9, year: 2026 }, { exam: "Chemistry", score: 4, year: 2025 }],
    },
  }, STORED, { now });
  assert.deepEqual(out.profile.testScores, [STORED.testScores[0], { test: "act", totalScore: 34 }]);
  assert.deepEqual(out.profile.apScores, [{ exam: "Biology", score: 5, year: 2026 }, { exam: "Chemistry", score: 4, year: 2025 }]);
  assert.deepEqual(out.setAside, [
    {
      field: "testScores", reason: "invalid_entry", count: 2,
      entries: [
        { index: 0, label: "SAT 1700 (2026-03)", message: "SAT scores must be 400-1600 in steps of 10.", kept: true },
        { index: 2, label: "SAT 1700", message: "SAT scores must be 400-1600 in steps of 10." },
      ],
    },
    {
      field: "apScores", reason: "invalid_entry", count: 1,
      entries: [{ index: 0, label: "AP Biology 9 (2026)", message: "AP scores run 1-5.", kept: true }],
    },
  ]);
});

test("a TOEFL band score typed on the 0-120 scale asks for the scale; an odd date is read or named", () => {
  const out = normalizeSyncInput({
    profile: {
      testScores: [
        { test: "toefl", totalScore: 5 },
        { test: "toefl", scale: "band", totalScore: 5.5 },
        { test: "sat", totalScore: 1450, date: "March 2026" },
        { test: "act", totalScore: 30, date: "spring" },
      ],
    },
  });
  assert.deepEqual(out.profile.testScores, [
    { test: "toefl", totalScore: 5.5, scale: "band" },
    { test: "sat", totalScore: 1450, date: "2026-03" },
    { test: "act", totalScore: 30 },
  ]);
  const scale = out.setAside.find((s) => s.reason === "scale_needed");
  assert.equal(scale.field, "testScores");
  assert.deepEqual(scale.entries.map((e) => [e.index, e.label]), [[0, "TOEFL 5"]]);
  assert.match(scale.entries[0].message, /looks like a TOEFL \(1-6 band\) score/);
  const date = out.setAside.find((s) => s.reason === "date_unreadable");
  assert.deepEqual(date.entries.map((e) => [e.index, e.label]), [[3, "ACT 30 (spring)"]]);
});

// The app refuses an AP year whose scores are not out (they come in July);
// the server used the calendar year, so from January to June it kept a year
// the app refused on the next edit.
test("the server's AP score-year rule matches the app's", () => {
  for (const iso of ["2026-11-03T12:00:00Z", "2027-01-15T12:00:00Z", "2027-03-15T12:00:00Z", "2027-06-15T12:00:00Z", "2027-07-15T12:00:00Z", "2027-12-15T12:00:00Z"]) {
    const now = new Date(iso);
    assert.equal(latestApScoreYear(now), clientLatestApScoreYear(now), iso);
    for (const year of [now.getUTCFullYear() - 1, now.getUTCFullYear()]) {
      const app = validateApEntry({ exam: "Biology", score: 4, year }, { now }).ok;
      const server = normalizeSyncInput({ profile: { apScores: [{ exam: "Biology", score: 4, year }] } }, {}, { now }).profile.apScores[0].year === year;
      assert.equal(server, app, `${iso} year ${year}`);
    }
  }
  const spring = normalizeSyncInput({ profile: { apScores: [{ exam: "Biology", score: 4, year: 2027 }] } }, {}, { now: new Date("2027-03-15T12:00:00Z") });
  assert.deepEqual(spring.profile.apScores, [{ exam: "Biology", score: 4 }]);
});
