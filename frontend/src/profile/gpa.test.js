import { describe, expect, it } from "vitest";
import { GPA_LIMITS, gpaNumber, validateGpa } from "./gpa.js";

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
