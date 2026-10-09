// academics/ap-exams.js — every AP exam under one name, and the other names
// students, transcripts and the model use for it.
//
// The app stores an AP exam under the short name its picker shows ("US
// History", "Physics C: E&M", "Studio Art: 2-D"). Transcripts and the
// College Board use the full names ("AP United States History", "AP Physics
// C: Electricity and Magnetism", "AP 2-D Art and Design"), and students type
// abbreviations ("APUSH", "AP Calc BC", "AP Lang"). Until 2026-10-09 a
// course was matched to its exam by their words alone, so a course "AP
// United States History" and the exam "US History" counted as two APs taken,
// "APES" was not read as AP at all, and the chat's profile check heard none
// of those names.
//
// `name` is the stored name: frontend/src/app-shared.js AP_EXAM_LIST lists
// the same, and a test keeps the two in step. `aliases` are the College
// Board's full name and the common abbreviations, never a word another exam
// or an ordinary course shares ("Physics C", "Calculus", "AP Spanish",
// "Drawing"). `firstExamYear` marks an exam too new to have scores from any
// earlier year; the frontend's AP_FIRST_EXAM_YEAR carries the same years.
export const AP_EXAMS = Object.freeze([
  { name: "African American Studies", aliases: ["AP AAS"] },
  { name: "Art History", aliases: [] },
  { name: "Biology", aliases: ["AP Bio"] },
  // AP Career Kickstart: first exams on May 4 and 5, 2027.
  { name: "Business with Personal Finance", firstExamYear: 2027, aliases: ["AP Business", "Business Principles and Personal Finance", "AP Business Principles/Personal Finance"] },
  { name: "Calculus AB", aliases: ["AP Calc AB", "Calc AB"] },
  { name: "Calculus BC", aliases: ["AP Calc BC", "Calc BC"] },
  { name: "Chemistry", aliases: ["AP Chem"] },
  { name: "Chinese Language", aliases: ["Chinese Language and Culture", "AP Chinese"] },
  { name: "Comparative Government", aliases: ["Comparative Government and Politics", "AP Comp Gov"] },
  { name: "Computer Science A", aliases: ["AP CSA", "APCSA", "AP Comp Sci A"] },
  { name: "Computer Science Principles", aliases: ["AP CSP", "APCSP", "AP Comp Sci Principles"] },
  { name: "Cybersecurity", firstExamYear: 2027, aliases: ["AP Cyber"] },
  { name: "English Language", aliases: ["English Language and Composition", "AP Lang", "AP English Lang"] },
  { name: "English Literature", aliases: ["English Literature and Composition", "AP Lit", "AP English Lit"] },
  { name: "Environmental Science", aliases: ["APES", "AP Enviro"] },
  { name: "European History", aliases: ["AP Euro", "APEH"] },
  { name: "French Language", aliases: ["French Language and Culture", "AP French"] },
  { name: "German Language", aliases: ["German Language and Culture", "AP German"] },
  { name: "Human Geography", aliases: ["APHG", "AP HuG", "AP Human Geo"] },
  { name: "Italian Language", aliases: ["Italian Language and Culture", "AP Italian"] },
  { name: "Japanese Language", aliases: ["Japanese Language and Culture", "AP Japanese"] },
  { name: "Latin", aliases: [] },
  { name: "Macroeconomics", aliases: ["AP Macro"] },
  { name: "Microeconomics", aliases: ["AP Micro"] },
  { name: "Music Theory", aliases: [] },
  { name: "Physics 1", aliases: ["Physics 1: Algebra-Based", "AP Physics I"] },
  { name: "Physics 2", aliases: ["Physics 2: Algebra-Based", "AP Physics II"] },
  { name: "Physics C: E&M", aliases: ["Physics C: Electricity and Magnetism", "Physics C EM"] },
  { name: "Physics C: Mechanics", aliases: ["Physics C: Mech"] },
  // First exam in May 2024.
  { name: "Precalculus", firstExamYear: 2024, aliases: ["AP Precalc"] },
  { name: "Psychology", aliases: ["AP Psych"] },
  { name: "Research", aliases: ["AP Capstone Research"] },
  { name: "Seminar", aliases: ["AP Capstone Seminar"] },
  { name: "Spanish Language", aliases: ["Spanish Language and Culture", "AP Spanish Lang"] },
  { name: "Spanish Literature", aliases: ["Spanish Literature and Culture", "AP Spanish Lit"] },
  { name: "Statistics", aliases: ["AP Stats", "AP Stat"] },
  { name: "Studio Art: 2-D", aliases: ["2-D Art and Design", "AP 2D Art and Design", "Studio Art 2-D Design"] },
  { name: "Studio Art: 3-D", aliases: ["3-D Art and Design", "AP 3D Art and Design", "Studio Art 3-D Design"] },
  { name: "Studio Art: Drawing", aliases: ["AP Drawing"] },
  { name: "US Government", aliases: ["United States Government and Politics", "U.S. Government and Politics", "US Government and Politics", "United States Government", "U.S. Government", "AP Gov", "AP US Gov", "APGOV"] },
  { name: "US History", aliases: ["United States History", "U.S. History", "APUSH"] },
  { name: "World History", aliases: ["World History: Modern", "AP World", "APWH"] },
]);

// The words of an exam name that tell exams apart: lower case, "&" read as
// "and", without "AP", "Advanced Placement", "exam" or "course" and without
// punctuation. "AP Physics C: E&M" and "Physics C E and M" read alike.
export function apNameWords(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\badvanced placement\b/g, " ")
    .replace(/\bap\b/g, " ")
    .replace(/\b(?:exam|examination|test|course)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_WORDS = new Map();
for (const exam of AP_EXAMS) {
  for (const label of [exam.name, ...exam.aliases]) BY_WORDS.set(apNameWords(label), exam);
}

// "APUSH", "APES" and the like: an exam named in one glued word. "Apes" is
// an English word, so that one counts only in capitals.
const GLUED = new Map();
for (const exam of AP_EXAMS) {
  for (const alias of exam.aliases) if (/^AP[A-Z]{2,}$/.test(alias)) GLUED.set(alias, exam);
}

function lookup(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const glued = raw.split(/[\s:(,–—-]+/)[0];
  const upper = glued.toUpperCase();
  if (GLUED.has(upper) && (upper !== "APES" || glued === "APES")) return GLUED.get(upper);
  return BY_WORDS.get(apNameWords(raw)) || null;
}

// The stored name of the AP exam a name means, or null when it is not one
// the catalog knows ("AP Calculus" could be AB or BC).
export function apExamKey(name) {
  return lookup(name)?.name ?? null;
}

// Whether a course name starts with a glued AP abbreviation ("APUSH",
// "APES 2nd period"); the course-level reader takes it as AP.
export function isGluedApName(name) {
  const glued = String(name || "").trim().split(/[\s:(,–—-]+/)[0];
  const upper = glued.toUpperCase();
  return GLUED.has(upper) && (upper !== "APES" || glued === "APES");
}

// Every name the chat's profile check listens for: the stored name with
// and without "AP", and the catalog's aliases for it.
export function apExamAliases(name) {
  const exam = lookup(name);
  const bare = String(name || "").trim().replace(/^AP\s+/i, "");
  const names = [bare, `AP ${bare}`];
  if (exam) names.push(exam.name, `AP ${exam.name}`, ...exam.aliases);
  return [...new Set(names.filter((n) => n.length >= 3))];
}

// The first year an exam had scores, when it is newer than the rest.
export function apFirstExamYear(name) {
  return lookup(name)?.firstExamYear ?? null;
}
