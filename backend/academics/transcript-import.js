// ═══════════════════════════════════════════════════════════════════════
// TRANSCRIPT IMPORT — parse extracted transcript text into survey courses
// ═══════════════════════════════════════════════════════════════════════
// Pure helpers for the POST /api/students/transcript-import route. The route
// extracts text from an uploaded transcript (PDF / image OCR / DOCX) via
// file-extractors.js, sends the redacted text through the small model tier,
// and this module builds the prompt and sanitizes the model's JSON reply
// into the exact course shape the survey uses:
//   { name, type, grade, semester[, gradeScale] } grouped by school year.
// Nothing here calls a model or touches the network — the OpenRouter
// boundary stays in server.js.
//
// A course graded by semester is two rows, one per term: US transcripts
// usually grade each semester, and every Korean 학교생활기록부 lists 1학기
// and 2학기 apart. The import used to key a course on its year and name
// alone, so the second semester's grade was thrown away without a word
// (AP Biology fall A kept, spring B gone), and the note blamed duplicates.
// Korean 성취도 E is a final grade, kept as written with gradeScale
// "kr_achievement"; it was read as unreadable and saved as "in progress".

export const TRANSCRIPT_COURSE_TYPES = Object.freeze([
  "regular", "elective", "honors", "ap", "ib", "dual_enrollment",
]);

// "E" is the lowest Korean 성취도 level (and the failing letter at some US
// schools); either way it is a final grade, never "in progress".
export const TRANSCRIPT_GRADES = Object.freeze([
  "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "E", "F",
]);

// The scale a grade was given on, when it is not the US letter scale.
export const TRANSCRIPT_GRADE_SCALES = Object.freeze(["kr_achievement"]);

export const TRANSCRIPT_SEMESTERS = Object.freeze(["fall", "spring", "full_year"]);

export const TRANSCRIPT_YEARS = Object.freeze([
  "freshman", "sophomore", "junior", "senior", "unknown",
]);

export const MAX_IMPORTED_COURSES = 60;
const MAX_COURSE_NAME_CHARS = 100;

export function buildTranscriptParseMessages(extractedText) {
  const system = [
    "You convert high-school transcript text into JSON. Reply with ONLY valid JSON, no markdown fences, no commentary.",
    "Schema:",
    '{"gpa": <number 0-5 or null>, "years": {"freshman": [course], "sophomore": [course], "junior": [course], "senior": [course], "unknown": [course]}}',
    'course = {"name": "<course name>", "type": "regular"|"elective"|"honors"|"ap"|"ib"|"dual_enrollment", "grade": "A+"|"A"|"A-"|"B+"|"B"|"B-"|"C+"|"C"|"C-"|"D+"|"D"|"D-"|"E"|"F"|null, "semester": "fall"|"spring"|"full_year", "gradeScale": "kr_achievement" (only for a Korean 성취도 grade, else omit)}',
    "Rules:",
    "- Map grade 9 → freshman, 10 → sophomore, 11 → junior, 12 → senior. If the year is unclear, use \"unknown\".",
    "- \"type\": AP courses → \"ap\", IB → \"ib\", Honors → \"honors\", dual-enrollment/college credit → \"dual_enrollment\", PE/art/music electives → \"elective\", everything else → \"regular\".",
    "- Numeric grades: 97-100→A+, 93-96→A, 90-92→A-, 87-89→B+, 83-86→B, 80-82→B-, 77-79→C+, 73-76→C, 70-72→C-, 67-69→D+, 63-66→D, 60-62→D-, below 60→F.",
    "- A course graded each semester is TWO entries with the same name: one with \"semester\": \"fall\" and its grade, one with \"semester\": \"spring\" and its grade. Never drop or merge a semester's grade. A single year-end grade is one entry with \"full_year\".",
    "- Korean school records (학교생활기록부, 교과학습발달상황): 1학기 → \"fall\", 2학기 → \"spring\". Korean high school is grades 10-12, so 1학년 → sophomore, 2학년 → junior, 3학년 → senior (a middle-school 3학년 → freshman). Use the 성취도 letter (A-E) as the grade, as written, with \"gradeScale\": \"kr_achievement\"; never convert it to a US letter, and never use 원점수, 과목평균 or the 석차등급 number as the grade.",
    "- If a course's grade is missing or unreadable, use null — NEVER guess a grade.",
    "- \"gpa\": the unweighted cumulative GPA if the transcript states one, else null. Never compute one yourself.",
    "- Do not invent courses. Only include what the transcript text actually lists.",
    "- Omit names of people or schools entirely — output courses only.",
  ].join("\n");

  const user = "Transcript text:\n\n" + String(extractedText || "").slice(0, 30_000);
  return { system, user };
}

function sanitizeCourseName(value) {
  return String(value || "")
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, "")
    .replace(/[\[\]{}<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_COURSE_NAME_CHARS);
}

function sanitizeCourse(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = sanitizeCourseName(raw.name);
  if (!name) return null;
  const type = TRANSCRIPT_COURSE_TYPES.includes(raw.type) ? raw.type : "regular";
  const grade = TRANSCRIPT_GRADES.includes(raw.grade) ? raw.grade : null;
  const semester = TRANSCRIPT_SEMESTERS.includes(raw.semester) ? raw.semester : "full_year";
  const course = { name, type, grade, semester };
  if (grade && TRANSCRIPT_GRADE_SCALES.includes(raw.gradeScale)) course.gradeScale = raw.gradeScale;
  return course;
}

// Sanitize a parsed model reply into { gpa, years, warnings }. Tolerates a
// missing/partial "years" object, clamps every field to the survey's enums,
// dedupes by (year, lowercased name, semester) and says how many rows it
// merged, and caps the total course count.
export function sanitizeParsedTranscript(raw) {
  const warnings = [];
  const years = { freshman: [], sophomore: [], junior: [], senior: [], unknown: [] };

  let gpa = null;
  const gpaNumber = Number(raw?.gpa);
  if (raw?.gpa != null && Number.isFinite(gpaNumber) && gpaNumber >= 0 && gpaNumber <= 5) {
    gpa = Math.round(gpaNumber * 100) / 100;
  }

  const seen = new Set();
  let total = 0;
  let dropped = 0;
  let repeated = 0;
  const rawYears = raw?.years && typeof raw.years === "object" ? raw.years : {};
  for (const year of TRANSCRIPT_YEARS) {
    const list = Array.isArray(rawYears[year]) ? rawYears[year] : [];
    for (const item of list) {
      const course = sanitizeCourse(item);
      if (!course) continue;
      const key = year + ":" + course.name.toLowerCase() + ":" + course.semester;
      if (seen.has(key)) { repeated += 1; continue; }
      if (total >= MAX_IMPORTED_COURSES) { dropped += 1; continue; }
      seen.add(key);
      years[year].push(course);
      total += 1;
    }
  }

  if (dropped > 0) warnings.push(`Import capped at ${MAX_IMPORTED_COURSES} courses (${dropped} dropped).`);
  if (repeated > 0) warnings.push(`${repeated} repeated row(s) were merged (the same course, year and term listed twice).`);
  if (total === 0) warnings.push("No courses could be read from this document.");
  if (years.unknown.length > 0) warnings.push(`${years.unknown.length} course(s) had no clear school year — review their placement.`);
  const ungraded = TRANSCRIPT_YEARS.reduce(
    (count, year) => count + years[year].filter((course) => course.grade === null).length, 0,
  );
  if (ungraded > 0) warnings.push(`${ungraded} course(s) have no final grade on this document — they are saved as in progress; add a grade later if one is missing by mistake.`);

  return { gpa, years, courseCount: total, warnings };
}

// Parse the raw model reply text (possibly wrapped in ``` fences) and
// sanitize it. Throws on unparseable JSON so the route can 422.
export function parseTranscriptModelReply(replyText) {
  const cleaned = String(replyText || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model reply contained no JSON object");
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  return sanitizeParsedTranscript(parsed);
}
