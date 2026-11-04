import { describe, expect, it } from "vitest";
import { formatGpa, hasGpa, normalizeGpa } from "./gpa.js";

// The profile route answers { unweighted: null, weighted: null } for a student
// with no GPA; read as a truthy object it showed as an empty GPA card and as
// "GPA: null" in the profile quick reply.
describe("whether a record holds a GPA", () => {
  it("is false for nothing, and for an object of nulls", () => {
    expect(hasGpa(null)).toBe(false);
    expect(hasGpa(undefined)).toBe(false);
    expect(hasGpa({ unweighted: null, weighted: null })).toBe(false);
    expect(hasGpa({ unweighted: "", weighted: undefined })).toBe(false);
    expect(normalizeGpa({ unweighted: null, weighted: null })).toBe(null);
  });

  it("is true for either part as a number", () => {
    expect(hasGpa({ unweighted: 3.9 })).toBe(true);
    expect(hasGpa({ unweighted: null, weighted: 4.3 })).toBe(true);
    expect(normalizeGpa({ unweighted: "3.90", weighted: null, scale: 4 })).toEqual({ unweighted: 3.9, weighted: null, scale: 4 });
  });

  it("reads a missing GPA as 'not entered', never blank or 'null'", () => {
    expect(formatGpa(null)).toBe("not entered");
    expect(formatGpa({ unweighted: null, weighted: null })).toBe("not entered");
    expect(formatGpa({ unweighted: null, weighted: 4.3 })).toBe("4.3w (unweighted not entered)");
    expect(formatGpa({ unweighted: 3.9 })).toBe("3.9");
    expect(formatGpa({ unweighted: 3.9, weighted: 4.3 })).toBe("3.9 / 4.3w");
  });
});
