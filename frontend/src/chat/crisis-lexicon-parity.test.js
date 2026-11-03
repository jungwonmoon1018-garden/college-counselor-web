// The client half of the lexicon contract. The same case fixture is read by
// backend/tests/crisis-lexicon-parity.test.js against the server lexicon, so
// a phrase added to one side's patterns without the other fails CI on both.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCrisisStatement, isCrisisTopicMention } from "./crisis-lexicon.js";

// A path, not new URL(…): under jsdom URL is jsdom's class, which
// fileURLToPath rejects.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "..", "..", "..", "backend", "tests", "fixtures", "crisis-lexicon-cases.json");
const CASES = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

describe("crisis lexicon fixture (shared with the server)", () => {
  it("calls every crisis case a crisis", () => {
    expect(CASES.crisis.length).toBeGreaterThanOrEqual(50);
    for (const text of CASES.crisis) expect(isCrisisStatement(text), text).toBe(true);
  });

  it("answers every topic case with the footer instead of blocking", () => {
    for (const text of CASES.topic) {
      expect(isCrisisStatement(text), text).toBe(false);
      expect(isCrisisTopicMention(text), text).toBe(true);
    }
  });

  it("leaves ordinary counseling words, idioms and Korean hyperbole alone", () => {
    for (const text of CASES.not_crisis) {
      expect(isCrisisStatement(text), text).toBe(false);
      expect(isCrisisTopicMention(text), text).toBe(false);
    }
  });
});
