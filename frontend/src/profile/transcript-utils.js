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

// The term a semester row belongs to, for a list that shows it: a course
// graded each semester is two rows, and shown without the term the pair
// read as a duplicate ("Biology — A" twice, "World History — A" and
// "World History — B") that a student would delete, grade and all.
export function courseTermLabel(semester) {
  const term = String(semester || "").toLowerCase();
  return term === "fall" ? "Fall" : term === "spring" ? "Spring" : "";
}

// A year before the student's current one is finished. The import read a
// missing grade as "in progress" in every year, so a transcript's N/A or
// pass/fail row from two years ago was saved as a course still under way;
// a finished year's row without a grade is saved without one ("No grade
// recorded"), and only this year's (or a year the account cannot place)
// as "IP".
function isEarlierYear(year, currentYear) {
  const at = SURVEY_YEAR_KEYS.indexOf(year);
  const now = SURVEY_YEAR_KEYS.indexOf(currentYear);
  return at >= 0 && now >= 0 && at < now;
}

// One imported row in the profile's course shape. A grade on a scale other
// than the US letters (Korean 성취도) keeps its `gradeScale`.
function importedCourse(raw, name, { year = null, currentYear = null } = {}) {
  const course = {
    name,
    type: raw?.type || "regular",
    grade: raw?.grade || (isEarlierYear(year, currentYear) ? "" : "IP"),
    semester: raw?.semester || "full_year",
  };
  if (raw?.grade && raw?.gradeScale) course.gradeScale = raw.gradeScale;
  return course;
}

// What an import added, counted as courses: a semester pair is one course
// in two entries, so a note that counted entries over a list whose total
// counted courses told the student some courses had gone missing.
function importNote(addedRows, { duplicates, overCap, maxCourses }) {
  const courses = countDistinctCourses(addedRows);
  const entries = addedRows.length;
  const skippedParts = [];
  if (duplicates) skippedParts.push(`${duplicates} already on your list`);
  if (overCap) skippedParts.push(`${overCap} over the ${maxCourses}-course limit`);
  const split = entries > courses ? ` in ${entries} entries (a course graded each semester has one per term)` : "";
  return `Imported ${courses} course${courses === 1 ? "" : "s"}${split}${skippedParts.length ? ` (skipped: ${skippedParts.join(", ")})` : ""}.`;
}

// Merge courses parsed from a transcript ({ freshman: [...], ..., unknown: [...] })
// into the profile's flat, year-tagged course list. Duplicates (same year,
// name and term) are skipped and counted apart from the rows over the cap
// (`duplicates`, `overCap`; `skipped` is both); a course with no
// readable grade is stored as "IP" (in progress) in the student's current
// year and without a grade in an earlier one — never guessed. Courses
// whose year the transcript didn't state go to `fallbackYear` (the
// student's current year) when known.
export function mergeImportedCourses(existing, parsedYears, { fallbackYear = null, currentYear = fallbackYear, maxCourses = MAX_PROFILE_COURSES } = {}) {
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
      courses.push({ ...importedCourse(raw, name, { year: targetYear, currentYear }), year: targetYear });
      added += 1;
    }
  }
  return { courses, added, skipped: duplicates + overCap, duplicates, overCap, unplaced };
}

// The survey's merge: its courses are held by year ({ junior: [...] }),
// and a row with no school year goes to `fallbackYear` (the year tab open).
// Returns the merged map, the counts, and the note the survey shows, which
// says why rows were skipped instead of blaming duplicates for the cap.
// `currentYear` is the student's own school year (not the tab open): a row
// from an earlier year with no grade is saved without one.
export function mergeSurveyImport(byYear, parsedYears, { years = SURVEY_YEAR_KEYS, fallbackYear, currentYear = null, maxCourses = MAX_PROFILE_COURSES } = {}) {
  const merged = { ...(byYear || {}) };
  const seen = new Set(Object.entries(merged).flatMap(([year, list]) => (Array.isArray(list) ? list : []).map((c) => courseKey(year, c))));
  let total = Object.values(merged).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  let added = 0;
  let duplicates = 0;
  let overCap = 0;
  const addedRows = [];
  for (const [year, list] of Object.entries(parsedYears || {})) {
    const targetYear = years.includes(year) ? year : fallbackYear;
    for (const raw of (Array.isArray(list) ? list : [])) {
      const name = String(raw?.name || "").trim().slice(0, 100);
      if (!name) continue;
      const key = courseKey(targetYear, { name, semester: raw?.semester });
      if (seen.has(key)) { duplicates += 1; continue; }
      if (total >= maxCourses) { overCap += 1; continue; }
      seen.add(key);
      const course = importedCourse(raw, name, { year: targetYear, currentYear });
      merged[targetYear] = [...(merged[targetYear] || []), course];
      addedRows.push({ ...course, year: targetYear });
      total += 1;
      added += 1;
    }
  }
  const note = importNote(addedRows, { duplicates, overCap, maxCourses });
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
