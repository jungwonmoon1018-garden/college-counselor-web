import test from "node:test";
import assert from "node:assert/strict";

import { GPA_LIMITS, normalizeSyncInput, previousFromSnapshot } from "../academics/profile-input.js";

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
  // Numeric text is read as the score; a year outside 2000-2100 leaves the entry, not the exam.
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
  assert.deepEqual(prev, { gpaUnweighted: 3.7, gpaWeighted: null, courses: [{ name: "Biology" }], activities: [], goals: [], majorInterest: "Biology" });
  assert.deepEqual(previousFromSnapshot(undefined), {});
});
