import { describe, it, expect } from "vitest";
import { looksLikeTranscript, currentYearKey, mergeImportedCourses, summarizeParsedTranscript } from "./transcript-utils.js";

const TRANSCRIPT = `Official Transcript — Springfield High School
Student: [redacted]   Grade Level: 11   Cumulative GPA: 3.82
Semester 1 2026-27
AP English Language and Composition    B+
AP Statistics                          A
AP Physics C: Mechanics                B
AP Calculus BC                         IP
Credits earned: 3.0`;

describe("looksLikeTranscript", () => {
  it("recognizes a transcript by keyword plus graded lines", () => {
    expect(looksLikeTranscript(TRANSCRIPT)).toBe(true);
  });
  it("does not fire on an essay that merely mentions a transcript", () => {
    expect(looksLikeTranscript("My transcript shows growth, but the story behind it is about my grandmother's garden and the summer I spent learning to listen. ".repeat(3))).toBe(false);
    expect(looksLikeTranscript("")).toBe(false);
  });
});

describe("currentYearKey", () => {
  it("maps every stored grade-level form", () => {
    expect(currentYearKey("11")).toBe("junior");
    expect(currentYearKey(9)).toBe("freshman");
    expect(currentYearKey("Sophomore")).toBe("sophomore");
    expect(currentYearKey("12th")).toBe("senior");
    expect(currentYearKey("")).toBe(null);
  });
});

describe("mergeImportedCourses", () => {
  const existing = [{ name: "AP Statistics", type: "ap", grade: "A", year: "junior" }];
  const parsed = {
    freshman: [], sophomore: [],
    junior: [
      { name: "AP Statistics", type: "ap", grade: "A", semester: "full_year" },
      { name: "AP English Language and Composition", type: "ap", grade: "B+", semester: "full_year" },
      { name: "AP Calculus BC", type: "ap", grade: null, semester: "full_year" },
    ],
    senior: [],
    unknown: [{ name: "Health", type: "elective", grade: null, semester: "fall" }],
  };
  it("adds new courses, skips duplicates, stores a missing grade as in progress, and places unknown years in the current year", () => {
    const merged = mergeImportedCourses(existing, parsed, { fallbackYear: "junior" });
    expect(merged.added).toBe(3);
    expect(merged.skipped).toBe(1);
    expect(merged.unplaced).toBe(0);
    expect(merged.courses.find((c) => c.name === "AP Calculus BC").grade).toBe("IP");
    expect(merged.courses.find((c) => c.name === "Health").year).toBe("junior");
    expect(merged.courses.find((c) => c.name === "Health").semester).toBe("fall");
  });
  it("leaves unknown-year courses out when the current year is unknown", () => {
    const merged = mergeImportedCourses([], parsed, { fallbackYear: null });
    expect(merged.unplaced).toBe(1);
    expect(merged.added).toBe(3);
  });
  it("summarizes parsed years for display with in-progress grades", () => {
    const groups = summarizeParsedTranscript(parsed);
    expect(groups.map((g) => g.year)).toEqual(["junior", "unknown"]);
    expect(groups[0].courses[2]).toEqual({ name: "AP Calculus BC", type: "ap", grade: "IP" });
  });
});
