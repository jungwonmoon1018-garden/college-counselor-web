// A course graded by semester reaches every reader as two rows: the
// transcript import now keeps both (it used to drop the spring grade), so
// the fidelity check, the profile block and the rigor read must each take
// the pair as one course with two true grades. And a TOEFL band score or a
// PSAT 8/9 score stored under its test's key must not be read as a wrong
// score of the test's own scale.
import test from "node:test";
import assert from "node:assert/strict";

import { checkProfileFidelity, formatProfileForModel } from "../chat/chat-grounding.js";
import { readCourseRigor } from "../academics/course-rigor.js";
import { sanitizeParsedTranscript } from "../academics/transcript-import.js";

const kinds = (text, profile) => checkProfileFidelity(text, profile).contradictions.map((c) => `${c.kind}:${c.stated}`);

test("a semester pair from the import reaches the fidelity check as one course with two true grades", () => {
  const imported = sanitizeParsedTranscript({
    years: { junior: [
      { name: "AP Biology", type: "ap", grade: "A", semester: "fall" },
      { name: "AP Biology", type: "ap", grade: "B", semester: "spring" },
    ] },
  });
  const profile = { courses: imported.years.junior.map((c) => ({ ...c, year: "junior" })) };
  assert.equal(profile.courses.length, 2);
  // Either semester's grade is true; a grade neither holds is not.
  assert.deepEqual(kinds("Your A in AP Biology shows real strength.", profile), []);
  assert.deepEqual(kinds("Your B in AP Biology this spring is fine.", profile), []);
  assert.deepEqual(kinds("Your C in AP Biology needs work.", profile), ["course_grade:C"]);
  // The profile block shows both terms.
  const block = formatProfileForModel(profile);
  assert.match(block, /AP Biology — AP — grade A \(fall semester\)/);
  assert.match(block, /AP Biology — AP — grade B \(spring semester\)/);
  // And the rigor read counts one AP.
  assert.equal(readCourseRigor(profile.courses, []).apCourses, 1);
});

test("a TOEFL band score and a PSAT 8/9 score are not read as wrong scores of the base scale", () => {
  const band = { testScores: [{ test: "toefl", scale: "band", totalScore: 5.5 }] };
  assert.deepEqual(kinds("Your TOEFL 5.5 is strong.", band), []);
  assert.deepEqual(kinds("Your TOEFL score of 100 is strong.", band), ["toefl:100"]);
  const psat89 = { testScores: [{ test: "psat", scale: "8/9", totalScore: 900 }] };
  assert.deepEqual(kinds("Your PSAT 8/9 score of 900 is a good start.", psat89), []);
});
