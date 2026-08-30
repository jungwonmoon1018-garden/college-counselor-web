// ═══════════════════════════════════════════════════════════
// TESTS: Transcript import parsing/sanitization
// ═══════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTranscriptParseMessages,
  sanitizeParsedTranscript,
  parseTranscriptModelReply,
  MAX_IMPORTED_COURSES,
} from "../transcript-import.js";

describe("buildTranscriptParseMessages", () => {
  it("includes the schema and the transcript text", () => {
    const { system, user } = buildTranscriptParseMessages("AP Biology  A  Grade 10");
    assert.ok(system.includes("dual_enrollment"));
    assert.ok(system.includes("NEVER guess a grade"));
    assert.ok(user.includes("AP Biology"));
  });

  it("caps very long extracted text", () => {
    const { user } = buildTranscriptParseMessages("x".repeat(100_000));
    assert.ok(user.length < 31_000);
  });
});

describe("sanitizeParsedTranscript", () => {
  it("keeps valid courses and clamps invalid enum values", () => {
    const result = sanitizeParsedTranscript({
      gpa: 3.87,
      years: {
        junior: [
          { name: "AP Calculus BC", type: "ap", grade: "A", semester: "full_year" },
          { name: "Ceramics", type: "not_a_type", grade: "Z", semester: "quarter" },
        ],
      },
    });
    assert.equal(result.gpa, 3.87);
    assert.equal(result.courseCount, 2);
    assert.deepEqual(result.years.junior[0], { name: "AP Calculus BC", type: "ap", grade: "A", semester: "full_year" });
    // Invalid type/grade/semester fall back to safe defaults, never invented grades.
    assert.deepEqual(result.years.junior[1], { name: "Ceramics", type: "regular", grade: null, semester: "full_year" });
    assert.ok(result.warnings.some((w) => w.includes("no readable grade")));
  });

  it("drops nameless courses, dedupes, and caps the total", () => {
    const many = Array.from({ length: MAX_IMPORTED_COURSES + 10 }, (_, i) => ({
      name: `Course ${i}`, type: "regular", grade: "B", semester: "fall",
    }));
    const result = sanitizeParsedTranscript({
      years: {
        freshman: [
          { name: "", type: "regular", grade: "A", semester: "fall" },
          { name: "Biology", grade: "A" },
          { name: "biology", grade: "A" },
          ...many,
        ],
      },
    });
    assert.equal(result.courseCount, MAX_IMPORTED_COURSES);
    assert.ok(result.warnings.some((w) => w.includes("capped")));
    // Case-insensitive dedupe within a year.
    assert.equal(result.years.freshman.filter((c) => c.name.toLowerCase() === "biology").length, 1);
  });

  it("rejects out-of-range GPA values and strips injection-prone characters", () => {
    const result = sanitizeParsedTranscript({
      gpa: 97,
      years: { unknown: [{ name: "Chem<script>[x]{y}", grade: "B+" }] },
    });
    assert.equal(result.gpa, null);
    assert.equal(result.years.unknown[0].name, "Chemscriptxy");
    assert.ok(result.warnings.some((w) => w.includes("no clear school year")));
  });

  it("handles a fully-empty reply", () => {
    const result = sanitizeParsedTranscript({});
    assert.equal(result.courseCount, 0);
    assert.ok(result.warnings.some((w) => w.includes("No courses")));
  });
});

describe("parseTranscriptModelReply", () => {
  it("strips markdown fences and surrounding prose", () => {
    const reply = "Here you go:\n```json\n" + JSON.stringify({
      gpa: 3.5,
      years: { senior: [{ name: "AP Literature", type: "ap", grade: "A-", semester: "full_year" }] },
    }) + "\n```";
    const result = parseTranscriptModelReply(reply);
    assert.equal(result.gpa, 3.5);
    assert.equal(result.years.senior[0].name, "AP Literature");
  });

  it("throws on a reply with no JSON", () => {
    assert.throws(() => parseTranscriptModelReply("I cannot parse this document."));
  });
});
