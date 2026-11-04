import { describe, expect, it } from "vitest";
import { describeSetAside, syncFailureMessage } from "./sync-result.js";

describe("what the student hears after a profile save", () => {
  it("names the reason a save was refused", () => {
    expect(syncFailureMessage(413)).toMatch(/too large to save/);
    expect(syncFailureMessage(429)).toMatch(/Too many saves in a row/);
    expect(syncFailureMessage(401)).toMatch(/sign in again/);
    expect(syncFailureMessage(503)).toMatch(/isn't available right now/);
    expect(syncFailureMessage(500)).toBe("Your profile didn't reach your counselor — try again.");
    expect(syncFailureMessage(undefined)).toBe("Your profile didn't reach your counselor — try again.");
  });

  it("names what the server set aside, once each, with the right pronoun", () => {
    expect(describeSetAside([])).toBe("");
    expect(describeSetAside(undefined)).toBe("");
    expect(describeSetAside([{ field: "gpa.unweighted", reason: "out_of_range" }]))
      .toBe("Saved, except your GPA, which couldn't be read — check it in your profile.");
    expect(describeSetAside([{ field: "testScores", reason: "invalid_entry", count: 2 }]))
      .toBe("Saved, except 2 test scores, which couldn't be read — check them in your profile.");
    expect(describeSetAside([
      { field: "gpa.unweighted", reason: "out_of_range" },
      { field: "gpa", reason: "not_an_object" },
      { field: "apScores", reason: "invalid_entry", count: 1 },
      { field: "courses", reason: "not_a_list" },
    ])).toBe("Saved, except your GPA, 1 AP score and your course list, which couldn't be read — check them in your profile.");
    expect(describeSetAside([{ field: "somethingNew", reason: "x" }]))
      .toBe("Saved, except one field, which couldn't be read — check it in your profile.");
  });

  // Every auto-save used to repeat "1 test score couldn't be read" without
  // saying which one, and only in English.
  const NAMED = [
    {
      field: "testScores", reason: "invalid_entry", count: 1,
      entries: [{ index: 0, label: "SAT 1700 (2026-03)", message: "SAT scores must be 400-1600 in steps of 10.", kept: true }],
    },
    { field: "testScores", reason: "scale_needed", count: 1, entries: [{ index: 2, label: "TOEFL 5", message: "A TOEFL score of 5 looks like a TOEFL (1-6 band) score." }] },
  ];

  it("names each set-aside entry, why, and whether the saved version was kept", () => {
    expect(describeSetAside(NAMED, { locale: "en-US" })).toBe(
      "Saved, except SAT 1700 (2026-03) (SAT scores must be 400-1600 in steps of 10; your saved version was kept); "
      + "TOEFL 5 (A TOEFL score of 5 looks like a TOEFL (1-6 band) score). Fix them in your profile, or remove them.",
    );
    expect(describeSetAside([{ field: "classRank", reason: "out_of_range", kept: true }, NAMED[0]], { locale: "en-US" }))
      .toBe("Saved, except your class rank (it couldn't be read; your saved version was kept); SAT 1700 (2026-03) (SAT scores must be 400-1600 in steps of 10; your saved version was kept). Fix them in your profile, or remove them.");
  });

  it("says it in Korean for a Korean-UI student", () => {
    const note = describeSetAside(NAMED, { locale: "ko" });
    expect(note).toBe("저장했어요. 다만 다음 항목은 저장하지 못했어요: SAT 1700 (2026-03): 범위를 벗어났거나 읽을 수 없는 값이에요 — 이전에 저장된 값을 그대로 두었어요; TOEFL 5: 점수 척도를 골라야 해요 (0-120 점수인지 1-6 밴드 점수인지). 프로필에서 고치거나 지워 주세요.");
    expect(describeSetAside([{ field: "gpa.weighted", reason: "out_of_range" }], { locale: "ko" }))
      .toBe("저장했어요. 다만 다음 항목은 저장하지 못했어요: 가중 GPA: 범위를 벗어난 값이에요. 프로필에서 고치거나 지워 주세요.");
    expect(describeSetAside([], { locale: "ko" })).toBe("");
  });
});
