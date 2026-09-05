// Helpers for bringing an uploaded transcript into the profile from the chat.
// Pure functions so they can be unit-tested; the network call lives in App.

export const SURVEY_YEAR_KEYS = ["freshman", "sophomore", "junior", "senior"];

// Does an attached text file read like a transcript / report card? Needs a
// document keyword AND several graded lines, so an essay that mentions "my
// transcript" once doesn't qualify.
export function looksLikeTranscript(text) {
  const src = String(text || "");
  if (src.length < 80) return false;
  const keyword = /\b(transcript|report card|progress report|grade report|cumulative gpa|credits? (?:earned|attempted)|marking period|semester (?:1|2|one|two)|quarter (?:1|2|3|4))\b/i.test(src);
  if (!keyword) return false;
  const gradedLines = src.split(/\r?\n/).filter((line) => /\S+\s+\S+/.test(line) && /(?:^|\s)(?:[ABCDF][+\-−]?|\d{2,3}(?:\.\d)?%?)\s*$/.test(line.trim())).length;
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
  return null;
}

// Merge courses parsed from a transcript ({ freshman: [...], ..., unknown: [...] })
// into the profile's flat, year-tagged course list. Duplicates (same year +
// name) are skipped; a course with no readable grade is stored as "IP" (in
// progress) — never guessed. Courses whose year the transcript didn't state
// go to `fallbackYear` (the student's current year) when known.
export function mergeImportedCourses(existing, parsedYears, { fallbackYear = null, maxCourses = 50 } = {}) {
  const courses = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(courses.map((c) => `${String(c.year || "").toLowerCase()}:${String(c.name || "").trim().toLowerCase()}`));
  let added = 0;
  let skipped = 0;
  let unplaced = 0;
  for (const [year, list] of Object.entries(parsedYears || {})) {
    let targetYear = SURVEY_YEAR_KEYS.includes(year) ? year : fallbackYear;
    for (const raw of (Array.isArray(list) ? list : [])) {
      const name = String(raw?.name || "").trim().slice(0, 100);
      if (!name) continue;
      if (!targetYear) { unplaced += 1; continue; }
      const key = `${targetYear}:${name.toLowerCase()}`;
      if (seen.has(key) || courses.length >= maxCourses) { skipped += 1; continue; }
      seen.add(key);
      courses.push({
        name,
        type: raw?.type || "regular",
        grade: raw?.grade || "IP",
        semester: raw?.semester || "full_year",
        year: targetYear,
      });
      added += 1;
    }
  }
  return { courses, added, skipped, unplaced };
}

export function summarizeParsedTranscript(parsedYears) {
  const out = [];
  for (const year of [...SURVEY_YEAR_KEYS, "unknown"]) {
    const list = Array.isArray(parsedYears?.[year]) ? parsedYears[year] : [];
    if (!list.length) continue;
    out.push({ year, courses: list.map((c) => ({ name: c.name, type: c.type || "regular", grade: c.grade || "IP" })) });
  }
  return out;
}
