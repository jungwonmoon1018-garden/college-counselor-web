// Helpers for bringing an uploaded transcript into the profile from the chat.
// Pure functions so they can be unit-tested; the network call lives in App.

export const SURVEY_YEAR_KEYS = ["freshman", "sophomore", "junior", "senior"];

// How many course rows a profile holds. A course graded by semester is two
// rows, so the old cap of 50 (below the server's 60-course import) cut a
// four-year semester transcript short.
export const MAX_PROFILE_COURSES = 80;

// One identity for a course row wherever a list is de-duplicated: the
// year, the name and the term. Keyed on year and name alone, the spring
// row of a semester-graded course was skipped as a duplicate of the fall
// row and its grade was lost.
export function courseKey(year, course) {
  const name = String(course?.name || "").trim().toLowerCase();
  const term = String(course?.semester || "full_year").trim().toLowerCase() || "full_year";
  return `${String(year || "").toLowerCase()}:${name}:${term}`;
}

// The number of courses a list holds, a semester pair counted once (the
// survey's "Total: N courses" used to count each term).
export function countDistinctCourses(rows) {
  let count = 0;
  const halves = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name || "").trim().toLowerCase();
    if (!name) continue;
    const term = String(row?.semester || "").toLowerCase();
    if (term === "fall" || term === "spring") {
      const key = String(row?.year || "").toLowerCase() + ":" + name;
      if (halves.has(key)) continue;
      halves.add(key);
    }
    count += 1;
  }
  return count;
}

// Does an attached text file read like a transcript / report card? Needs a
// document keyword AND several graded lines, so an essay that mentions "my
// transcript" once doesn't qualify.
//
// A Korean school record (학교생활기록부) has no English keyword, and its
// rows end in a 성취도 letter A–E with the cohort size ("A(250)") or a 1–9
// 석차등급, so a Korean student who attached hers in chat was never offered
// the import. Those line endings count only beside a Korean marker, so
// English text with a stray "E" or digit at a line end never qualifies.
const KOREAN_RECORD_MARKER = /(?:학교생활기록부|학생부|교과학습발달상황|성적표|성적\s*통지|원점수|성취도|석차\s*등급|[12]\s*학기)/;
export function looksLikeTranscript(text) {
  const src = String(text || "");
  if (src.length < 80) return false;
  const keyword = /\b(transcript|report card|progress report|grade report|cumulative gpa|credits? (?:earned|attempted)|marking period|semester (?:1|2|one|two)|quarter (?:1|2|3|4))\b/i.test(src);
  const korean = KOREAN_RECORD_MARKER.test(src);
  if (!keyword && !korean) return false;
  const lines = src.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\S+\s+\S+/.test(line));
  const english = (line) => /(?:^|\s)(?:[ABCDF][+\-−]?|\d{2,3}(?:\.\d)?%?)\s*$/.test(line);
  const koreanRow = (line) => /[가-힣]/.test(line) && /(?:^|\s)(?:[A-E](?:\s*\(\s*\d{1,4}(?:\.\d+)?\s*\))?|[1-9]|P)\s*$/.test(line);
  const gradedLines = lines.filter((line) => (keyword && english(line)) || (korean && koreanRow(line))).length;
  return gradedLines >= 3;
}

// The student's current school year, from whatever form the account stored
// the grade level in ("11", 11, "11th", "Junior", "Grade 11").
export function currentYearKey(grade) {
  const g = String(grade ?? "").toLowerCase();
  if (/\b(9|9th|fresh)/.test(g)) return "freshman";
  if (/\b(10|10th|soph)/.test(g)) return "sophomore";
  if (/\b(11|11th|junior)/.test(g)) return "junior";
  if (/\b(12|12th|senior)/.test(g)) return "senior";
  // Korean high school is grades 10-12: 고1 is a sophomore.
  if (/고\s*1/.test(g)) return "sophomore";
  if (/고\s*2/.test(g)) return "junior";
  if (/고\s*3/.test(g)) return "senior";
  if (/중\s*3/.test(g)) return "freshman";
  return null;
}

// One imported row in the profile's course shape. A grade on a scale other
// than the US letters (Korean 성취도) keeps its `gradeScale`.
function importedCourse(raw, name) {
  const course = {
    name,
    type: raw?.type || "regular",
    grade: raw?.grade || "IP",
    semester: raw?.semester || "full_year",
  };
  if (raw?.grade && raw?.gradeScale) course.gradeScale = raw.gradeScale;
  return course;
}

// Merge courses parsed from a transcript ({ freshman: [...], ..., unknown: [...] })
// into the profile's flat, year-tagged course list. Duplicates (same year,
// name and term) are skipped and counted apart from the rows over the cap
// (`duplicates`, `overCap`; `skipped` is both); a course with no
// readable grade is stored as "IP" (in progress) — never guessed. Courses
// whose year the transcript didn't state go to `fallbackYear` (the
// student's current year) when known.
export function mergeImportedCourses(existing, parsedYears, { fallbackYear = null, maxCourses = MAX_PROFILE_COURSES } = {}) {
  const courses = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(courses.map((c) => courseKey(c.year, c)));
  let added = 0;
  let duplicates = 0;
  let overCap = 0;
  let unplaced = 0;
  for (const [year, list] of Object.entries(parsedYears || {})) {
    let targetYear = SURVEY_YEAR_KEYS.includes(year) ? year : fallbackYear;
    for (const raw of (Array.isArray(list) ? list : [])) {
      const name = String(raw?.name || "").trim().slice(0, 100);
      if (!name) continue;
      if (!targetYear) { unplaced += 1; continue; }
      const key = courseKey(targetYear, { name, semester: raw?.semester });
      if (seen.has(key)) { duplicates += 1; continue; }
      if (courses.length >= maxCourses) { overCap += 1; continue; }
      seen.add(key);
      courses.push({ ...importedCourse(raw, name), year: targetYear });
      added += 1;
    }
  }
  return { courses, added, skipped: duplicates + overCap, duplicates, overCap, unplaced };
}

// The survey's merge: its courses are held by year ({ junior: [...] }),
// and a row with no school year goes to `fallbackYear` (the year tab open).
// Returns the merged map, the counts, and the note the survey shows, which
// says why rows were skipped instead of blaming duplicates for the cap.
export function mergeSurveyImport(byYear, parsedYears, { years = SURVEY_YEAR_KEYS, fallbackYear, maxCourses = MAX_PROFILE_COURSES } = {}) {
  const merged = { ...(byYear || {}) };
  const seen = new Set(Object.entries(merged).flatMap(([year, list]) => (Array.isArray(list) ? list : []).map((c) => courseKey(year, c))));
  let total = Object.values(merged).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  let added = 0;
  let duplicates = 0;
  let overCap = 0;
  for (const [year, list] of Object.entries(parsedYears || {})) {
    const targetYear = years.includes(year) ? year : fallbackYear;
    for (const raw of (Array.isArray(list) ? list : [])) {
      const name = String(raw?.name || "").trim().slice(0, 100);
      if (!name) continue;
      const key = courseKey(targetYear, { name, semester: raw?.semester });
      if (seen.has(key)) { duplicates += 1; continue; }
      if (total >= maxCourses) { overCap += 1; continue; }
      seen.add(key);
      merged[targetYear] = [...(merged[targetYear] || []), importedCourse(raw, name)];
      total += 1;
      added += 1;
    }
  }
  const skippedParts = [];
  if (duplicates) skippedParts.push(`${duplicates} already on your list`);
  if (overCap) skippedParts.push(`${overCap} over the ${maxCourses}-course limit`);
  const note = `Imported ${added} course${added === 1 ? "" : "s"}${skippedParts.length ? ` (skipped: ${skippedParts.join(", ")})` : ""}.`;
  return { merged, added, duplicates, overCap, note };
}

export function summarizeParsedTranscript(parsedYears) {
  const out = [];
  for (const year of [...SURVEY_YEAR_KEYS, "unknown"]) {
    const list = Array.isArray(parsedYears?.[year]) ? parsedYears[year] : [];
    if (!list.length) continue;
    out.push({ year, courses: list.map((c) => ({ name: c.name, type: c.type || "regular", grade: c.grade || "IP", semester: c.semester || "full_year" })) });
  }
  return out;
}
