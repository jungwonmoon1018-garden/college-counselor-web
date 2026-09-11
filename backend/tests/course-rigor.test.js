// Course rigor as the College Fit machinery reads it: a course's level from
// its type or its name, AP exams as APs taken, exam scores as weight.
import test from "node:test";
import assert from "node:assert/strict";

import { courseLevel, describeCourseRigor, normalizeApSubject, readCourseRigor } from "../course-rigor.js";

test("a course's level comes from its type, or from its name when the type does not say", () => {
  assert.equal(courseLevel({ name: "Calculus BC", type: "ap" }), "ap");
  assert.equal(courseLevel({ name: "AP Calculus BC", type: "regular" }), "ap");
  assert.equal(courseLevel({ name: "Advanced Placement Biology" }), "ap");
  assert.equal(courseLevel({ name: "IB Chemistry HL" }), "ib");
  assert.equal(courseLevel({ name: "Honors English 10" }), "honors");
  assert.equal(courseLevel({ name: "Dual Enrollment Calculus" }), "dual_enrollment");
  assert.equal(courseLevel({ name: "Statistics", type: "de" }), "dual_enrollment");
  assert.equal(courseLevel({ name: "Mathematics", type: "A-Level" }), "a_level");
  // A name is read at a prefix or a whole word, never inside another word.
  assert.equal(courseLevel({ name: "Apparel Design" }), null);
  assert.equal(courseLevel({ name: "Liberal Arts" }), null);
  assert.equal(courseLevel({ name: "English 11", type: "regular" }), null);
  assert.equal(courseLevel(null), null);
});

test("an AP exam and an AP course name the same subject however they are written", () => {
  assert.equal(normalizeApSubject("AP Physics C: Mechanics"), "physics c mechanics");
  assert.equal(normalizeApSubject("Calculus BC"), normalizeApSubject("AP Calculus BC"));
  assert.equal(normalizeApSubject("Advanced Placement Biology exam"), "biology");
});

test("the load counts college-level courses by type or name, AP exams no course names, and weighs each AP by its score", () => {
  const rigor = readCourseRigor([
    { name: "AP Calculus BC", type: "regular", grade: "A", year: "11" },
    { name: "Physics C", type: "ap", grade: "A", year: "12" },
    { name: "Multivariable Calculus", type: "dual_enrollment", grade: "A", year: "12" },
    { name: "Honors English 10", type: "regular", grade: "A", year: "10" },
    { name: "Spanish 3", type: "regular", grade: "B", year: "11" },
  ], [
    { exam: "Calculus BC", score: 5 },
    { exam: "Physics C: Mechanics", score: 3 },
    { exam: "Computer Science A", score: 4 },
    { exam: "Calculus AB", score: 2 },
  ]);
  assert.equal(rigor.apCourses, 2);
  // Two exams match no listed course (Computer Science A, and Calculus AB
  // is not Calculus BC), so they are APs taken all the same.
  assert.equal(rigor.apExamsWithoutCourse, 2);
  assert.equal(rigor.apTaken, 4);
  assert.equal(rigor.apScored, 4);
  assert.equal(rigor.dualEnrollment, 1);
  assert.equal(rigor.honors, 1);
  assert.equal(rigor.collegeLevelCourses, 3);
  assert.equal(rigor.seniorCollegeLevel, 2);
  // 5 → 1.2, 3 → 1.0, dual enrollment 1, honors 0.5, 4 → 1.1, 2 → 0.8.
  assert.equal(rigor.units, 5.6);
  assert.deepEqual(rigor.items.map((i) => [i.name, i.level, i.source, i.examScore, i.weight]), [
    ["AP Calculus BC", "ap", "course", 5, 1.2],
    ["Physics C", "ap", "course", 3, 1],
    ["Multivariable Calculus", "dual_enrollment", "course", null, 1],
    ["Honors English 10", "honors", "course", null, 0.5],
    ["Computer Science A", "ap", "exam", 4, 1.1],
    ["Calculus AB", "ap", "exam", 2, 0.8],
  ]);
  // Honors alone is a load of half a unit each, never college-level.
  const honorsOnly = readCourseRigor([{ name: "Honors Biology", type: "honors" }, { name: "Honors Geometry", type: "regular" }], []);
  assert.equal(honorsOnly.honors, 2);
  assert.equal(honorsOnly.units, 1);
  assert.equal(honorsOnly.collegeLevelCourses, 0);
  assert.equal(honorsOnly.apTaken, 0);
  assert.equal(describeCourseRigor(honorsOnly), "2 honors");
  assert.equal(describeCourseRigor(rigor), "4 AP (4 with exam scores), 1 dual enrollment, 1 honors");
});

test("an exam is matched to one course only, and an empty record reads as no load", () => {
  const twice = readCourseRigor([{ name: "AP Biology", type: "ap" }, { name: "AP Biology", type: "ap" }], [{ exam: "Biology", score: 5 }]);
  assert.equal(twice.apCourses, 2);
  assert.equal(twice.apScored, 1);
  assert.equal(twice.units, 2.2);
  const empty = readCourseRigor([], []);
  assert.equal(empty.units, 0);
  assert.equal(empty.apTaken, 0);
  assert.equal(describeCourseRigor(empty), "");
  // A score outside 1–5 is an exam taken without a usable result.
  const unscored = readCourseRigor([], [{ exam: "Chemistry", score: "pending" }]);
  assert.equal(unscored.apTaken, 1);
  assert.equal(unscored.apScored, 0);
  assert.equal(unscored.units, 1);
});
