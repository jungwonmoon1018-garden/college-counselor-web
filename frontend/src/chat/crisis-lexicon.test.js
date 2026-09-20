import { describe, it, expect } from "vitest";
import { isCrisisStatement, isDistressed, withSupport, SUPPORT_FOOTER, CRISIS_STRICT_RE, IDEATION_RE } from "./crisis-lexicon.js";

describe("crisis statements", () => {
  it("catches explicit self-harm, abuse, and danger", () => {
    for (const text of [
      "I want to kill myself",
      "i dont want to be alive anymore",
      "my dad hits me when I fail a test",
      "I am being abused at home",
      "someone is threatening to hurt me",
      "I'm not safe at home",
      "there's no point in going on",
      "everyone would be better off without me",
    ]) expect(isCrisisStatement(text), text).toBe(true);
  });
  it("does not fire on topic words or academic stress", () => {
    for (const text of [
      "How should I end my personal statement?",
      "I volunteer in the hospital emergency department",
      "I'm hopeless at chemistry and my application feels hopeless",
      "I want to kill this essay draft and start over",
      "I'm so overwhelmed with APs, what should I drop?",
      "my research is on child abuse prevention policy",
      "the danger of procrastination",
      "I'm dying to get into MIT",
    ]) expect(isCrisisStatement(text), text).toBe(false);
    expect(CRISIS_STRICT_RE.test("hopeless")).toBe(false);
    expect(IDEATION_RE.test("I give up on this essay")).toBe(false);
  });
});

describe("distress footer", () => {
  it("marks ordinary stress and appends the footer once", () => {
    expect(isDistressed("I'm hopeless at chemistry")).toBe(true);
    expect(isDistressed("Which APs should I take?")).toBe(false);
    const once = withSupport("Focus on the labs first.", true);
    expect(once.endsWith(SUPPORT_FOOTER)).toBe(true);
    expect(withSupport(once, true)).toBe(once);
    expect(withSupport("Focus on the labs first.", false)).toBe("Focus on the labs first.");
    expect(withSupport("", true)).toBe("");
  });
});
