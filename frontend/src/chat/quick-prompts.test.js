import { describe, expect, it } from "vitest";
import { quickPrompts } from "./quick-prompts.js";

// Mock run, 2026-11-22: a senior majoring in Economics, on a Korean browser,
// was offered "Plan my junior year" and "Search colleges for CS" in English.
describe("quick questions under the chat box", () => {
  it("follow the student's year and major", () => {
    expect(quickPrompts({ grade: 12, major: "Economics" })).toEqual([
      "What's my profile?", "Suggest ECs for me", "Search colleges for Economics", "Plan my senior year",
    ]);
    expect(quickPrompts({ grade: "Sophomore" })[3]).toBe("Plan my sophomore year");
  });

  it("ask for a general fit and this school year when the major or the year is unknown", () => {
    const prompts = quickPrompts({});
    expect(prompts[2]).toBe("Find colleges that fit me");
    expect(prompts[3]).toBe("Plan my school year");
  });

  it("are written in Korean under the Korean locale", () => {
    expect(quickPrompts({ locale: "ko", grade: 12, major: "경제학" })).toEqual([
      "내 프로필 요약해 줘", "나에게 맞는 활동 추천해 줘", "경제학 전공에 맞는 대학 찾아 줘", "12학년 계획 세워 줘",
    ]);
  });
});
