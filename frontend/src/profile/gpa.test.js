import { describe, expect, it } from "vitest";
import { GPA_LIMITS, computeGpaFromCourses, gpaNumber, gpaReplacementQuestion, validateGpa } from "./gpa.js";

describe("GPA input", () => {
  it("accepts a GPA on a 4.0, 4.3 or 5.0 scale and a weighted GPA up to 6", () => {
    for (const unweighted of ["3.75", "4.0", "4.33", "5", 0, "0"]) expect(validateGpa({ unweighted }).ok).toBe(true);
    expect(validateGpa({ unweighted: "3.9", weighted: "5.8" }).ok).toBe(true);
    expect(GPA_LIMITS).toEqual({ unweighted: { min: 0, max: 5 }, weighted: { min: 0, max: 6 } });
  });

  it("refuses a missed decimal and a 100-point average, with a sentence the student can act on", () => {
    for (const unweighted of ["39", "95", "100", "5.01"]) {
      const check = validateGpa({ unweighted });
      expect(check.ok).toBe(false);
      expect(check.errors[0]).toMatch(/^An unweighted GPA is between 0 and 5, like 3\.75\./);
    }
    expect(validateGpa({ unweighted: "3.9", weighted: "6.5" }).errors).toEqual(["A weighted GPA is between 0 and 6. Leave it blank if you're not sure."]);
  });

  it("refuses text that is not a number, and leaves blank fields to the caller", () => {
    expect(validateGpa({ unweighted: "3.9/4.0" }).errors).toEqual(["Enter your GPA as a number, like 3.75."]);
    expect(validateGpa({ unweighted: "A-" }).ok).toBe(false);
    expect(validateGpa({ unweighted: "3.9", weighted: "high" }).errors).toEqual(["Enter your weighted GPA as a number, like 4.20, or leave it blank."]);
    expect(validateGpa({ unweighted: "", weighted: "  " }).ok).toBe(true);
    expect(validateGpa({}).ok).toBe(true);
  });

  it("reads numbers and numeric text, nothing else", () => {
    expect(gpaNumber("3.85")).toBe(3.85);
    expect(gpaNumber(" 4 ")).toBe(4);
    expect(gpaNumber(3.7)).toBe(3.7);
    expect(gpaNumber("3.9/4.0")).toBe(null);
    expect(gpaNumber("")).toBe(null);
    expect(gpaNumber(Number.NaN)).toBe(null);
  });
});

// Mock run, 2026-11-22: "Calculate GPA from courses" replaced the
// transcript's GPA with its own average in one click.
describe("the GPA calculated from courses", () => {
  it("counts a semester entry as half a course and leaves ungraded rows out", () => {
    const gpa = computeGpaFromCourses([
      { name: "World History", grade: "A", semester: "fall" },
      { name: "World History", grade: "B", semester: "spring" },
      { name: "AP Biology", type: "ap", grade: "A", semester: "full_year" },
      { name: "Library Aide", grade: "", semester: "full_year" },
      { name: "French III", grade: "IP", semester: "full_year" },
    ]);
    // (4.0×0.5 + 3.0×0.5 + 4.0) / 2 = 3.75; weighted adds 1.0 for the AP course.
    expect(gpa).toEqual({ unweighted: 3.75, weighted: 4.25, count: 3 });
    expect(computeGpaFromCourses([{ name: "TA", grade: "" }])).toBe(null);
  });

  it("asks before it replaces a saved GPA, showing both, and not when nothing changes", () => {
    const computed = { unweighted: 3.72, weighted: 4.05, count: 18 };
    const question = gpaReplacementQuestion({ unweighted: 3.8, weighted: 4.2 }, computed);
    expect(question).toMatch(/^Replace your saved GPA \(3\.8 \/ 4\.2w\) with 3\.72 \/ 4\.05w, the average of 18 graded course entries\?/);
    expect(question).toMatch(/The GPA your school prints on your transcript is the one colleges read/);
    expect(gpaReplacementQuestion({ unweighted: 3.72, weighted: 4.05 }, computed)).toBe(null);
    expect(gpaReplacementQuestion({ unweighted: null, weighted: null }, computed)).toBe(null);
    expect(gpaReplacementQuestion(undefined, computed)).toBe(null);
  });
});
