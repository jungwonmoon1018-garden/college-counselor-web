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
} from "../academics/transcript-import.js";

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
    assert.ok(result.warnings.some((w) => w.includes("no final grade on this document")));
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

// A semester-graded course is two rows. The import keyed a course on its
// year and name, so the spring grade vanished (AP Biology fall A kept,
// spring B gone) with no warning; and a Korean 성취도 E was saved as
// "in progress".
describe("semester grades and Korean records", () => {
  it("keeps both semesters of one course and still merges a repeated row, saying so", () => {
    const result = sanitizeParsedTranscript({
      years: {
        junior: [
          { name: "AP Biology", type: "ap", grade: "A", semester: "fall" },
          { name: "AP Biology", type: "ap", grade: "B", semester: "spring" },
          { name: "수학 II", type: "regular", grade: "A", semester: "fall" },
          { name: "수학 II", type: "regular", grade: "C+", semester: "spring" },
          { name: "AP Biology", type: "ap", grade: "A", semester: "fall" },
        ],
      },
    });
    assert.equal(result.courseCount, 4);
    assert.deepEqual(result.years.junior.map((c) => [c.name, c.semester, c.grade]), [
      ["AP Biology", "fall", "A"], ["AP Biology", "spring", "B"], ["수학 II", "fall", "A"], ["수학 II", "spring", "C+"],
    ]);
    assert.ok(result.warnings.some((w) => w.startsWith("1 repeated row(s) were merged")), JSON.stringify(result.warnings));
  });

  it("keeps a Korean achievement E as a final grade on its scale", () => {
    const result = sanitizeParsedTranscript({
      years: { sophomore: [
        { name: "물리학 I", type: "regular", grade: "E", semester: "fall", gradeScale: "kr_achievement" },
        { name: "화학 I", type: "regular", grade: "B", semester: "fall", gradeScale: "made_up" },
      ] },
    });
    assert.deepEqual(result.years.sophomore[0], { name: "물리학 I", type: "regular", grade: "E", semester: "fall", gradeScale: "kr_achievement" });
    assert.deepEqual(result.years.sophomore[1], { name: "화학 I", type: "regular", grade: "B", semester: "fall" });
    assert.ok(!result.warnings.some((w) => w.includes("in progress")));
  });

  it("tells the model to list each semester and how to read a Korean record", () => {
    const { system } = buildTranscriptParseMessages("교과학습발달상황");
    assert.match(system, /TWO entries with the same name/);
    assert.match(system, /1학기 → \"fall\", 2학기 → \"spring\"/);
    assert.match(system, /1학년 → sophomore/);
    assert.match(system, /kr_achievement/);
  });
});

