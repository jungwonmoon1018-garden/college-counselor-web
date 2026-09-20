import { describe, expect, it } from "vitest";
import { fitProfileFingerprint, fitReadIsStale } from "./fit-refresh.js";

const data = {
  profile: {
    gpa: { unweighted: 3.9 },
    courses: [{ name: "AP Calculus BC", type: "regular", grade: "A" }],
    apScores: [{ exam: "Calculus BC", score: 5 }],
    testScores: [{ test: "sat", totalScore: 1500 }],
  },
  activities: [{ name: "Math Team", category: "science_math", description: "Weekly problem sessions" }],
  majorInterest: "Computer Science",
  chatMemory: { a: 1 },
  documents: [],
};

describe("the College Fit read follows the record", () => {
  it("goes stale when a course, score, activity or major changes", () => {
    const read = fitProfileFingerprint(data);
    expect(fitReadIsStale(read, data)).toBe(false);
    expect(fitReadIsStale(read, { ...data, profile: { ...data.profile, courses: [{ name: "AP Calculus BC", type: "ap", grade: "A" }] } })).toBe(true);
    expect(fitReadIsStale(read, { ...data, profile: { ...data.profile, apScores: [] } })).toBe(true);
    expect(fitReadIsStale(read, { ...data, profile: { ...data.profile, gpa: { unweighted: 3.8 } } })).toBe(true);
    expect(fitReadIsStale(read, { ...data, activities: [{ ...data.activities[0], description: "Qualified for AIME" }] })).toBe(true);
    expect(fitReadIsStale(read, { ...data, majorInterest: "Biology" })).toBe(true);
  });

  it("stays fresh when only chat memory, notes or documents change, and before any read exists", () => {
    const read = fitProfileFingerprint(data);
    expect(fitReadIsStale(read, { ...data, chatMemory: { b: 2 }, documents: [{ name: "x.pdf" }], studyNotes: ["n"] })).toBe(false);
    expect(fitReadIsStale("", data)).toBe(false);
    expect(fitReadIsStale(null, data)).toBe(false);
  });
});
