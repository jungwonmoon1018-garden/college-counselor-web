import { describe, it, expect } from "vitest";
import { looksLikeTranscript, currentYearKey, countDistinctCourses, courseTermLabel, mergeImportedCourses, mergeSurveyImport, summarizeParsedTranscript } from "./transcript-utils.js";

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
    expect(groups[0].courses[2]).toEqual({ name: "AP Calculus BC", type: "ap", grade: "IP", semester: "full_year" });
  });
});

// A Korean 학교생활기록부 has no English keyword and its rows end in a
// 성취도 letter with the cohort size, or a 석차등급 digit; the chat never
// offered to import one.
const KOREAN_RECORD = `학교생활기록부
7. 교과학습발달상황
[2학년]
학기 교과 과목 단위수 원점수/과목평균(표준편차) 성취도(수강자수) 석차등급
1 국어 문학 4 91/72.5(14.1) A(250) 2
1 수학 수학II 4 88/70.1(15.2) A(250) 2
1 영어 영어II 4 79/68.0(16.3) C(250) 4
2 과학 물리학I 3 55/61.2(18.0) E(120) 7
2 사회 진로탐구 2 A(120)`;

describe("Korean school records", () => {
  it("recognizes a 학생부 excerpt, and not an essay that mentions 학기 once", () => {
    expect(looksLikeTranscript(KOREAN_RECORD)).toBe(true);
    const essay = "이번 1학기에는 동아리 활동을 하면서 친구들과 함께 많은 것을 배웠다. 특히 과학 실험을 준비하면서 실패를 견디는 법을 배웠고, 그 경험이 나를 바꾸었다. 앞으로도 꾸준히 노력하고 싶다.";
    expect(looksLikeTranscript(essay)).toBe(false);
    // English text with a stray "E" or digit at line ends needs an English keyword and letter grades.
    expect(looksLikeTranscript("Notes from class\nPlan A\nPlan B is option E\nStep 1\nStep 2\nStep 3\n".repeat(3))).toBe(false);
    expect(looksLikeTranscript(TRANSCRIPT)).toBe(true);
  });
  it("reads a Korean grade level", () => {
    expect(currentYearKey("고2")).toBe("junior");
    expect(currentYearKey("고1")).toBe("sophomore");
    expect(currentYearKey("고3")).toBe("senior");
  });
  it("keeps a 성취도 E as a final grade on its scale", () => {
    const merged = mergeImportedCourses([], { sophomore: [{ name: "물리학I", type: "regular", grade: "E", semester: "spring", gradeScale: "kr_achievement" }] });
    expect(merged.courses[0]).toEqual({ name: "물리학I", type: "regular", grade: "E", semester: "spring", gradeScale: "kr_achievement", year: "sophomore" });
  });
});

// The spring row of a semester-graded course was skipped as a duplicate of
// the fall row, and its grade was lost; the note blamed duplicates even for
// rows over the course cap.
describe("semester rows", () => {
  const parsed = {
    junior: [
      { name: "AP Biology", type: "ap", grade: "A", semester: "fall" },
      { name: "AP Biology", type: "ap", grade: "B", semester: "spring" },
    ],
  };
  it("keeps both semesters of a course and skips only an exact repeat", () => {
    const merged = mergeImportedCourses([{ name: "AP Biology", type: "ap", grade: "A", semester: "fall", year: "junior" }], parsed);
    expect(merged.added).toBe(1);
    expect(merged.duplicates).toBe(1);
    expect(merged.overCap).toBe(0);
    expect(merged.courses.map((c) => `${c.semester}:${c.grade}`)).toEqual(["fall:A", "spring:B"]);
    expect(countDistinctCourses(merged.courses)).toBe(1);
  });
  it("merges into the survey's year tabs and says why rows were skipped", () => {
    const out = mergeSurveyImport({ junior: [{ name: "AP Biology", type: "ap", grade: "A", semester: "fall" }] }, parsed, { fallbackYear: "junior" });
    expect(out.merged.junior.map((c) => c.grade)).toEqual(["A", "B"]);
    expect(out.note).toBe("Imported 1 course (skipped: 1 already on your list).");
    const capped = mergeSurveyImport({}, parsed, { fallbackYear: "junior", maxCourses: 1 });
    expect(capped.note).toBe("Imported 1 course (skipped: 1 over the 1-course limit).");
  });
});

// Mock run, 2026-11-22: a four-year transcript with semester grades and
// ungraded rows. The import counted entries where the survey counted
// courses, the pairs showed no term, and a finished year's N/A row became
// "in progress".
describe("an imported transcript as the student reviews it", () => {
  const parsed = {
    freshman: [
      { name: "World History", type: "regular", grade: "A", semester: "fall" },
      { name: "World History", type: "regular", grade: "B", semester: "spring" },
      { name: "Geometry", type: "regular", grade: "A-", semester: "fall" },
      { name: "Geometry", type: "regular", grade: "A-", semester: "spring" },
    ],
    junior: [{ name: "Library Aide", type: "elective", grade: null, semester: "full_year" }],
    senior: [{ name: "French III", type: "regular", grade: null, semester: "full_year" }],
  };

  it("counts courses, not semester entries, and says why the entries outnumber them", () => {
    const out = mergeSurveyImport({}, parsed, { fallbackYear: "senior", currentYear: "senior" });
    expect(out.added).toBe(6);
    expect(out.note).toBe("Imported 4 courses in 6 entries (a course graded each semester has one per term).");
  });

  it("saves an earlier year's ungraded row without a grade, and this year's as in progress", () => {
    const out = mergeSurveyImport({}, parsed, { fallbackYear: "senior", currentYear: "senior" });
    expect(out.merged.junior[0].grade).toBe("");
    expect(out.merged.senior[0].grade).toBe("IP");
    // With no school year on the account, nothing is called finished.
    const unknown = mergeSurveyImport({}, parsed, { fallbackYear: "senior" });
    expect(unknown.merged.junior[0].grade).toBe("IP");
    // The chat card's merge follows the same rule.
    const chat = mergeImportedCourses([], parsed, { fallbackYear: "senior" });
    expect(chat.courses.find((c) => c.year === "junior").grade).toBe("");
    expect(chat.courses.find((c) => c.year === "senior").grade).toBe("IP");
  });

  it("names the term of a semester row and nothing for a full-year one", () => {
    expect(courseTermLabel("fall")).toBe("Fall");
    expect(courseTermLabel("Spring")).toBe("Spring");
    expect(courseTermLabel("full_year")).toBe("");
    expect(courseTermLabel(undefined)).toBe("");
  });
});
