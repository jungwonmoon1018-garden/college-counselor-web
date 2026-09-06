// ═══════════════════════════════════════════════════════════════════════
// CHAT GROUNDING — what the chat model is told about the student and about
// colleges, plus the deterministic check that its answer agrees with the
// student's saved record.
// ═══════════════════════════════════════════════════════════════════════
// Pure helpers for POST /api/chat. Nothing here touches the database or the
// network — server.js resolves rows and passes plain objects in.
//
//   formatProfileForModel   — the STUDENT PROFILE block (one item per line,
//                             years, hours, an explicit grade legend)
//   checkProfileFidelity    — finds grades / GPA / test scores / AP scores the
//                             answer states that contradict the profile
//   buildFidelityCorrection — the retry message when a contradiction is found
//   buildFidelityFootnote   — the visible correction when the retry fails
//   detectSchoolMentions    — which colleges a question names
//   formatVerifiedDataBlock — the VERIFIED DATA block (IPEDS baseline, CDS,
//                             research-cache facts) the model may cite from

import { formatVerificationLine } from "./fit-verifier.js";

export const CHAT_PROFILE_LIMITS = Object.freeze({ maxCourses: 40, maxActivities: 20 });

const YEAR_LABELS = {
  freshman: "freshman", sophomore: "sophomore", junior: "junior", senior: "senior",
  9: "freshman", 10: "sophomore", 11: "junior", 12: "senior",
};

const TYPE_LABELS = {
  regular: "regular", elective: "elective", honors: "Honors", ap: "AP", ib: "IB",
  dual_enrollment: "dual enrollment",
};

const TEST_LABELS = {
  sat: "SAT", act: "ACT", psat: "PSAT", toefl: "TOEFL", ielts: "IELTS",
  sat_subject: "SAT Subject Test", duolingo: "Duolingo English Test", clep: "CLEP",
};

function yearLabel(value) {
  const key = String(value ?? "").toLowerCase()
    .replace(/^grade\s*/, "").replace(/(st|nd|rd|th)?\s*grade$/, "").trim();
  if (!key) return null;
  return YEAR_LABELS[key] || key;
}

function isInProgress(grade) {
  const g = String(grade ?? "").trim().toLowerCase();
  return g === "ip" || g === "in progress" || g === "in_progress";
}

export function normalizeGrade(grade) {
  return String(grade ?? "").replace(/[−–]/g, "-").toUpperCase().trim();
}

export function isLetterGrade(grade) {
  return /^[ABCDF][+-]?$/.test(normalizeGrade(grade));
}

// "Computer Science A" [ap] → "AP Computer Science A"; names that already
// carry the prefix are left alone.
export function courseDisplayName(course) {
  const name = String(course?.name || "").trim();
  if (!name) return "";
  const type = String(course?.type || "").toLowerCase();
  if (type === "ap" && !/^ap\b/i.test(name)) return `AP ${name}`;
  if (type === "ib" && !/^ib\b/i.test(name)) return `IB ${name}`;
  return name;
}

export function apExamName(entry) {
  return String(entry?.exam || entry?.subject || entry?.name || "").trim();
}

function gradePhrase(grade) {
  if (isInProgress(grade)) return "in progress (no final grade yet)";
  if (isLetterGrade(grade)) return `grade ${normalizeGrade(grade)}`;
  const raw = String(grade ?? "").trim();
  return raw ? `grade ${raw}` : "grade not recorded";
}

function goalName(goal) {
  if (goal == null) return "";
  if (typeof goal === "string") return goal.trim();
  return String(goal.school || goal.schoolName || goal.name || "").trim();
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

// ─── STUDENT PROFILE block ────────────────────────────────────────────
// Every field the survey collects is rendered, one item per line, with the
// grade legend spelled out. The old single-line dump ("English 9 A; Algebra
// II [honors] A-; …") dropped years/hours/descriptions entirely and was where
// small models transposed grades between neighbouring courses.
export function formatProfileForModel(profile, limits = {}) {
  if (!profile || typeof profile !== "object") return "";
  const maxCourses = limits.maxCourses || CHAT_PROFILE_LIMITS.maxCourses;
  const maxActivities = limits.maxActivities || CHAT_PROFILE_LIMITS.maxActivities;
  const lines = [];

  if (profile.gpaUnweighted != null || profile.gpaWeighted != null) {
    const parts = [];
    if (profile.gpaUnweighted != null) parts.push(`${profile.gpaUnweighted} unweighted`);
    if (profile.gpaWeighted != null) parts.push(`${profile.gpaWeighted} weighted`);
    lines.push(`GPA: ${parts.join(", ")}`);
  } else {
    lines.push("GPA: not recorded");
  }

  const tests = Array.isArray(profile.testScores) ? profile.testScores : [];
  if (tests.length) {
    lines.push(`Test scores: ${tests.map((t) => {
      const label = TEST_LABELS[String(t?.test || "").toLowerCase()] || String(t?.test || "test").toUpperCase();
      const subject = t?.subject ? ` (${t.subject})` : "";
      const date = t?.date ? ` (taken ${t.date})` : "";
      return `${label}${subject} ${t?.totalScore ?? "?"}${date}`;
    }).join("; ")}`);
  } else {
    lines.push("Test scores: none recorded");
  }

  const courses = Array.isArray(profile.courses) ? profile.courses.filter((c) => c && c.name) : [];
  if (courses.length) {
    lines.push(`Courses (${courses.length} recorded; grade legend: a letter is the recorded final grade, "in progress" means no final grade yet, "not recorded" means none was entered — never assume a grade that isn't listed):`);
    for (const course of courses.slice(0, maxCourses)) {
      const year = yearLabel(course.year);
      const type = TYPE_LABELS[String(course.type || "").toLowerCase()] || String(course.type || "regular");
      const semester = String(course.semester || "").toLowerCase();
      const term = semester === "fall" || semester === "spring" ? ` (${semester} semester)` : "";
      lines.push(`  - ${year ? `${year}: ` : ""}${courseDisplayName(course)} — ${type} — ${gradePhrase(course.grade)}${term}`);
    }
    if (courses.length > maxCourses) {
      lines.push(`  (+${courses.length - maxCourses} more courses not shown — ask the student if a specific one matters)`);
    }
  } else {
    lines.push("Courses: none recorded");
  }

  const apScores = Array.isArray(profile.apScores) ? profile.apScores.filter(Boolean) : [];
  if (apScores.length) {
    lines.push(`AP exam scores: ${apScores.map((a) => {
      const name = apExamName(a) || "unnamed exam";
      const year = a?.year ? ` (${a.year})` : "";
      return `AP ${name}: ${a?.score ?? "?"}${year}`;
    }).join("; ")}`);
  }

  const activities = Array.isArray(profile.activities) ? profile.activities.filter((a) => a && a.name) : [];
  if (activities.length) {
    lines.push(`Activities (${activities.length} recorded — hours, years, and descriptions are exactly what the student entered; do not assume more depth than is written):`);
    for (const activity of activities.slice(0, maxActivities)) {
      const parts = [String(activity.name).trim()];
      if (activity.role) parts[0] += ` — ${String(activity.role).trim()}`;
      if (activity.category) parts[0] += ` (${String(activity.category).replace(/_/g, " ")})`;
      const hours = Number(activity.hoursPerWeek);
      const weeks = Number(activity.weeksPerYear);
      if (hours > 0) parts.push(`${hours} hrs/wk${weeks > 0 ? ` × ${weeks} wks/yr` : ""}`);
      else if (weeks > 0) parts.push(`${weeks} wks/yr`);
      const years = Array.isArray(activity.grades) ? activity.grades.filter(Boolean) : [];
      if (years.length) parts.push(`years: ${years.join(", ")}`);
      if (activity.timing && activity.timing !== "school_year") parts.push(`timing: ${String(activity.timing).replace(/_/g, " ")}`);
      const description = String(activity.description || "").replace(/\s+/g, " ").trim();
      if (description) parts.push(`"${description.length > 160 ? `${description.slice(0, 157)}…` : description}"`);
      lines.push(`  - ${parts.join("; ")}`);
    }
    if (activities.length > maxActivities) {
      lines.push(`  (+${activities.length - maxActivities} more activities not shown)`);
    }
  } else {
    lines.push("Activities: none recorded");
  }

  if (profile.majorInterest) lines.push(`Intended major: ${profile.majorInterest}`);
  const goals = (Array.isArray(profile.goals) ? profile.goals : []).map(goalName).filter(Boolean);
  if (goals.length) lines.push(`Goals / target schools: ${goals.join(", ")}`);

  return "STUDENT PROFILE (the student's saved record — every grade, score, course, and activity you mention MUST match it exactly; connect across sections: courses and scores inform EC advice and vice versa; don't ask for data already listed):\n" + lines.join("\n");
}

// ─── Fidelity check ───────────────────────────────────────────────────
// Deterministic, precision-first: only phrasings that unambiguously attribute
// a value to the student are compared, so generic statements ("most T20s
// want 3.9+") never trip it. A miss here is cheap; a false alarm would
// "correct" a right answer, so every pattern below is anchored.

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function courseAliases(course) {
  const name = String(course?.name || "").trim();
  if (name.length < 3) return [];
  const type = String(course?.type || "").toLowerCase();
  const bare = name.replace(/^(?:AP|IB|Honors)\s+/i, "").trim();
  const aliases = new Set([name]);
  if (type === "ap" && bare) aliases.add(`AP ${bare}`);
  if (type === "ib" && bare) aliases.add(`IB ${bare}`);
  if (type === "honors" && bare) { aliases.add(`Honors ${bare}`); aliases.add(`${bare} Honors`); }
  return [...aliases].filter((a) => a.length >= 3).sort((a, b) => b.length - a.length);
}

function aliasRegExp(aliases) {
  return new RegExp(`(?<![A-Za-z0-9])(?:${aliases.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "gi");
}

// "…earned an A- in AP Statistics" / "your B+ for Chemistry" — the grade sits
// just before the course name.
const GRADE_BEFORE_RE = /(?:^|[\s(,;:—–-])(?:(?:an?|your|the|that|his|her|their|with|earned|got|received|has|have|had|holds?|holding|scored|solid|strong)\s+)?([ABCDFabcdf][+\-−–]?)\s+(?:in|for|on)\s+(?:(?:your|the|that|this|his|her|their)\s+)?(?:(?:AP|IB|Honors)\s+)?$/i;
// "AP Statistics (A)" / "AP Statistics: B+" / "Chemistry — A-" / "Chemistry,
// where you earned an A" — the grade follows the course name.
const GRADE_AFTER_RE = /^\s*(?:\(|\[|—|–|-|:|,)?\s*(?:(?:with|where you (?:earned|got|received|have|hold)|in which you (?:earned|got|received))\s+(?:an?\s+)?|(?:final\s+)?grade\s*(?:of|:)?\s*)?([ABCDF][+\-−–]?)(?=[\s).,;:!?\]]|$)/;

// Read a course name that starts right after a level word ("AP ", "Honors "):
// Title-Case tokens (plus connectors like "and"/"of" when the next token is
// capitalized), stopping at the first ordinary word, so "AP English Language
// and Composition both matter" yields "English Language and Composition".
function readCoursePhrase(text, start) {
  const rest = text.slice(start, start + 120);
  const parts = rest.split(/(\s+)/);
  let phrase = "";
  let consumed = 0;
  let words = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (/^\s+$/.test(part)) {
      if (!phrase) break;
      phrase += part;
      consumed += part.length;
      continue;
    }
    const clean = part.replace(/[,.;!?)]+$/, "");
    const next = parts[i + 2] || "";
    const connector = /^(?:and|of|the|&)$/i.test(clean) && /^[A-Z0-9]/.test(next);
    const titled = /^[A-Z0-9][\w&:'’.-]*$/.test(clean);
    if ((!titled && !connector) || words >= 7) break;
    phrase += clean;
    consumed += clean.length;
    words += 1;
    if (part.length !== clean.length) break; // punctuation ended the name
  }
  return { phrase: phrase.trim().replace(/[:\-–]$/, "").trim(), end: start + consumed };
}

function courseLevel(course) {
  const type = String(course?.type || "").toLowerCase();
  return type === "ap" || type === "ib" || type === "honors" ? type : null;
}

function statedCourseGrades(text, aliases, course = null) {
  const found = [];
  const re = aliasRegExp(aliases);
  const level = courseLevel(course);
  let match;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(Math.max(0, start - 70), start);
    const after = text.slice(end, end + 70);
    // "AP Chemistry" is not the record's Honors Chemistry: a level word right
    // before a bare alias that doesn't match the course's level means a
    // different course (handled by the not-on-record check).
    const prefix = (before.match(/\b(AP|IB|Honors)\s+$/i) || [])[1];
    if (prefix && prefix.toLowerCase() !== level) continue;
    const b = before.match(GRADE_BEFORE_RE);
    // The grade letter itself must be upper-case ("a B+ in" is fine, "a in"
    // is not a grade) — the flag above is only for the surrounding words.
    if (b && /^[ABCDF]/.test(b[1])) { found.push(normalizeGrade(b[1])); continue; }
    const a = after.match(GRADE_AFTER_RE);
    if (a) found.push(normalizeGrade(a[1]));
  }
  return found;
}

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;
const SECOND_PERSON_RE = /\b(?:you|your|you're|you've|yours)\b/i;
// Sentences that describe a target, a hypothetical, or other people's numbers
// ("aim for 1550", "a 1500 would help", "admitted students average 3.9") are
// not statements about the student's record and are skipped wholesale.
const GENERIC_STAT_RE = /\b(?:target|goal|aim|aiming|typical|typically|average|median|middle 50|mid-50|percentile|admitted|admits?|admission|applicants?|need|needs|require[sd]?|minimum|at least|threshold|improve|improving|raise|raising|boost|cutoff|would|could|should|if you)\b/i;

function gpaMatchesStated(stated, actual) {
  if (actual == null || !Number.isFinite(Number(actual))) return false;
  const decimals = (String(stated).split(".")[1] || "").length;
  const factor = 10 ** decimals;
  return Math.round(Number(actual) * factor) / factor === Number(stated);
}

function statedGpas(text) {
  const out = [];
  for (const sentence of text.split(SENTENCE_SPLIT_RE)) {
    if (!/\bGPA\b/i.test(sentence) || !SECOND_PERSON_RE.test(sentence) || GENERIC_STAT_RE.test(sentence)) continue;
    const re = /(?<![\d.])(\d\.\d{1,2})(?![\d+%])(?!\s*(?:scale|-point|point))/g;
    let m;
    while ((m = re.exec(sentence))) {
      const lead = sentence.slice(Math.max(0, m.index - 12), m.index);
      if (/(?:on a|out of|of a|\/)\s*$/i.test(lead)) continue; // "on a 4.0 scale"
      out.push(m[1]);
    }
  }
  return out;
}

function statedTestScores(text, label, { min, max, step }) {
  const out = [];
  const labelRe = new RegExp(`\\b${label}\\b`);
  for (const sentence of text.split(SENTENCE_SPLIT_RE)) {
    if (!labelRe.test(sentence) || !SECOND_PERSON_RE.test(sentence) || GENERIC_STAT_RE.test(sentence)) continue;
    // Whole numbers only: not part of a range (1500–1550), a decimal (3.9), a
    // percentage, or a count of something else ("in 2 months").
    const re = /(?<![\d–\-/])(?<!\d\.)\b(\d{1,4})\b(?!\.\d)(?![\d–\-/+%]|\s*(?:months?|weeks?|days?|years?|hours?|times?|points?|percent|th\b|st\b|nd\b|rd\b|credits?|semesters?))/g;
    let m;
    while ((m = re.exec(sentence))) {
      const n = Number(m[1]);
      if (n < min || n > max || n % step !== 0) continue;
      out.push(n);
    }
  }
  return out;
}

const AP_SCORE_BEFORE_RE = /(?:^|[\s(,;:—–-])(?:scored?|score of|got|earned|received|with|an?)\s+([1-5])\s+(?:on|in|for)\s+(?:(?:the|your)\s+)?(?:AP\s+)?(?:exam\s+(?:in|for)\s+)?$/i;
const AP_SCORE_AFTER_RE = /^\s*(?:exam\s*)?(?:\(|:|—|–|-)?\s*(?:score\s*(?:of|:)?\s*)?([1-5])(?![\d.%]|\s*(?:credits?|semesters?|units?|hours?|years?|courses?|classes|weeks?|months?))/;

function statedApScores(text, aliases) {
  const found = [];
  const re = aliasRegExp(aliases);
  let match;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(Math.max(0, start - 60), start);
    const after = text.slice(end, end + 40);
    const b = before.match(AP_SCORE_BEFORE_RE);
    if (b) { found.push(Number(b[1])); continue; }
    const a = after.match(AP_SCORE_AFTER_RE);
    // A bare "(3)" right after an exam name is a score; "AP Physics 1"-style
    // digits are part of the alias and never reach this window.
    if (a && /(?:score|exam|\(|:)/.test(after.slice(0, a[0].length))) found.push(Number(a[1]));
  }
  return found;
}

export function checkProfileFidelity(answerText, profile) {
  const text = String(answerText || "");
  const contradictions = [];
  if (!text.trim() || !profile || typeof profile !== "object") return { contradictions };
  const seen = new Set();
  const add = (entry) => {
    const key = `${entry.kind}|${entry.item}|${entry.stated}`;
    if (seen.has(key)) return;
    seen.add(key);
    contradictions.push(entry);
  };

  for (const course of (Array.isArray(profile.courses) ? profile.courses : [])) {
    const aliases = courseAliases(course);
    if (!aliases.length) continue;
    const display = courseDisplayName(course);
    const actual = isLetterGrade(course.grade) ? normalizeGrade(course.grade) : null;
    for (const stated of statedCourseGrades(text, aliases, course)) {
      if (actual && stated === actual) continue;
      add({
        kind: "course_grade",
        item: display,
        stated,
        actual: actual || (isInProgress(course.grade) ? "in progress — no final grade recorded" : "no grade recorded"),
      });
    }
  }

  // A grade attributed to a course the record doesn't have at all ("your A
  // in AP Chemistry" when no such course was entered). Only AP/IB/Honors-
  // prefixed names are checked — those are unambiguous course references.
  const known = (Array.isArray(profile.courses) ? profile.courses : [])
    .flatMap((c) => courseAliases(c).map((alias) => alias.toLowerCase()));
  const normalizeName = (name) => String(name || "").replace(/[’']/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  // The aliases already carry the level ("AP Statistics" for an AP course
  // stored as "Statistics"), so the phrase must match level and all — the
  // record's Honors Chemistry does not make "AP Chemistry" a real course.
  const onRecord = (name) => {
    const n = normalizeName(name);
    return known.some((k) => k === n);
  };
  const flagInvented = (course, stated) => {
    if (!course || !/^[ABCDF][+-]?$/.test(stated) || onRecord(course)) return;
    add({ kind: "course_not_on_record", item: course, stated, actual: "no such course on the student's record" });
  };
  // "…your A in AP Chemistry and…" — the grade precedes the course.
  // Lead words may open a sentence ("Your A in …"); the grade letter itself
  // stays upper-case only, so an article "a" is never read as a grade.
  const beforeRe = /\b(?:[Aa]n?|[Yy]our|[Tt]he|[Hh]is|[Hh]er|[Tt]heir)\s+([ABCDF][+\-−–]?)\s+(?:in|for|on)\s+(AP|IB|Honors)\s+(?=[A-Z0-9])/g;
  let bm;
  while ((bm = beforeRe.exec(text))) {
    const { phrase } = readCoursePhrase(text, bm.index + bm[0].length);
    if (phrase) flagInvented(`${bm[2]} ${phrase}`, normalizeGrade(bm[1]));
  }
  // "AP Biology (A-)" — the grade follows the course in parentheses.
  const levelRe = /\b(AP|IB|Honors)\s+(?=[A-Z0-9])/g;
  let lm;
  while ((lm = levelRe.exec(text))) {
    const { phrase, end } = readCoursePhrase(text, lm.index + lm[0].length);
    if (!phrase) continue;
    const paren = text.slice(end, end + 30).match(/^\s*\(\s*(?:grade\s*(?:of|:)?\s*)?([ABCDF][+\-−–]?)\s*\)/);
    if (paren) flagInvented(`${lm[1]} ${phrase}`, normalizeGrade(paren[1]));
  }

  const gpas = statedGpas(text);
  if (gpas.length) {
    const hasGpa = profile.gpaUnweighted != null || profile.gpaWeighted != null;
    const actual = hasGpa
      ? [profile.gpaUnweighted != null ? `${profile.gpaUnweighted} unweighted` : null, profile.gpaWeighted != null ? `${profile.gpaWeighted} weighted` : null].filter(Boolean).join(" / ")
      : "no GPA recorded";
    for (const stated of gpas) {
      if (gpaMatchesStated(stated, profile.gpaUnweighted) || gpaMatchesStated(stated, profile.gpaWeighted)) continue;
      add({ kind: "gpa", item: "GPA", stated, actual });
    }
  }

  const tests = Array.isArray(profile.testScores) ? profile.testScores : [];
  const testTotal = (name) => {
    const hit = tests.find((t) => String(t?.test || "").toLowerCase() === name);
    return hit && Number.isFinite(Number(hit.totalScore)) ? Number(hit.totalScore) : null;
  };
  const sat = testTotal("sat");
  for (const stated of statedTestScores(text, "SAT", { min: 400, max: 1600, step: 10 })) {
    if (sat != null && stated === sat) continue;
    add({ kind: "sat", item: "SAT", stated: String(stated), actual: sat != null ? String(sat) : "no SAT score recorded" });
  }
  const act = testTotal("act");
  for (const stated of statedTestScores(text, "ACT", { min: 1, max: 36, step: 1 })) {
    if (act != null && stated === act) continue;
    add({ kind: "act", item: "ACT", stated: String(stated), actual: act != null ? String(act) : "no ACT score recorded" });
  }

  for (const exam of (Array.isArray(profile.apScores) ? profile.apScores : [])) {
    const name = apExamName(exam);
    if (name.length < 3) continue;
    const aliases = [...new Set([name, `AP ${name.replace(/^AP\s+/i, "")}`])].sort((a, b) => b.length - a.length);
    const actual = Number.isFinite(Number(exam?.score)) ? Number(exam.score) : null;
    for (const stated of statedApScores(text, aliases)) {
      if (actual != null && stated === actual) continue;
      add({ kind: "ap_score", item: `AP ${name.replace(/^AP\s+/i, "")} exam`, stated: String(stated), actual: actual != null ? String(actual) : "no score recorded" });
    }
  }

  return { contradictions: contradictions.slice(0, 8) };
}

export function describeContradiction(entry) {
  switch (entry.kind) {
    case "course_grade": return `${entry.item}: recorded ${/^[ABCDF]/.test(entry.actual) ? `grade ${entry.actual}` : entry.actual} (the reply said ${entry.stated})`;
    case "course_not_on_record": return `${entry.item}: not on the student's record at all (the reply gave it a grade of ${entry.stated})`;
    case "gpa": return `GPA: recorded ${entry.actual} (the reply said ${entry.stated})`;
    case "sat": return `SAT: recorded ${entry.actual} (the reply said ${entry.stated})`;
    case "act": return `ACT: recorded ${entry.actual} (the reply said ${entry.stated})`;
    case "ap_score": return `${entry.item}: recorded score ${entry.actual} (the reply said ${entry.stated})`;
    default: return `${entry.item}: recorded ${entry.actual} (the reply said ${entry.stated})`;
  }
}

export function buildFidelityCorrection(contradictions) {
  const lines = contradictions.map((c) => `- ${describeContradiction(c)}`);
  return [
    "FIDELITY CORRECTION — your previous answer misstated the student's saved record. The STUDENT PROFILE is authoritative:",
    ...lines,
    "Rewrite your ENTIRE previous answer using exactly these recorded values (and adjust any reasoning that depended on the wrong value). Keep everything else the same. Do not mention this correction, and do not apologize — just give the corrected answer.",
  ].join("\n");
}

export function buildFidelityFootnote(contradictions, locale = "en-US") {
  if (!contradictions.length) return "";
  const korean = String(locale || "").toLowerCase().startsWith("ko");
  const heading = korean
    ? "_저장된 프로필 기준 정정 — 위 답변의 다음 값은 기록과 다릅니다:_"
    : "_Correction from your saved profile — the reply above misstated these values:_";
  return `\n\n${heading}\n${contradictions.map((c) => `- ${describeContradiction(c)}`).join("\n")}`;
}

// ─── School mentions ──────────────────────────────────────────────────
// Common abbreviations → the institution's IPEDS-style name. Short all-caps
// aliases (BU, MIT, UF…) are matched case-sensitively so ordinary words
// ("bc", "uf") never bind a school. Multi-word official names are matched
// from the baseline table by the caller-supplied `knownNames`.
export const SCHOOL_ALIASES = Object.freeze({
  "MIT": "Massachusetts Institute of Technology",
  "NYU": "New York University",
  "USC": "University of Southern California",
  "UCLA": "University of California-Los Angeles",
  "UCSD": "University of California-San Diego",
  "UCSB": "University of California-Santa Barbara",
  "UCI": "University of California-Irvine",
  "UCSC": "University of California-Santa Cruz",
  "UIUC": "University of Illinois Urbana-Champaign",
  "CMU": "Carnegie Mellon University",
  "UVA": "University of Virginia-Main Campus",
  "UNC": "University of North Carolina at Chapel Hill",
  "UW": "University of Washington-Seattle Campus",
  "BU": "Boston University",
  "BC": "Boston College",
  "JHU": "Johns Hopkins University",
  "WUSTL": "Washington University in St Louis",
  "UF": "University of Florida",
  "UMD": "University of Maryland-College Park",
  "ASU": "Arizona State University",
  "MSU": "Michigan State University",
  "FSU": "Florida State University",
  "UCF": "University of Central Florida",
  "RPI": "Rensselaer Polytechnic Institute",
  "WPI": "Worcester Polytechnic Institute",
  "NJIT": "New Jersey Institute of Technology",
  "OSU": "Ohio State University-Main Campus",
  "UCB": "University of California-Berkeley",
  "caltech": "California Institute of Technology",
  "uc berkeley": "University of California-Berkeley",
  "berkeley": "University of California-Berkeley",
  "uc san diego": "University of California-San Diego",
  "uc santa barbara": "University of California-Santa Barbara",
  "uc irvine": "University of California-Irvine",
  "uc davis": "University of California-Davis",
  "umich": "University of Michigan-Ann Arbor",
  "university of michigan": "University of Michigan-Ann Arbor",
  "ut austin": "The University of Texas at Austin",
  "utexas": "The University of Texas at Austin",
  "georgia tech": "Georgia Institute of Technology-Main Campus",
  "gatech": "Georgia Institute of Technology-Main Campus",
  "penn state": "Pennsylvania State University-Main Campus",
  "upenn": "University of Pennsylvania",
  "penn": "University of Pennsylvania",
  "johns hopkins": "Johns Hopkins University",
  "washu": "Washington University in St Louis",
  "wash u": "Washington University in St Louis",
  "rutgers": "Rutgers University-New Brunswick",
  "virginia tech": "Virginia Tech",
  "texas a&m": "Texas A & M University-College Station",
  "tamu": "Texas A & M University-College Station",
  "uchicago": "University of Chicago",
  "u chicago": "University of Chicago",
  "harvard": "Harvard University",
  "yale": "Yale University",
  "princeton": "Princeton University",
  "stanford": "Stanford University",
  "columbia": "Columbia University in the City of New York",
  "cornell": "Cornell University",
  "dartmouth": "Dartmouth College",
  "duke": "Duke University",
  "northwestern": "Northwestern University",
  "vanderbilt": "Vanderbilt University",
  "emory": "Emory University",
  "georgetown": "Georgetown University",
  "notre dame": "University of Notre Dame",
  "tufts": "Tufts University",
  "northeastern": "Northeastern University",
  "purdue": "Purdue University-Main Campus",
  "amherst": "Amherst College",
  "swarthmore": "Swarthmore College",
  "pomona": "Pomona College",
  "bowdoin": "Bowdoin College",
  "wellesley": "Wellesley College",
  "carleton": "Carleton College",
  "middlebury": "Middlebury College",
  "harvey mudd": "Harvey Mudd College",
  "caltech university": "California Institute of Technology",
});

const MAX_SCHOOL_MENTIONS = 6;

export function detectSchoolMentions(text, { knownNames = [], max = MAX_SCHOOL_MENTIONS } = {}) {
  const source = String(text || "");
  if (!source.trim()) return [];
  const hits = []; // { index, name }
  const push = (index, name) => {
    if (!hits.some((h) => h.name.toLowerCase() === name.toLowerCase())) hits.push({ index, name });
  };

  for (const [alias, canonical] of Object.entries(SCHOOL_ALIASES)) {
    const caseSensitive = alias.length <= 5 && alias === alias.toUpperCase();
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(alias)}(?![A-Za-z0-9])`, caseSensitive ? "g" : "gi");
    for (const m of source.matchAll(re)) {
      // A short code after a course name is an AP exam, not a school: "AP
      // Calculus BC" used to pull Boston College into the VERIFIED DATA
      // block (and "Physics C" is not a school either). Skip that hit and
      // keep looking, so "I took Calc BC; is BC a match?" still finds BC.
      if (caseSensitive && /(?:calculus|physics|calc)\s*$/i.test(source.slice(Math.max(0, m.index - 12), m.index))) continue;
      push(m.index, canonical);
      break;
    }
  }

  const lower = source.toLowerCase();
  for (const known of knownNames) {
    const name = String(known || "").trim();
    if (name.length < 6 || !/\s/.test(name)) continue; // single-word names are too ambiguous
    const at = lower.indexOf(name.toLowerCase());
    if (at < 0) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, "i");
    const m = re.exec(source);
    if (m) push(m.index, name);
  }

  return hits.sort((a, b) => a.index - b.index).slice(0, max).map((h) => h.name);
}

// ─── VERIFIED DATA block ──────────────────────────────────────────────
const C7_LABELS = {
  rigor: "course rigor", class_rank: "class rank", gpa: "GPA", test_scores: "test scores",
  application_essay: "essay", recommendations: "recommendations", interview: "interview",
  ec: "extracurriculars", talent_ability: "talent/ability", character: "character and personal qualities",
  first_generation: "first-generation status", alumni_relation: "legacy", geographical_residence: "geography",
  state_residency: "state residency", religious_affiliation: "religious affiliation",
  racial_ethnic_status: "racial/ethnic status", volunteer_work: "volunteer work",
  work_experience: "work experience", level_of_interest: "demonstrated interest",
};

function percent(rate) {
  if (rate == null || !Number.isFinite(Number(rate))) return null;
  const value = Number(rate);
  return `${Math.round((value <= 1 ? value * 100 : value) * 10) / 10}%`;
}

function range(low, high) {
  if (low == null && high == null) return null;
  if (low != null && high != null) return `${low}–${high}`;
  return String(low ?? high);
}

function baselineLine(row) {
  if (!row) return null;
  const parts = [];
  const admit = percent(row.acceptance_rate);
  if (admit) parts.push(`acceptance rate ${admit}`);
  const sat = range(row.sat_25, row.sat_75);
  if (sat) parts.push(`SAT middle 50% ${sat}`);
  const act = range(row.act_25, row.act_75);
  if (act) parts.push(`ACT middle 50% ${act}`);
  if (row.avg_gpa_admitted != null) parts.push(`average admitted GPA ${row.avg_gpa_admitted}`);
  if (row.enrollment != null) parts.push(`enrollment ${formatNumber(row.enrollment)}`);
  if (row.tuition_out != null || row.tuition_in != null) {
    // No "$" — the provider-boundary redaction masks every dollar amount as
    // an income token, and the model would see "[ANNUAL_INCOME_01]".
    const tuition = [];
    if (row.tuition_in != null) tuition.push(`in-state ${formatNumber(row.tuition_in)} USD`);
    if (row.tuition_out != null) tuition.push(`out-of-state ${formatNumber(row.tuition_out)} USD`);
    parts.push(`tuition ${tuition.join(" / ")}`);
  }
  if (row.retention_rate != null) parts.push(`first-year retention ${percent(row.retention_rate)}`);
  if (row.grad_rate_6yr != null) parts.push(`6-year graduation rate ${percent(row.grad_rate_6yr)}`);
  if (!parts.length) return null;
  const source = `${row.source || "NCES IPEDS"}${row.data_year ? `, data year ${row.data_year}` : ""}`;
  return `${parts.join("; ")} [Source: ${source}]`;
}

function cdsLine(record, validated) {
  if (!record) return null;
  const parts = [];
  const admit = percent(record.overallAdmitRate);
  if (admit) parts.push(`admit rate ${admit}`);
  if (record.yieldRate != null) parts.push(`yield ${percent(record.yieldRate)}`);
  const sat = range(record.enrolledSAT?.p25, record.enrolledSAT?.p75);
  if (sat) parts.push(`enrolled SAT middle 50% ${sat}`);
  const act = range(record.enrolledACT?.p25, record.enrolledACT?.p75);
  if (act) parts.push(`enrolled ACT middle 50% ${act}`);
  if (record.enrolledGPA?.avg != null) parts.push(`average enrolled GPA ${record.enrolledGPA.avg}`);
  if (record.testPolicy) parts.push(`test policy: ${String(record.testPolicy).replace(/_/g, " ")}`);
  const c7 = record.c7 && typeof record.c7 === "object" ? record.c7 : {};
  const veryImportant = Object.entries(c7).filter(([, v]) => v === "very_important").map(([k]) => C7_LABELS[k] || k.replace(/_/g, " "));
  const important = Object.entries(c7).filter(([, v]) => v === "important").map(([k]) => C7_LABELS[k] || k.replace(/_/g, " "));
  if (veryImportant.length) parts.push(`admissions factors rated very important: ${veryImportant.join(", ")}`);
  if (important.length) parts.push(`rated important: ${important.join(", ")}`);
  if (!parts.length) return null;
  const cycle = record.yearLabel || (record.year != null ? String(record.year) : "");
  const label = `${record.school || "the school"} Common Data Set${cycle ? ` ${cycle}` : ""}${validated ? " (validated against ground truth)" : " (unverified parse)"}`;
  // Only an official host is worth showing the student as a link; a Drive
  // or repository download URL reads as junk in an answer's "Sources:".
  const host = hostOf(record.sourceUrl);
  const officialLink = host && /\.edu$/.test(host) ? record.sourceUrl : null;
  return `${parts.join("; ")} [Source: ${label}, ${officialLink || "official PDF on file"}]`;
}

function hostOf(url) {
  try { return new URL(String(url || "")).hostname.toLowerCase(); } catch { return ""; }
}

function factLine(fact) {
  const value = String(fact?.fact_value ?? fact?.claim ?? fact?.statement ?? "").trim();
  if (!value) return null;
  const key = String(fact?.fact_key || "").replace(/_/g, " ").trim();
  const entity = String(fact?.entity_name || "").trim();
  const source = [fact?.source_domain, fact?.academic_year].filter(Boolean).join(", ");
  return `- ${entity ? `${entity}: ` : ""}${key ? `${key} — ` : ""}${value}${source ? ` [Source: ${source}]` : ""}`;
}

// The student's own College Fit read for a school, so the counselor quotes
// the same label the card shows — plus the web double-check's verdict.
function fitReadLine(read) {
  if (!read || !read.label) return null;
  const date = String(read.computedAt || "").slice(0, 10);
  const provenance = read.provenance?.kind
    ? ({ cds_store: "validated Common Data Set", cds_live: "live Common Data Set (unverified)", cds_web: "AI web-read CDS (unverified)", college_scorecard: "College Scorecard", baseline_only: "IPEDS baseline" }[read.provenance.kind] || read.provenance.kind)
    : "stored data";
  const dims = [];
  if (read.admissibility != null) dims.push(`admissibility ${Math.round(read.admissibility)}/100`);
  if (read.competitiveness != null) dims.push(`competitiveness ${Math.round(read.competitiveness)}/100`);
  if (read.fit != null) dims.push(`fit ${Math.round(read.fit)}/100`);
  let line = `College Fit read for THIS student (computed ${date} from ${provenance}): ${read.label}`;
  if (dims.length) line += ` — ${dims.join(", ")}`;
  if (read.confidence) line += `; evidence confidence ${read.confidence}`;
  line += ". Use this exact label when the student asks how they stand here.";
  if (read.verification) line += ` ${formatVerificationLine(read.verification)}.`;
  return line;
}

export function formatVerifiedDataBlock({ schools = [], facts = [] } = {}) {
  const lines = [];
  for (const school of schools) {
    const base = baselineLine(school.baseline);
    const cds = cdsLine(school.cds, school.cdsValidated);
    const fit = fitReadLine(school.fitRead);
    if (!base && !cds && !school.policyLine && !fit) continue;
    const name = `${school.name}${school.state ? ` (${school.state})` : ""}`;
    let opened = false;
    if (base) { lines.push(`- ${name}: ${base}`); opened = true; }
    if (cds) { lines.push(opened ? `  ${cds}` : `- ${name}: ${cds}`); opened = true; }
    // Current admissions policy from the daily official-site scout.
    if (school.policyLine) { lines.push(opened ? `  ${school.policyLine}` : `- ${name}: ${school.policyLine}`); opened = true; }
    if (fit) lines.push(opened ? `  ${fit}` : `- ${name}: ${fit}`);
  }
  for (const fact of facts) {
    const line = factLine(fact);
    if (line) lines.push(line);
  }
  if (!lines.length) return "";
  return "VERIFIED DATA (the ONLY statistics you may cite — quote each figure exactly as written here and attribute it with the bracketed source; if a number you need is not listed, say you don't have verified data for it and point the student to nces.ed.gov/ipeds or the school's Common Data Set; never estimate a statistic from memory, and never attach a source to a figure that is not listed here):\n" + lines.join("\n");
}
