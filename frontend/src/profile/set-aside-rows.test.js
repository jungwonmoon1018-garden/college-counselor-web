import { describe, expect, it } from "vitest";
import { setAsideMarkFor, setAsideMarkText, setAsideRowsFrom } from "./set-aside-rows.js";

// Two SAT sittings, the second refused: the save's note named "SAT 1700",
// but the sidebar showed both alike. The mark follows the row's content.
const goodSat = { test: "sat", totalScore: 1450, sections: { readingWriting: 720, math: 730 } };
const badSat = { test: "sat", totalScore: 1700, date: "2026-03" };
const toefl = { test: "toefl", totalScore: 5 };
const ap = { exam: "Biology", score: 7, year: 2025 };
const sent = { testScores: [goodSat, badSat, toefl], apScores: [ap] };
const setAside = [
  { field: "testScores", reason: "invalid_entry", count: 1, entries: [{ index: 1, label: "SAT 1700 (2026-03)", message: "SAT total must be 400-1600.", kept: true }] },
  { field: "testScores", reason: "scale_needed", count: 1, entries: [{ index: 2, label: "TOEFL 5", message: "Pick the TOEFL scale." }] },
  { field: "apScores", reason: "invalid_entry", count: 1, entries: [{ index: 0, label: "AP Biology 7 (2025)", message: "An AP score is 1-5." }] },
  { field: "gpa.weighted", reason: "out_of_range" },
];

describe("set-aside rows", () => {
  it("marks exactly the rows the server named, by content", () => {
    const rows = setAsideRowsFrom(setAside, sent);
    expect(setAsideMarkFor(rows, "testScores", goodSat)).toBeNull();
    expect(setAsideMarkFor(rows, "testScores", { ...badSat })).toMatchObject({ label: "SAT 1700 (2026-03)", kept: true });
    expect(setAsideMarkFor(rows, "apScores", ap)).toMatchObject({ reason: "invalid_entry" });
    // An edited row is no longer the refused one; a field without entries marks nothing.
    expect(setAsideMarkFor(rows, "testScores", { ...badSat, totalScore: 1500 })).toBeNull();
    expect(Object.keys(rows).sort()).toEqual(["apScores", "testScores"]);
  });

  it("says why in English from the server and in Korean from the code", () => {
    const rows = setAsideRowsFrom(setAside, sent);
    const sat = setAsideMarkFor(rows, "testScores", badSat);
    expect(setAsideMarkText(sat, "en-US")).toBe("Not saved: SAT total must be 400-1600. Your saved version is still the one used.");
    expect(setAsideMarkText(sat, "ko")).toBe("저장하지 못했어요: 범위를 벗어났거나 읽을 수 없는 값이에요. 이전에 저장된 값을 그대로 쓰고 있어요.");
    expect(setAsideMarkText(setAsideMarkFor(rows, "testScores", toefl), "ko")).toContain("점수 척도를 골라야 해요");
  });

  it("says an undated score was saved, and ignores places outside the list", () => {
    const rows = setAsideRowsFrom([
      { field: "testScores", reason: "date_unreadable", count: 1, entries: [{ index: 0, label: "SAT 1450", message: "The test date couldn't be read." }] },
      { field: "testScores", reason: "invalid_entry", count: 1, entries: [{ index: 9, label: "?" }] },
    ], sent);
    expect(setAsideMarkText(setAsideMarkFor(rows, "testScores", goodSat), "en-US")).toBe("Saved without its test date: pick the month again.");
    expect(rows.testScores).toHaveLength(1);
  });

  it("a clean save leaves no marks", () => {
    expect(setAsideRowsFrom([], sent)).toEqual({});
    expect(setAsideRowsFrom(undefined, sent)).toEqual({});
  });
});
