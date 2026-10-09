import { describe, expect, it } from "vitest";
import { AP_FIRST_EXAM_YEAR, apExamsWithScores, latestApScoreYear, validateApEntry } from "./ap-entry.js";

// One check for an AP score in the survey and the sidebar: the survey took
// any year and the same exam and year twice.
describe("validateApEntry", () => {
  const OCT_2026 = new Date(2026, 9, 9);
  const MAR_2027 = new Date(2027, 2, 1);
  const AUG_2027 = new Date(2027, 7, 1);

  it("takes an exam, a whole score 1-5 and a year whose scores are out", () => {
    expect(validateApEntry({ exam: "Calculus BC", score: "5", year: "2026" }, { now: OCT_2026 }))
      .toEqual({ ok: true, entry: { exam: "Calculus BC", score: 5, year: 2026 } });
    expect(validateApEntry({ exam: "", score: 5, year: 2026 }, { now: OCT_2026 }).error).toBe("Pick the AP exam.");
    expect(validateApEntry({ exam: "Biology", score: 6, year: 2026 }, { now: OCT_2026 }).error).toBe("AP scores run 1-5.");
    expect(validateApEntry({ exam: "Biology", score: "4.5", year: 2026 }, { now: OCT_2026 }).error).toBe("AP scores run 1-5.");
    // Scores come out in July: in March 2027 the latest is 2026.
    expect(latestApScoreYear(MAR_2027)).toBe(2026);
    expect(latestApScoreYear(AUG_2027)).toBe(2027);
    expect(validateApEntry({ exam: "Biology", score: 4, year: 2027 }, { now: MAR_2027 }).error)
      .toBe("Enter the year you took the exam, 2000–2026. Scores come out in July.");
    expect(validateApEntry({ exam: "Biology", score: 4, year: "" }, { now: OCT_2026 }).ok).toBe(false);
    expect(validateApEntry({ exam: "Biology", score: 4, year: "20255" }, { now: OCT_2026 }).ok).toBe(false);
    expect(validateApEntry({ exam: "Biology", score: 4, year: 1999 }, { now: OCT_2026 }).ok).toBe(false);
  });

  it("knows when the newest exams were first given", () => {
    expect(validateApEntry({ exam: "Precalculus", score: 5, year: 2023 }, { now: OCT_2026 }).error)
      .toBe("Enter the year you took the exam, 2024–2026. Scores come out in July.");
    expect(validateApEntry({ exam: "AP Precalculus", score: 5, year: 2024 }, { now: OCT_2026 }).ok).toBe(true);
    expect(validateApEntry({ exam: "Cybersecurity", score: 5, year: 2026 }, { now: OCT_2026 }).error)
      .toBe("AP Cybersecurity is first given in May 2027, with scores that July.");
    expect(validateApEntry({ exam: "Cybersecurity", score: 5, year: 2027 }, { now: AUG_2027 }).ok).toBe(true);
    // The pickers list the two new exams once their scores can exist.
    expect(apExamsWithScores(OCT_2026)).not.toContain("Cybersecurity");
    expect(apExamsWithScores(OCT_2026)).not.toContain("Business with Personal Finance");
    expect(apExamsWithScores(AUG_2027)).toEqual(expect.arrayContaining(["Cybersecurity", "Business with Personal Finance"]));
    expect(Object.keys(AP_FIRST_EXAM_YEAR).every((name) => apExamsWithScores(AUG_2027).includes(name))).toBe(true);
  });

  it("refuses the same exam and year twice and keeps a retake", () => {
    const others = [{ exam: "Calculus AB", score: 3, year: 2025 }];
    expect(validateApEntry({ exam: "Calculus AB", score: 4, year: 2025 }, { others, now: OCT_2026 }).error)
      .toBe("AP Calculus AB (2025) is already on your list.");
    expect(validateApEntry({ exam: "AP Calculus AB", score: 4, year: 2025 }, { others, now: OCT_2026 }).ok).toBe(false);
    expect(validateApEntry({ exam: "Calculus AB", score: 4, year: 2026 }, { others, now: OCT_2026 }).ok).toBe(true);
    // The survey's own rows name the exam `subject`.
    expect(validateApEntry({ exam: "Biology", score: 4, year: 2026 }, { others: [{ subject: "Biology", year: "2026" }], now: OCT_2026 }).ok).toBe(false);
  });
});
