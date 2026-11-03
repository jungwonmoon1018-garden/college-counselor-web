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
//   detectSchoolMentions    — which colleges a question names (abbreviations
//                             in any case, Hangul names, official names)
//   unresolvedSchoolNames   — college names a question gives that match none
//   formatVerifiedDataBlock — the VERIFIED DATA block (IPEDS baseline, CDS,
//                             research-cache facts) the model may cite from,
//                             and the named schools nothing is held for

import { formatVerificationLine } from "../colleges/fit-verifier.js";
import { TEST_CATALOG, testKey, testLabel, sectionEntries, formatSections, formatClassRank, normalizeClassRank, deriveTotal } from "../academics/test-catalog.js";
import { AP_EXAMS, apExamAliases, apExamKey, apExamOnlyAliases } from "../academics/ap-exams.js";
import { t } from "../shared/i18n.js";
import { writeMoneyAsUsd } from "./content-moderation.js";
import { readCdsTestPolicy } from "../cds/cds-store.js";

export const CHAT_PROFILE_LIMITS = Object.freeze({ maxCourses: 40, maxActivities: 20 });

const YEAR_LABELS = {
  freshman: "freshman", sophomore: "sophomore", junior: "junior", senior: "senior",
  9: "freshman", 10: "sophomore", 11: "junior", 12: "senior",
};

const TYPE_LABELS = {
  regular: "regular", elective: "elective", honors: "Honors", ap: "AP", ib: "IB",
  dual_enrollment: "dual enrollment",
};

function yearLabel(value) {
  const key = presentText(value).toLowerCase()
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
  const raw = presentText(grade);
  return raw ? `grade ${raw}` : "grade not recorded";
}

function goalName(goal) {
  if (goal == null) return "";
  if (typeof goal === "string") return presentText(goal);
  return presentText(goal.school || goal.schoolName || goal.name || "");
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

// "12th grade (senior)" for a recorded grade 9-12, else null.
const GRADE_LEVEL_NAMES = { 9: "freshman", 10: "sophomore", 11: "junior", 12: "senior" };
function gradeLevelLabel(grade, locale = "en-US") {
  const n = Number(grade);
  if (!GRADE_LEVEL_NAMES[n]) return null;
  return String(locale).toLowerCase().startsWith("ko") ? `${n}학년` : `${n}th grade (${GRADE_LEVEL_NAMES[n]})`;
}

// ─── STUDENT PROFILE block ────────────────────────────────────────────
// Every field the survey collects is rendered, one item per line, with the
// grade legend spelled out. The old single-line dump ("English 9 A; Algebra
// II [honors] A-; …") dropped years/hours/descriptions entirely and was where
// small models transposed grades between neighbouring courses.
//
// Nothing reaches the model as a bare "null": a GPA object of two nulls (the
// profile route's shape for a student with no GPA) used to print "GPA:
// null", and a missing score "SAT ?". An absent value says it is absent, and
// the student's own "no GPA yet" / "not taken yet" is passed on so the
// model neither asks again nor fills one in.
export function formatProfileForModel(profile, limits = {}) {
  if (!profile || typeof profile !== "object") return "";
  const maxCourses = limits.maxCourses || CHAT_PROFILE_LIMITS.maxCourses;
  const maxActivities = limits.maxActivities || CHAT_PROFILE_LIMITS.maxActivities;
  const lines = [];

  // The grade the student is in today, which the server computes from their
  // class (getStudentGrade). Without it the model could not tell a freshman
  // from a senior, and a senior with no courses entered got a junior-year
  // plan in November of senior year (fid-5).
  const gradeLevel = gradeLevelLabel(profile.gradeLevel);
  if (gradeLevel) lines.push(`Grade level: ${gradeLevel}`);

  const gpaUnweighted = finiteNumber(profile.gpaUnweighted ?? profile.gpa?.unweighted);
  const gpaWeighted = finiteNumber(profile.gpaWeighted ?? profile.gpa?.weighted);
  if (gpaUnweighted != null || gpaWeighted != null) {
    const parts = [];
    if (gpaUnweighted != null) parts.push(`${gpaUnweighted} unweighted`);
    if (gpaWeighted != null) parts.push(`${gpaWeighted} weighted`);
    lines.push(`GPA: ${parts.join(", ")}`);
  } else if (String(profile.gpaStatus || "") === "pending") {
    lines.push("GPA: none yet (the student says they don't have a GPA yet — never state or estimate one)");
  } else {
    lines.push("GPA: not recorded");
  }

  const tests = (Array.isArray(profile.testScores) ? profile.testScores : []).filter((t) => t && typeof t === "object");
  if (tests.length) {
    lines.push(`Test scores: ${tests.map((t) => {
      const label = testLabel(t.test);
      const subject = presentText(t.subject) ? ` (${presentText(t.subject)})` : "";
      const date = presentText(t.date) ? ` (taken ${presentText(t.date)})` : "";
      // Section scores ride with the total (SAT Reading & Writing and Math,
      // ACT English / Math / Reading / Science, the TOEFL and IELTS parts) so
      // the model compares them against a school's section bands instead of
      // guessing a split.
      const sections = formatSections(t);
      const total = finiteNumber(t.totalScore);
      return `${label}${subject} ${total != null ? total : "(total not recorded)"}${sections ? ` (${sections})` : ""}${date}`;
    }).join("; ")}`);
  } else if (String(profile.testingStatus || "") === "planned") {
    lines.push("Test scores: none yet (the student hasn't taken a test yet)");
  } else {
    lines.push("Test scores: none recorded");
  }
  const classRank = formatClassRank(profile.classRank);
  if (classRank) lines.push(`Class rank: ${classRank}`);

  const courses = Array.isArray(profile.courses) ? profile.courses.filter((c) => c && presentText(c.name)) : [];
  if (courses.length) {
    lines.push(`Courses (${courses.length} recorded; grade legend: a letter is the recorded final grade, "in progress" means no final grade yet, "not recorded" means none was entered — never assume a grade that isn't listed):`);
    for (const course of courses.slice(0, maxCourses)) {
      const year = yearLabel(course.year);
      const type = TYPE_LABELS[presentText(course.type).toLowerCase()] || presentText(course.type) || "regular";
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

  // "None recorded" is said outright, as for tests and courses: with no line
  // at all the model was never told the student has no AP exam score, and a
  // 5 on an AP course still in progress went unchallenged.
  const apScores = Array.isArray(profile.apScores) ? profile.apScores.filter((a) => a && typeof a === "object") : [];
  if (apScores.length) {
    lines.push(`AP exam scores: ${apScores.map((a) => {
      const name = apExamName(a) || "unnamed exam";
      const year = presentText(a.year) ? ` (${presentText(a.year)})` : "";
      const score = finiteNumber(a.score);
      return `AP ${name}: ${score != null ? score : "score not recorded"}${year}`;
    }).join("; ")}`);
  } else {
    lines.push("AP exam scores: none recorded");
  }

  const activities = Array.isArray(profile.activities) ? profile.activities.filter((a) => a && presentText(a.name)) : [];
  if (activities.length) {
    lines.push(`Activities (${activities.length} recorded — hours, years, and descriptions are exactly what the student entered; do not assume more depth than is written):`);
    // The activity's own text writes money as "4,500 USD": the provider
    // redactor masks a "$" figure as an income token, so "earned $15/hr" and
    // "raised $4,500" reached the model as [ANNUAL_INCOME_nn]. Goals and the
    // major are left alone, since a family income could appear there.
    for (const activity of activities.slice(0, maxActivities)) {
      const parts = [writeMoneyAsUsd(presentText(activity.name))];
      if (presentText(activity.role)) parts[0] += ` — ${writeMoneyAsUsd(presentText(activity.role))}`;
      if (presentText(activity.category)) parts[0] += ` (${presentText(activity.category).replace(/_/g, " ")})`;
      const hours = Number(activity.hoursPerWeek);
      const weeks = Number(activity.weeksPerYear);
      if (hours > 0) parts.push(`${hours} hrs/wk${weeks > 0 ? ` × ${weeks} wks/yr` : ""}`);
      else if (weeks > 0) parts.push(`${weeks} wks/yr`);
      const years = Array.isArray(activity.grades) ? activity.grades.map(presentText).filter(Boolean) : [];
      if (years.length) parts.push(`years: ${years.join(", ")}`);
      if (presentText(activity.timing) && activity.timing !== "school_year") parts.push(`timing: ${presentText(activity.timing).replace(/_/g, " ")}`);
      const description = writeMoneyAsUsd(presentText(activity.description)).replace(/\s+/g, " ").trim();
      if (description) parts.push(`"${description.length > 160 ? `${description.slice(0, 157)}…` : description}"`);
      lines.push(`  - ${parts.join("; ")}`);
    }
    if (activities.length > maxActivities) {
      lines.push(`  (+${activities.length - maxActivities} more activities not shown)`);
    }
  } else {
    lines.push("Activities: none recorded");
  }

  if (presentText(profile.majorInterest)) lines.push(`Intended major: ${presentText(profile.majorInterest)}`);
  const goals = (Array.isArray(profile.goals) ? profile.goals : []).map(goalName).filter(Boolean);
  if (goals.length) lines.push(`Goals / target schools: ${goals.join(", ")}`);

  return "STUDENT PROFILE (the student's saved record — every grade, score, course, and activity you mention MUST match it exactly; connect across sections: courses and scores inform EC advice and vice versa; don't ask for data already listed):\n" + lines.join("\n");
}

// ─── Fidelity check ───────────────────────────────────────────────────
// Deterministic, precision-first: only phrasings that unambiguously attribute
// a value to the student are compared, so generic statements ("most T20s
// want 3.9+") never trip it. A miss here is cheap; a false alarm would
// "correct" a right answer, so every pattern below is anchored.
//
// A value is the student's only when the clause that states it ties it to
// them: "your SAT of 1450", "your 1450 SAT", "you scored a 5 on AP
// Statistics", "학생의 SAT 1500점". Until 2026-11-03 the check took every
// number in any sentence that said "your" and "SAT", so "Your SAT of 1450 is
// 60 points below Stanford's 1510" read as a misstated 1510, and the retry
// told the model to rewrite the school's verified figure; "If your GPA is
// around 3.8" was an invented GPA and "An A in AP Calculus BC would help" a
// misstated grade. A school's number ("Stanford's 1510", "the 3.75–4.0
// range") is never bound to the student, and a clause that plans,
// conditions or generalizes is skipped, in English and in Korean.

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A finite number from a stored value, or null. "null", "", NaN and the
// like are not values: a GPA stored as an empty string must not reach the
// model as "GPA: null" or be compared as 0.
function finiteNumber(value) {
  if (value == null || typeof value === "boolean") return null;
  const raw = String(value).replace(/,/g, "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Text worth printing: never a bare "null" or "undefined".
function presentText(value) {
  if (value == null) return "";
  const text = String(value).trim();
  return /^(?:null|undefined|nan)$/i.test(text) ? "" : text;
}

const HANGUL_RE = /[가-힣]/;

// Where a clause ends: a sentence end, a semicolon or comma, or a word that
// starts a comparison or a contrast, so "your 1450 is higher than Michigan's
// 1350" keeps 1350 out of the student's clause.
const CLAUSE_BOUNDARY_SOURCE = String.raw`[.!?](?=\s|$)|[;\n]|,|\s(?:but|while|whereas|although|though|yet|compared (?:with|to)|versus|vs|than|unlike|except)(?=[\s.])`;

function clauseAround(text, start, end) {
  const re = new RegExp(CLAUSE_BOUNDARY_SOURCE, "gi");
  let from = 0;
  let to = text.length;
  let m;
  while ((m = re.exec(text))) {
    const close = m.index + m[0].length;
    if (close <= start) from = close;
    else if (m.index >= end) { to = m.index; break; }
  }
  return { lead: text.slice(from, start), tail: text.slice(end, to), whole: text.slice(from, to) };
}

// Before the value: words that make the clause a plan, a condition, a group
// of other people or a requirement ("aim for", "if your", "admitted
// students", "you'd need"). After it, for a value the clause does not tie
// to the student ("An A in AP Calculus BC would help"): a modal, a
// requirement, a credit policy or a term still to come.
const LEAD_HEDGE_RE = /\b(?:if|once|unless|whether|suppose|supposing|assuming|imagine|say|when|whenever|aim|aims|aiming|target|targets|targeting|goal|goals|hope|hoping|plan|plans|planning|try|trying|strive|striving|want|wants|wanting|need|needs|needed|require|requires|required|requirement|minimum|least|would|could|should|might|may|can|will|must|getting|earning|scoring|landing|get|earn|raise|raising|boost|boosting|improve|improving|retake|retaking|typical|typically|average|median|percentile|middle 50|mid-50|admitted|admits?|accepted|enrolled|applicants?|students|peers|classmates|threshold|cutoff)\b|['’](?:ll|d)\b/i;
const TAIL_HEDGE_RE = /\b(?:would|could|should|might|may|can|will|must|need|needs|require|requires|matter|matters|help|helps|count|counts|credit|credits|earns?|qualif(?:y|ies)|unless|if|once|this (?:year|semester|spring|fall|term)|next (?:year|semester|spring|fall|term|may))\b|['’](?:ll|d)\b/i;
const NEGATION_RE = /\b(?:not|never|no|without|neither|nor)\b|n['’]t\b/i;
// Korean puts the verb last, so the whole clause is read: an average, an
// admitted class, a goal, a minimum, a condition (-면, -다면), a credit
// policy, a negation.
const KO_HEDGE_RE = /(?:평균|중간|중앙값|백분위|퍼센타일|합격자|합격생|합격한|지원자|지원한|입학생|입학한|신입생|재학생|학생들|많은|대부분|다른\s*학생|일반적|보통|목표|최소|이상|이하|미만|초과|필요|만약|정도|기준|범위|커트라인|요구|권장|예상|예측|추정|희망|받으면|받는다면|받아야|받을|받으려|나오면|넘으면|되면|이라면|이면|라면|다면|으면|상위\s*\d|하위\s*\d|학점\s*인정|인정받)/;
const KO_NEGATION_RE = /(?:않|없|못|아니)/;
// The model addresses the student as 학생 / 당신 / 본인 / 귀하.
const KO_STUDENT_RE = /(?<![가-힣])(?:학생|당신|본인|귀하)(?:님)?(?:의|은|는|이|가|께서)?(?![가-힣])/;
const KO_RECEIVED_RE = /(?:받았|받으셨|나왔|기록했|취득했)/;
const SECOND_PERSON_SUBJECT_RE = /\b[Yy]ou(?:['’](?:re|ve))?\b/;

// Whether a value stated between start and end belongs to the student's
// record. `possessed` says the phrase itself ties it to the student ("your
// A in", "you scored a 5 on", "(A-)"), so a modal after it ("Your 1500 SAT
// should help") still states the record; an untied phrase counts only in a
// clause with no hedge on either side.
function attributed(text, start, end, possessed) {
  const { lead, tail, whole } = clauseAround(text, start, end);
  if (LEAD_HEDGE_RE.test(lead) || NEGATION_RE.test(lead)) return false;
  if (HANGUL_RE.test(whole) && (KO_HEDGE_RE.test(whole) || KO_NEGATION_RE.test(whole))) return false;
  if (!possessed && (TAIL_HEDGE_RE.test(tail) || NEGATION_RE.test(tail))) return false;
  return true;
}

// ─── Course grades ────────────────────────────────────────────────────
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

function aliasRegExp(aliases, flags = "gi") {
  return new RegExp(`(?<![A-Za-z0-9])(?:${aliases.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, flags);
}

// "…earned an A- in AP Statistics" / "your B+ for Chemistry" — the grade sits
// just before the course name.
const GRADE_BEFORE_RE = /(?<pre>(?:^|[\s(,;:—–-])(?:(?:an?|your|the|that|his|her|their|with|earned|got|received|has|have|had|holds?|holding|scored|solid|strong)\s+)?)(?<grade>[ABCDFabcdf][+\-−–]?)\s+(?:in|for|on)\s+(?:(?:your|the|that|this|his|her|their)\s+)?(?:(?:AP|IB|Honors)\s+)?$/i;
// The grade is the student's when "your" or "you earned" sits right before it.
const GRADE_POSSESSED_RE = /(?:\b[Yy]our\s+(?:(?:solid|strong|excellent|great|good|current|final|recorded|semester)\s+)?|\b[Yy]ou(?:['’]ve|\s+have|\s+had|\s+already)?\s+(?:earned|got|gotten|received|scored|have|had|hold|made|pulled|kept|maintained)\s+(?:an?\s+|your\s+)?)$/;
// The record's own notation after the name: "AP Statistics (A)", "AP
// Statistics: B+", "Chemistry — A-", "Chemistry, where you earned an A". A
// colon or dash form must end at the grade ("Chemistry: A strong course"
// is a sentence, not a grade).
const GRADE_RECORD_RE = /^\s*(?:[([]\s*(?:grade\s*(?:of|:)?\s*)?([ABCDF][+\-−–]?)\s*[)\]]|(?::|—|–|-)\s*(?:grade\s*(?:of|:)?\s*)?([ABCDF][+\-−–]?)(?=\s*(?:[).,;!?\]]|$)|\s+(?:and|in|for)\b|\s*\()|,?\s*(?:where|in which)\s+you(?:['’]ve)?\s+(?:earned|got|gotten|received|have|hold|had)\s+(?:an?\s+)?([ABCDF][+\-−–]?)(?=[\s).,;:!?\]]|$))/;
// "Your AP Calculus BC A shows…", "…with an A", "…grade of A".
const GRADE_BARE_AFTER_RE = /^\s+(?:with\s+an?\s+|(?:final\s+)?grade\s*(?:of|:)?\s*)?([ABCDF][+\-−–]?)(?=[\s).,;:!?\]]|$)/;
// Korean: "AP Statistics에서 받은 A", "AP Statistics 성적 A", "…에서 A를".
const KO_GRADE_AFTER_RE = /^\s*(?=[가-힣])(?:(?:에서|의|과목에서|수업에서|과목|수업|은|는|이|가)\s*)?(?:받은\s*)?(?:(?:최종\s*)?(?:성적|학점)\s*(?:은|는|이|가|:)?\s*)?([ABCDF][+\-−–]?)(?=\s*(?:학점|를|을|은|는|이|가|로|으로|과|와|입니다|이며|이고|이라|라는|받|등급)|[\s).,;:!?\]]|$)/;
// A name that runs on past the alias ("English 9", "Algebra II", "Biology
// Honors", "Calculus BC") names a different course.
const NAME_CONTINUES_RE = /^\s+(?:[A-Z][a-z]|[A-Z]{2,}\b|\d|I{1,3}\b|IV\b|V\b)/;
// Capitalized words that may stand right before a course name without
// being part of it.
const LEAD_IN_WORDS = new Set(["Your", "Our", "My", "The", "A", "An", "In", "And", "With", "For", "On", "Of", "To", "At", "By", "As", "If", "When", "While", "Since", "Because", "Both", "Also", "Plus", "But", "Its", "His", "Her", "Their", "That", "This", "These", "Those", "Keep", "Taking", "Take", "Took", "Then", "Now", "So", "Strong", "Solid", "Great", "Good", "Excellent", "Earning", "Getting", "Get", "Got", "Earned", "Received", "Scored", "Consider", "Adding", "Is", "Was", "Are", "Were", "You", "Final"]);

// Read a course name that starts right after a level word ("AP ", "Honors "):
// Title-Case tokens (plus connectors like "and"/"of" when the next token is
// capitalized), stopping at the first ordinary word, so "AP English Language
// and Composition both matter" yields "English Language and Composition". A
// Korean particle glued to the last word ("AP Biology에서") ends the name
// the way punctuation does.
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
    const clean = part.replace(/[,.;!?)]+$/, "").replace(/[가-힣].*$/, "");
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

// Courses that share a name and level are one course on the record: a fall
// and a spring semester, or band in 9th and 10th grade. Each used to check
// every mention against its own grade only, so "Your A- in Honors
// Chemistry in the fall" was "corrected" to the spring B+.
function courseGroupKey(course) {
  const bare = String(course?.name || "").trim()
    .replace(/^(?:AP|IB|Honors)\s+/i, "").replace(/\s+Honors$/i, "")
    .replace(/\s+/g, " ").toLowerCase();
  return `${courseLevel(course) || "regular"}|${bare}`;
}

// The grade a mention states for the course named between start and end,
// or null when the mention states none the student holds.
function gradeAtSpan(text, start, end) {
  const before = text.slice(Math.max(0, start - 70), start);
  const after = text.slice(end, end + 70);
  const b = before.match(GRADE_BEFORE_RE);
  // The grade letter itself must be upper-case ("a B+ in" is fine, "a in"
  // is not a grade) — the flag above is only for the surrounding words.
  if (b && /^[ABCDF]/.test(b.groups.grade) && !NAME_CONTINUES_RE.test(after)) {
    const at = start - before.length + b.index + b.groups.pre.length;
    const possessed = GRADE_POSSESSED_RE.test(text.slice(Math.max(0, at - 40), at));
    return attributed(text, at, end, possessed) ? normalizeGrade(b.groups.grade) : null;
  }
  const record = after.match(GRADE_RECORD_RE);
  if (record) {
    const grade = record[1] || record[2] || record[3];
    return attributed(text, start, end + record[0].length, true) ? normalizeGrade(grade) : null;
  }
  const bare = after.match(GRADE_BARE_AFTER_RE);
  if (bare) {
    const possessed = /\b[Yy]our\s+(?:\w+\s+)?$|\b[Yy]ou(?:['’]ve)?\s+(?:finished|completed|took|ended|passed|aced)\s+(?:the\s+)?$/.test(text.slice(Math.max(0, start - 30), start));
    return attributed(text, start, end + bare[0].length, possessed) ? normalizeGrade(bare[1]) : null;
  }
  const ko = after.match(KO_GRADE_AFTER_RE);
  if (ko) return attributed(text, start, end + ko[0].length, false) ? normalizeGrade(ko[1]) : null;
  return null;
}

// Every mention of an on-record course, attributed to the longest recorded
// name that covers it: "World History (A)" is World History, not the
// record's History, and "Marine Biology (A)" is not its Biology.
function courseMentions(text, groups) {
  const spans = [];
  for (const group of groups) {
    const re = aliasRegExp([...group.aliases].sort((a, b) => b.length - a.length));
    for (const m of text.matchAll(re)) spans.push({ group, start: m.index, end: m.index + m[0].length });
  }
  const kept = spans.filter((s) => !spans.some((o) => o !== s && o.start <= s.start && o.end >= s.end && (o.end - o.start) > (s.end - s.start)));
  const bySpan = new Map();
  for (const span of kept) {
    const before = text.slice(Math.max(0, span.start - 70), span.start);
    // "AP Chemistry" is not the record's Honors Chemistry: a level word right
    // before a bare alias that doesn't match the course's level means a
    // different course (handled by the not-on-record check).
    const prefix = (before.match(/\b(AP|IB|Honors)\s+$/i) || [])[1];
    if (prefix && prefix.toLowerCase() !== span.group.level) continue;
    // A capitalized word right before the name that is not a lead-in ("US"
    // in "AP US History", "Studio" in "Studio Art") makes it a longer name.
    // A word that ends a sentence ("…on AP Statistics. Chemistry (A)") does
    // not, unless it is an initialism ("U.S. History").
    const word = (before.match(/(?:^|[^A-Za-z0-9'’&.-])([A-Z][A-Za-z0-9.&'’-]*)\s+$/) || [])[1];
    const continuesName = word && (!/[.]$/.test(word) || /^(?:[A-Z]\.){2,}$/.test(word));
    if (continuesName && !prefix && !LEAD_IN_WORDS.has(word)) continue;
    const key = `${span.start}:${span.end}`;
    const entry = bySpan.get(key) || { start: span.start, end: span.end, groups: [] };
    if (!entry.groups.includes(span.group)) entry.groups.push(span.group);
    bySpan.set(key, entry);
  }
  return [...bySpan.values()].sort((a, b) => a.start - b.start);
}

const PASS_FAIL_RE = /^(?:P|PASS|PASSED|S|SAT|SATISFACTORY|CR|CREDIT|NP|NC|U|NO CREDIT)$/i;

function gradeState(grade) {
  if (isLetterGrade(grade)) return "letter";
  if (isInProgress(grade)) return "in_progress";
  const raw = presentText(grade);
  if (!raw) return "none";
  return PASS_FAIL_RE.test(raw) ? "pass_fail" : "other";
}

function courseNotes(course) {
  const year = yearKey(course?.year);
  const semester = String(course?.semester || "").toLowerCase();
  return {
    ...(year ? { year } : {}),
    ...(semester === "fall" || semester === "spring" ? { term: semester } : {}),
  };
}

function yearKey(value) {
  const label = yearLabel(presentText(value));
  return ["freshman", "sophomore", "junior", "senior"].includes(label) ? label : null;
}

// What the record holds for a set of same-named courses, as the
// contradiction's `actual` (English) plus the parts the footnote
// localizes. A recorded P or 95 is a grade on the record, not "no grade".
function recordedCourseGrades(courses) {
  if (courses.length === 1) {
    const grade = courses[0].grade;
    const state = gradeState(grade);
    const raw = presentText(grade);
    if (state === "letter") return { state, actual: normalizeGrade(grade), recorded: { items: [{ value: normalizeGrade(grade) }] } };
    if (state === "in_progress") return { state, actual: "in progress — no final grade recorded" };
    if (state === "pass_fail") return { state, actual: `${raw} (pass/fail)`, recorded: { items: [{ value: raw, passFail: true }] } };
    if (state === "other") return { state, actual: raw, recorded: { items: [{ value: raw }] } };
    return { state: "none", actual: "no grade recorded" };
  }
  const items = courses.map((course) => {
    const state = gradeState(course.grade);
    const notes = courseNotes(course);
    if (state === "in_progress") return { state: "in_progress", ...notes };
    if (state === "none") return { state: "none", ...notes };
    const value = state === "letter" ? normalizeGrade(course.grade) : presentText(course.grade);
    return { value, ...(state === "pass_fail" ? { passFail: true } : {}), ...notes };
  });
  const recorded = { items };
  return { state: "multiple", actual: formatRecordedItems(recorded, "en-US"), recorded };
}

// ─── Test scores, GPA, class rank ─────────────────────────────────────
// One binding builder serves every test in the catalog and the GPA: the
// label next to the value, the student's possessive or "you scored", and
// the Korean forms. PSAT and the SAT Subject Tests are told apart from the
// SAT by their labels, so a PSAT figure is never read as an SAT.
const TEST_LABEL_SOURCES = Object.freeze({
  sat: String.raw`(?<![A-Za-z])SAT(?![A-Za-z])(?!\s*Subject)`,
  psat: String.raw`(?<![A-Za-z])(?:PSAT(?:\s*\/\s*NMSQT|\s+10(?!\d)|\s+8\/9)?|NMSQT)(?![A-Za-z])`,
  act: String.raw`(?<![A-Za-z])ACT(?![A-Za-z])`,
  toefl: String.raw`(?<![A-Za-z])TOEFL(?:\s+iBT)?(?![A-Za-z])`,
  ielts: String.raw`(?<![A-Za-z])IELTS(?:\s+Academic)?(?![A-Za-z])`,
  duolingo: String.raw`(?<![A-Za-z])(?:Duolingo(?:\s+English\s+Test)?|DET)(?![A-Za-z])`,
  sat_subject: String.raw`(?<![A-Za-z])SAT\s+Subject\s+Tests?(?![A-Za-z])`,
  clep: String.raw`(?<![A-Za-z])CLEP(?![A-Za-z])`,
});
const SAT_SECTION_SOURCE = String.raw`[Mm]ath(?:ematics)?|[Rr]eading\s*(?:&|and)\s*[Ww]riting|R&W|EBRW|ERW|[Rr]eading|[Ww]riting|[Vv]erbal|수학|읽기(?:\s*(?:및|와|&)\s*쓰기)?|쓰기`;
const LANGUAGE_SECTION_SOURCE = String.raw`[Rr]eading|[Ll]istening|[Ss]peaking|[Ww]riting|읽기|듣기|말하기|쓰기|리딩|리스닝|스피킹|라이팅`;
const TEST_SECTION_SOURCES = Object.freeze({
  sat: SAT_SECTION_SOURCE,
  psat: SAT_SECTION_SOURCE,
  act: String.raw`[Ee]nglish|[Mm]ath(?:ematics)?|[Rr]eading|[Ss]cience|[Ww]riting|영어|수학|읽기|과학|쓰기`,
  toefl: LANGUAGE_SECTION_SOURCE,
  ielts: LANGUAGE_SECTION_SOURCE,
  duolingo: String.raw`[Ll]iteracy|[Cc]omprehension|[Cc]onversation|[Pp]roduction`,
});
const GPA_LABEL_SOURCE = String.raw`(?<![A-Za-z])(?:GPA|grade point average)(?![A-Za-z])|평점`;
const SCORE_VALUE_SOURCE = String.raw`\d{1,2},\d{3}|\d{1,4}(?:\.\d)?`;
const GPA_VALUE_SOURCE = String.raw`\d\.\d{1,2}`;
// Words that may sit between "your" and the label ("your best SAT", "your
// October ACT", "your unweighted GPA") without making it a target.
const EN_ADJ = "(?:current|latest|most recent|recent|new|best|highest|top|first|second|third|last|previous|earlier|official|reported|recorded|unweighted|weighted|cumulative|overall|total|composite|strong|solid|impressive|excellent|great|good|high|superscored|single-sitting|January|February|March|April|May|June|July|August|September|October|November|December|spring|summer|fall|autumn|winter)";
const EN_FILLER = String.raw`(?:\s+(?:total|composite|superscore|super-score|score|scores|result|results|so far|on file|of record))*`;
const EN_LINK = String.raw`\s*(?:\(|:|=|—|–)?\s*(?:(?:of|is|was|at|sits at|stands at|came in at|comes in at)\s+)?(?:an?\s+)?`;
const EN_PRE_LABEL = String.raw`(?:(?:superscored|composite|total|unweighted|weighted|cumulative|official|single-sitting)\s+)?`;
const KO_LINK = String.raw`\s*(?:시험\s*)?(?:점수|성적|총점)?\s*(?:은|는|이|가|:)?\s*`;
// After a value: a range, a plus, a percentage, an ordinal, a difference
// ("your GPA is 0.1 below", "your ACT is 2 short of"), a count of something
// else ("in 2 months", "3 sittings"), or a Korean band ("1500점대", "1500점
// 이상") means it is not a score the student holds.
const VALUE_TAIL_BLOCK_RE = /^(?:[\d+%]|\.\d|,\d|\s*[–\-~～/]\s*\d|\s+to\s+\d|-point|\s*(?:points?|percent|percentile|th|st|nd|rd|scale)\b|\s+(?:below|above|higher|lower|short|more|less|under|over|behind|ahead|away|off)\b|\s*점?\s*(?:대|이상|이하|미만|초과|정도|만점|차이|높|낮)|\s*(?:months?|weeks?|days?|years?|hours?|times?|credits?|semesters?|attempts?|sittings?|tries)\b)/i;
// After a label that follows its value ("your 2 SAT sittings").
const COUNTED_AFTER_LABEL_RE = /^\s*(?:sittings?|attempts?|tries|tests?|dates?|prep|tutor(?:ing)?|class(?:es)?|courses?|practice|sections?|registrations?|requirements?|polic(?:y|ies)|range|band|average|median|cutoff)\b/i;

function bindingPatterns(label, section, value) {
  const s = section ? String.raw`(?:\s+(?<s>${section}))?` : "";
  const s0 = section ? String.raw`(?:(?<s0>${section})\s+)?` : "";
  const ks = section ? String.raw`(?:(?<s>${section})\s*)?` : "";
  return [
    // "your SAT of 1450", "your SAT Math score of 800", "your GPA is 3.82"
    ["possessive", new RegExp(String.raw`(?<![A-Za-z])[Yy]our\s+(?:${EN_ADJ}\s+){0,3}${s0}(?:${label})${s}${EN_FILLER}${EN_LINK}(?<v>${value})`, "gd")],
    // "your 1450 SAT", "your 3.82 unweighted GPA", "your 1450 on the SAT"
    ["numberFirst", new RegExp(String.raw`(?<![A-Za-z])[Yy]our\s+(?:${EN_ADJ}\s+){0,3}(?<v>${value})\s+(?:(?:on|in)\s+(?:the\s+)?)?${EN_PRE_LABEL}(?:${label})${s}`, "gd")],
    // "you scored 1500 on the SAT", "you have a 3.9 GPA"
    ["scored", new RegExp(String.raw`(?<![A-Za-z])[Yy]ou(?:['’]ve|\s+have|\s+had)?\s+(?:already\s+|just\s+|recently\s+|also\s+)?(?:scored|got|gotten|earned|received|posted|achieved|have|has|had|hold|carry|maintain(?:ed)?)\s+(?:an?\s+)?(?<v>${value})\s+(?:(?:on|in)\s+(?:the\s+|your\s+)?)?${EN_PRE_LABEL}(?:${label})${s}`, "gd")],
    // "…, you're in range with a 3.9 GPA" / "with an ACT of 33" — only in a
    // clause whose subject is "you".
    ["withA", new RegExp(String.raw`(?<![A-Za-z])(?:with|having|holding|carrying)\s+an?\s+(?:${EN_ADJ}\s+){0,2}(?<v>${value})\s+${EN_PRE_LABEL}(?:${label})${s}`, "gd")],
    ["withOf", new RegExp(String.raw`(?<![A-Za-z])(?:with|having|holding|carrying)\s+an?\s+(?:${EN_ADJ}\s+){0,2}(?:${label})${s}(?:\s+score)?\s+of\s+(?<v>${value})`, "gd")],
    // "학생의 SAT 점수 1500점은", "당신의 SAT 1500점", "학생의 GPA 3.95는"
    ["koMarked", new RegExp(String.raw`(?<![가-힣])(?:학생|당신|본인|귀하|너|네)(?:님)?\s*(?:의|은|는|이|가|께서)?\s*(?:현재\s*|최근\s*|최고\s*)?(?:${label})\s*${ks}${KO_LINK}(?<v>${value})`, "gd")],
    // "…A를 받았고 SAT 1500점이라…": the label beside the value, in a clause
    // that has already named the student or said what they received.
    ["koBare", new RegExp(String.raw`(?:${label})\s*${ks}${KO_LINK}(?<v>${value})`, "gd")],
  ];
}

function rangeOf(defs) {
  const list = (Array.isArray(defs) ? defs : [defs]).filter(Boolean);
  if (!list.length) return null;
  return {
    min: Math.min(...list.map((d) => d.min)),
    max: Math.max(...list.map((d) => d.max)),
    step: Math.min(...list.map((d) => d.step || 1)),
  };
}

function inRange(value, range) {
  if (!range || !Number.isFinite(value) || value < range.min || value > range.max) return false;
  return Math.abs(value / range.step - Math.round(value / range.step)) < 1e-6;
}

const TEST_SPECS = Object.freeze(Object.fromEntries(Object.keys(TEST_LABEL_SOURCES).map((key) => {
  const catalog = TEST_CATALOG[key];
  const section = TEST_SECTION_SOURCES[key] || null;
  return [key, {
    key,
    label: testLabel(key),
    section,
    patterns: bindingPatterns(TEST_LABEL_SOURCES[key], section, SCORE_VALUE_SOURCE),
    totalRange: rangeOf(catalog?.total),
    sectionRange: rangeOf(catalog?.sections),
  }];
})));
const GPA_PATTERNS = bindingPatterns(GPA_LABEL_SOURCE, null, GPA_VALUE_SOURCE);

// Every value the text ties to the student under one label, as
// { value, at, scoped } — `scoped` when a section word rides with it.
function boundValueMentions(text, patterns, { section = null } = {}) {
  const found = new Map();
  const sectionAfter = section ? new RegExp(String.raw`^\s*(?:on|in|for)\s+(?:the\s+)?(?:${section})\b`) : null;
  for (const [form, re] of patterns) {
    for (const m of text.matchAll(re)) {
      const raw = m.groups?.v;
      const span = m.indices?.groups?.v;
      if (raw == null || !span) continue;
      const [vStart, vEnd] = span;
      if (found.has(vStart)) continue;
      if (VALUE_TAIL_BLOCK_RE.test(text.slice(vEnd, vEnd + 20))) continue;
      const end = m.index + m[0].length;
      if ((form === "numberFirst" || form === "scored" || form === "withA") && COUNTED_AFTER_LABEL_RE.test(text.slice(end, end + 24))) continue;
      const clause = clauseAround(text, m.index, end);
      if (form === "withA" || form === "withOf") {
        if (!SECOND_PERSON_SUBJECT_RE.test(clause.lead)) continue;
      }
      if (form === "koMarked") {
        // "합격한 학생의 SAT" is an admitted student's score, not this one's.
        if (/[가-힣]+(?:한|된|는|던|인)\s*$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      }
      if (form === "koBare") {
        if (!HANGUL_RE.test(clause.whole)) continue;
        if (!KO_STUDENT_RE.test(clause.lead) && !KO_RECEIVED_RE.test(clause.lead)) continue;
        // A word right before the label that is not a connective ("스탠퍼드
        // SAT", "스탠퍼드의 SAT") names whose score it is.
        const word = (text.slice(Math.max(0, m.index - 16), m.index).match(/([가-힣A-Za-z0-9]+)\s*$/) || [])[1];
        if (word && !/(?:고|며|서|는데|지만|하고|이고)$/.test(word) && !KO_STUDENT_RE.test(word)) continue;
      }
      if (!attributed(text, m.index, end, true)) continue;
      const value = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(value)) continue;
      const scoped = Boolean(m.groups.s || m.groups.s0) || Boolean(sectionAfter && sectionAfter.test(text.slice(vEnd, vEnd + 40)));
      found.set(vStart, { value, raw, at: vStart, scoped });
    }
  }
  return [...found.values()].sort((a, b) => a.at - b.at);
}

// Every recorded sitting of a test: all totals and section scores are true,
// and so is the superscore the sittings imply (the best of each section).
function testRecord(tests, key) {
  const entries = tests.filter((t) => testKey(t?.test) === key);
  const totals = [...new Set(entries.map((e) => finiteNumber(e?.totalScore)).filter((v) => v != null))];
  const sectionValues = [...new Set(entries.flatMap((e) => sectionEntries(e).map((s) => s.value)))];
  let superscore = null;
  const spec = TEST_CATALOG[key];
  if (spec?.derive && entries.length > 1) {
    const best = {};
    let complete = true;
    for (const def of spec.sections.filter((s) => s.composite !== false)) {
      const values = entries.map((e) => finiteNumber(e?.sections?.[def.key])).filter((v) => v != null);
      if (!values.length) { complete = false; break; }
      best[def.key] = Math.max(...values);
    }
    if (complete) superscore = deriveTotal(key, best);
  }
  return { entries, totals, sectionValues, superscore };
}

function describeTestRecord(record, label, scoped) {
  const { entries } = record;
  const dated = entries.length > 1;
  if (scoped) {
    const withSections = entries.filter((e) => sectionEntries(e).length);
    if (withSections.length) {
      const items = withSections.map((e) => ({ value: formatSections(e), ...(withSections.length > 1 && e.date ? { date: e.date } : {}) }));
      const recorded = { items, join: "semicolon" };
      return { state: "recorded", actual: formatRecordedItems(recorded, "en-US"), recorded };
    }
    if (record.totals.length) {
      const recorded = { items: record.totals.map((v) => ({ value: String(v) })) };
      return { state: "total_only", actual: `total ${formatRecordedItems(recorded, "en-US")}, no section scores recorded`, recorded };
    }
    return { state: "none", actual: `no ${label} score recorded` };
  }
  const withTotals = entries.filter((e) => finiteNumber(e?.totalScore) != null);
  if (!withTotals.length) return { state: "none", actual: `no ${label} score recorded` };
  const items = withTotals.map((e) => ({ value: String(finiteNumber(e.totalScore)), ...(dated && e.date ? { date: e.date } : {}) }));
  const recorded = { items, ...(record.superscore != null && !record.totals.includes(record.superscore) ? { superscore: record.superscore } : {}) };
  return { state: "recorded", actual: formatRecordedItems(recorded, "en-US"), recorded };
}

function gpaMatchesStated(stated, actual) {
  if (actual == null || !Number.isFinite(Number(actual))) return false;
  const decimals = (String(stated).split(".")[1] || "").length;
  const factor = 10 ** decimals;
  return Math.round(Number(actual) * factor) / factor === Number(stated);
}

// "your class rank in the top 5%", "you are ranked in the top 1% of your
// class" — a standing claimed for the student.
const RANK_BINDINGS = [
  /\b[Yy]our\s+(?:class\s+)?(?:rank|ranking|standing)\s+(?:is\s+|of\s+|in\s+|at\s+|puts\s+you\s+in\s+|places\s+you\s+in\s+)?(?:the\s+)?top\s+(\d{1,2}(?:\.\d)?)\s*%/g,
  /\b[Yy]ou(?:['’]re|\s+are)?\s+(?:currently\s+|now\s+)?(?:ranked|rank)\s+(?:in\s+)?(?:the\s+)?top\s+(\d{1,2}(?:\.\d)?)\s*%/g,
  /\b[Yy]ou(?:['’]re|\s+are)\s+(?:in\s+)?(?:the\s+)?top\s+(\d{1,2}(?:\.\d)?)\s*%\s+of\s+your\s+(?:class|grade)/g,
];

// ─── Grade level ──────────────────────────────────────────────────────
// "Since you're a junior", "as an 11th grader, you…", "학생은 11학년이므로":
// the grade the reply puts the student in. Precision-first like the rest:
// only a statement about the student now ("you're a junior", never "the
// grades you earned as a junior" or "juniors usually"), with the level word
// ending the phrase so "you're a junior varsity captain" and "a senior
// editor" are not grades, and the usual hedges ("if you're a junior").
const LEVEL_WORDS = { freshman: 9, sophomore: 10, junior: 11, senior: 12, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
const LEVEL_SOURCE = String.raw`(?:freshman|sophomore|junior|senior|(?:9|10|11|12)th[\s-]grader|(?:ninth|tenth|eleventh|twelfth)[\s-]grader)`;
const LEVEL_END = String.raw`(?=\s*(?:[,.;:!?)]|$)|\s+(?:in\s+high\s+school|this\s+(?:year|fall|spring|semester)|now|right\s+now|and|so|who|with|applying|taking|planning|looking|heading|preparing)\b)`;
const GRADE_LEVEL_BINDINGS = [
  new RegExp(String.raw`\b[Yy]ou(?:['’]re|\s+are)\s+(?:(?:currently|now|still|already|only|just|officially)\s+)?an?\s+(${LEVEL_SOURCE})${LEVEL_END}`, "g"),
  new RegExp(String.raw`\b[Yy]ou(?:['’]re|\s+are)\s+(?:(?:currently|now|still|already|only|just)\s+)?in\s+(?:the\s+|your\s+)?((?:9|10|11|12)th|ninth|tenth|eleventh|twelfth|freshman|sophomore|junior|senior)\s+(?:grade|year)\b`, "g"),
  new RegExp(String.raw`(?<=^|[.!?]\s+|\n\s*)[Aa]s\s+an?\s+(${LEVEL_SOURCE})\s*,\s+you\b`, "g"),
  /(?<![가-힣])(?:학생|당신|본인|귀하)(?:님)?(?:은|는|이|가|께서)?\s*(?:현재\s*|지금\s*)?(9|10|11|12)\s*학년(?=\s*(?:이|인|입니다|이에요|이므로|이니|이라서|이기))/g,
  /(?<!\d)(9|10|11|12)\s*학년\s*(?:학생\s*)?(?:으로서|으로써)/g,
];

function statedGradeLevel(word) {
  const w = String(word || "").toLowerCase();
  const n = w.match(/^(9|10|11|12)/);
  if (n) return Number(n[1]);
  return LEVEL_WORDS[w.split(/[\s-]/)[0]] ?? null;
}

// ─── AP exam scores ───────────────────────────────────────────────────
const AP_SCORE_BEFORE_RE = /(?<pre>(?:^|[\s(,;:—–-])(?:scored?|score of|got|gotten|earned|received|with|an?|your)\s+)(?<score>[1-5])\s+(?:on|in|for)\s+(?:(?:the|your)\s+)?(?:AP\s+)?(?:exam\s+(?:in|for)\s+)?$/i;
const AP_POSSESSED_BEFORE_RE = /(?:\b[Yy]our\s+|\b[Yy]ou(?:['’]ve|\s+have|\s+had|\s+already|\s+also)?\s+(?:scored|got|gotten|earned|received|made|pulled|have|had)\s+(?:an?\s+)?)$/;
const AP_SCORE_AFTER_RE = /^\s*(?:exam\s*)?(?:\(|:|—|–|-)?\s*(?:score\s*(?:of|:)?\s*)?([1-5])(?![\d.%]|\s*(?:credits?|semesters?|units?|hours?|years?|courses?|classes|weeks?|months?))/;
// Korean: "AP Statistics 시험에서 5점을 받은", "AP Statistics 5점".
const KO_AP_AFTER_RE = /^\s*(?=[가-힣])(?:시험\s*)?(?:(?:에서|의|은|는|이|가)\s*)?(?:(?:시험\s*)?(?:점수|성적)\s*(?:는|은|가|이|:)?\s*)?(?:받은\s*)?([1-5])\s*점(?!\s*(?:이상|이하|미만|대|만점|정도))/;
// A practice test, a unit or a mock exam is not the AP score.
const AP_NOT_EXAM_AFTER_RE = /^\s+(?:practice|mock|unit|FRQ|MCQ|quiz|progress check|diagnostic)\b/i;

// Every score the text states for one exam, under the given names, as
// { score, possessed }. `possessed` marks a score the phrase ties to the
// student ("you scored a 5 on", "your 5 on", "AP Statistics (4)", "…5점을
// 받은 것").
function apScoreMentions(text, aliases, { caseSensitive = false } = {}) {
  const found = [];
  if (!aliases.length) return found;
  const re = aliasRegExp(aliases, caseSensitive ? "g" : "gi");
  for (const match of text.matchAll(re)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(Math.max(0, start - 60), start);
    const after = text.slice(end, end + 40);
    if (AP_NOT_EXAM_AFTER_RE.test(after) || AP_NOT_EXAM_AFTER_RE.test(after.replace(/^\s*exam\b/i, ""))) continue;
    const b = before.match(AP_SCORE_BEFORE_RE);
    if (b) {
      const at = start - before.length + b.index + b.groups.pre.length;
      const possessed = AP_POSSESSED_BEFORE_RE.test(text.slice(Math.max(0, at - 40), at));
      if (attributed(text, at, end, possessed)) found.push({ score: Number(b.groups.score), possessed });
      continue;
    }
    const a = after.match(AP_SCORE_AFTER_RE);
    // A bare "(3)" right after an exam name is a score; "AP Physics 1"-style
    // digits are part of the alias and never reach this window.
    if (a && /(?:score|exam|\(|:)/.test(after.slice(0, a[0].length))) {
      const possessed = /^\s*(?:exam\s*)?[(:]/.test(after) || /\b[Yy]our\s+$/.test(text.slice(Math.max(0, start - 12), start));
      if (attributed(text, start, end + a[0].length, possessed)) found.push({ score: Number(a[1]), possessed });
      continue;
    }
    const k = after.match(KO_AP_AFTER_RE);
    if (k) {
      const rest = after.slice(k[0].length);
      const { lead } = clauseAround(text, start, end);
      const possessed = KO_STUDENT_RE.test(lead) || /받은\s*[1-5]\s*점$/.test(k[0]) || /^\s*(?:을|를)?\s*(?:받았|받으셨|받은\s*것|받으신\s*것)/.test(rest);
      if (attributed(text, start, end + k[0].length, possessed)) found.push({ score: Number(k[1]), possessed });
    }
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

  const courses = (Array.isArray(profile.courses) ? profile.courses : []).filter((c) => c && courseAliases(c).length);
  const groups = new Map();
  for (const course of courses) {
    const key = courseGroupKey(course);
    const group = groups.get(key) || { display: courseDisplayName(course), level: courseLevel(course), aliases: new Set(), courses: [] };
    for (const alias of courseAliases(course)) group.aliases.add(alias);
    group.courses.push(course);
    groups.set(key, group);
  }
  for (const mention of courseMentions(text, [...groups.values()])) {
    const stated = gradeAtSpan(text, mention.start, mention.end);
    if (!stated) continue;
    const held = mention.groups.flatMap((g) => g.courses);
    if (held.some((c) => isLetterGrade(c.grade) && normalizeGrade(c.grade) === stated)) continue;
    const described = recordedCourseGrades(held);
    add({ kind: "course_grade", item: mention.groups[0].display, stated, ...described });
  }

  // A grade attributed to a course the record doesn't have at all ("your A
  // in AP Chemistry" when no such course was entered). Only AP/IB/Honors-
  // prefixed names are checked — those are unambiguous course references.
  const known = courses.flatMap((c) => courseAliases(c).map((alias) => alias.toLowerCase()));
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
    add({ kind: "course_not_on_record", item: course, stated, actual: "no such course on the student's record", state: "not_on_record" });
  };
  // "…your A in AP Chemistry and…" — the grade precedes the course.
  // Lead words may open a sentence ("Your A in …"); the grade letter itself
  // stays upper-case only, so an article "a" is never read as a grade.
  const beforeRe = /\b([Aa]n?|[Yy]our|[Tt]he|[Hh]is|[Hh]er|[Tt]heir)\s+([ABCDF][+\-−–]?)\s+(?:in|for|on)\s+(AP|IB|Honors)\s+(?=[A-Z0-9])/g;
  let bm;
  while ((bm = beforeRe.exec(text))) {
    const { phrase, end } = readCoursePhrase(text, bm.index + bm[0].length);
    if (!phrase || !attributed(text, bm.index, end, /^[Yy]our$/.test(bm[1]))) continue;
    flagInvented(`${bm[3]} ${phrase}`, normalizeGrade(bm[2]));
  }
  // "AP Biology (A-)" — the grade follows the course in parentheses;
  // "AP Biology에서 A를 받았" — the Korean form.
  const levelRe = /\b(AP|IB|Honors)\s+(?=[A-Z0-9])/g;
  let lm;
  while ((lm = levelRe.exec(text))) {
    const { phrase, end } = readCoursePhrase(text, lm.index + lm[0].length);
    if (!phrase) continue;
    const window = text.slice(end, end + 40);
    const paren = window.match(/^\s*\(\s*(?:grade\s*(?:of|:)?\s*)?([ABCDF][+\-−–]?)\s*\)/);
    if (paren && attributed(text, lm.index, end + paren[0].length, true)) flagInvented(`${lm[1]} ${phrase}`, normalizeGrade(paren[1]));
    const ko = paren ? null : window.match(KO_GRADE_AFTER_RE);
    if (ko && attributed(text, lm.index, end + ko[0].length, false)) flagInvented(`${lm[1]} ${phrase}`, normalizeGrade(ko[1]));
  }

  const gpaUnweighted = finiteNumber(profile.gpaUnweighted ?? profile.gpa?.unweighted);
  const gpaWeighted = finiteNumber(profile.gpaWeighted ?? profile.gpa?.weighted);
  const gpas = boundValueMentions(text, GPA_PATTERNS).filter((m) => m.value > 0 && m.value <= 5);
  if (gpas.length) {
    const items = [
      gpaUnweighted != null ? { value: String(gpaUnweighted), scale: "unweighted" } : null,
      gpaWeighted != null ? { value: String(gpaWeighted), scale: "weighted" } : null,
    ].filter(Boolean);
    const recorded = items.length ? { items, join: "slash" } : null;
    const pending = !recorded && String(profile.gpaStatus || "") === "pending";
    const described = recorded
      ? { state: "recorded", actual: formatRecordedItems(recorded, "en-US"), recorded }
      : pending ? { state: "pending", actual: "no GPA yet (the student has none yet)" } : { state: "none", actual: "no GPA recorded" };
    for (const mention of gpas) {
      if (gpaMatchesStated(mention.raw, gpaUnweighted) || gpaMatchesStated(mention.raw, gpaWeighted)) continue;
      add({ kind: "gpa", item: "GPA", stated: mention.raw, ...described });
    }
  }

  // Every recorded sitting is a true score: a retaker's newer 1450 used to
  // be "corrected" to the first sitting's 1390, and the retry told the
  // model to downgrade the student's best score.
  const tests = Array.isArray(profile.testScores) ? profile.testScores.filter((t) => t && typeof t === "object") : [];
  for (const spec of Object.values(TEST_SPECS)) {
    const mentions = boundValueMentions(text, spec.patterns, { section: spec.section });
    if (!mentions.length) continue;
    const record = testRecord(tests, spec.key);
    for (const mention of mentions) {
      const stated = mention.value;
      // A section score the reply states ("your SAT Math 780") is checked
      // against the recorded sections, not the total; before sections
      // existed a correct section figure was flagged as a wrong total.
      if (mention.scoped && spec.sectionRange) {
        if (!inRange(stated, spec.sectionRange)) continue;
        if (record.sectionValues.includes(stated) || record.totals.includes(stated)) continue;
        add({ kind: spec.key, item: `${spec.label} section`, test: spec.label, scoped: true, stated: String(stated), ...describeTestRecord(record, spec.label, true) });
        continue;
      }
      if (!inRange(stated, spec.totalRange)) continue;
      if (record.totals.includes(stated) || record.superscore === stated) continue;
      add({ kind: spec.key, item: spec.label, test: spec.label, stated: String(stated), ...describeTestRecord(record, spec.label, false) });
    }
  }

  // Class rank: "your class rank in the top 5%" claims a standing. A stated
  // share that is no better than the recorded one ("top 10%" for a student
  // recorded at top 4%) is still true, so only a claim of better standing,
  // or any figure when none is recorded, is a contradiction.
  const rankRecorded = normalizeClassRank(profile.classRank);
  for (const re of RANK_BINDINGS) {
    for (const m of text.matchAll(re)) {
      if (!attributed(text, m.index, m.index + m[0].length, true)) continue;
      const stated = Number(m[1]);
      if (rankRecorded?.topPercent != null && stated >= rankRecorded.topPercent) continue;
      add({
        kind: "class_rank",
        item: "Class rank",
        stated: `top ${stated}%`,
        actual: rankRecorded ? formatClassRank(rankRecorded) : "no class rank recorded",
        state: rankRecorded ? "recorded" : "none",
        ...(rankRecorded ? { rank: rankRecorded } : {}),
      });
    }
  }

  // The grade level against the one the server computed from the student's
  // class. With none recorded there is nothing to contradict.
  const gradeLevel = GRADE_LEVEL_NAMES[Number(profile.gradeLevel)] ? Number(profile.gradeLevel) : null;
  if (gradeLevel != null) {
    for (const re of GRADE_LEVEL_BINDINGS) {
      for (const m of text.matchAll(re)) {
        const stated = statedGradeLevel(m[1]);
        if (stated == null || stated === gradeLevel) continue;
        if (!attributed(text, m.index, m.index + m[0].length, true)) continue;
        add({
          kind: "grade_level",
          item: "Grade level",
          stated: gradeLevelLabel(stated),
          actual: gradeLevelLabel(gradeLevel),
          state: "recorded",
          statedGrade: stated,
          recordedGrade: gradeLevel,
        });
      }
    }
  }

  // One check per exam, under every name the AP catalog knows for it
  // ("APUSH", "AP Calc BC", the College Board's full name). An exam taken
  // twice has two true scores: a 4 stated for a Calculus AB recorded as 3
  // in 2025 and 4 in 2026 used to be a contradiction against the 3, and
  // the retry "corrected" a right answer.
  const apByExam = new Map();
  for (const exam of (Array.isArray(profile.apScores) ? profile.apScores : [])) {
    const name = apExamName(exam);
    if (name.length < 3) continue;
    const id = apExamKey(name) || name.replace(/^AP\s+/i, "").toLowerCase();
    const entry = apByExam.get(id) || { label: apExamKey(name) || name.replace(/^AP\s+/i, ""), aliases: new Set(), scores: [] };
    for (const alias of apExamAliases(name)) entry.aliases.add(alias);
    const score = finiteNumber(exam?.score);
    if (score != null && !entry.scores.includes(score)) entry.scores.push(score);
    apByExam.set(id, entry);
  }
  for (const entry of apByExam.values()) {
    const aliases = [...entry.aliases].sort((a, b) => b.length - a.length);
    const scores = [...entry.scores].sort((a, b) => b - a);
    for (const { score: stated } of apScoreMentions(text, aliases)) {
      if (scores.includes(stated)) continue;
      const actual = !scores.length ? "no score recorded" : scores.length === 1 ? String(scores[0]) : `${scores.join(" and ")} (the exam was taken ${scores.length} times)`;
      const recorded = scores.length ? { items: scores.map((s) => ({ value: String(s) })), ...(scores.length > 1 ? { times: scores.length } : {}) } : null;
      add({ kind: "ap_score", item: `AP ${entry.label} exam`, exam: entry.label, stated: String(stated), actual, state: scores.length ? "recorded" : "none", ...(recorded ? { recorded } : {}) });
    }
  }

  // A score for an exam the record has no score for at all: the natural
  // invention is a 5 on an AP course still in progress. Only a phrase that
  // says the student scored it counts ("you got a 5 on AP Calculus BC",
  // "your 5 on the AP Biology exam"), never advice or a credit policy ("a 5
  // on AP Calculus BC would earn credit"), and only under names that can
  // only mean the AP exam.
  const recordedNames = new Set([...apByExam.values()].flatMap((e) => [...e.aliases].map((a) => a.toLowerCase())));
  for (const exam of AP_EXAMS) {
    if (apByExam.has(exam.name)) continue;
    const aliases = apExamOnlyAliases(exam.name).filter((a) => !recordedNames.has(a.toLowerCase())).sort((a, b) => b.length - a.length);
    const claimed = apScoreMentions(text, aliases, { caseSensitive: true }).filter((m) => m.possessed);
    if (!claimed.length) continue;
    const course = courses.find((c) => apExamKey(courseDisplayName(c)) === exam.name && courseLevel(c) === "ap");
    const inProgress = Boolean(course && isInProgress(course.grade));
    for (const { score } of claimed) {
      add({
        kind: "ap_not_on_record",
        item: `AP ${exam.name} exam`,
        exam: exam.name,
        stated: String(score),
        actual: inProgress ? "course in progress; no exam score yet" : "no score recorded for this exam",
        state: inProgress ? "in_progress" : "none",
      });
    }
  }

  return { contradictions: contradictions.slice(0, 8) };
}

// ─── Correction text ──────────────────────────────────────────────────
// The retry message to the model is always English; the footnote the
// student reads follows the locale (shared/i18n.js "fidelity.*"). Each
// contradiction carries its state ("letter", "in_progress", "none", …) and
// the recorded values as parts, so the sentence says what is on the record
// in words: "no grade is recorded", "recorded P (pass/fail)". It used to
// paste the internal `actual` string after "recorded", which read "Health:
// recorded no grade recorded" and called a recorded P or 95 no grade.

function isKoreanLocale(locale) {
  return String(locale || "").toLowerCase().startsWith("ko");
}

function formatRecordedItem(item, locale) {
  let base = item.state === "in_progress"
    ? t("fidelity.note.in_progress", locale)
    : item.state === "none" ? t("fidelity.note.no_grade", locale) : String(item.value ?? "");
  if (item.scale) base = t(`fidelity.note.${item.scale}`, locale, { value: base });
  if (item.passFail) base = `${base} (${t("fidelity.note.pass_fail", locale)})`;
  const notes = [
    item.year ? t(`fidelity.note.${item.year}`, locale) : null,
    item.term ? t(`fidelity.note.${item.term}`, locale) : null,
    item.date || null,
  ].filter(Boolean);
  return notes.length ? `${base} (${notes.join(", ")})` : base;
}

function formatRecordedItems(recorded, locale) {
  const items = Array.isArray(recorded?.items) ? recorded.items : [];
  const joiner = recorded.join === "slash" ? " / " : recorded.join === "semicolon" ? "; " : t("fidelity.join", locale);
  let out = items.map((item) => formatRecordedItem(item, locale)).join(joiner);
  if (recorded.times) out += ` ${t("fidelity.note.times", locale, { count: recorded.times })}`;
  if (recorded.superscore != null) out += ` (${t("fidelity.note.superscore", locale, { value: recorded.superscore })})`;
  return out;
}

function formatRankForLocale(rank, locale) {
  const parts = [];
  if (rank.topPercent != null) parts.push(t("fidelity.rank.top", locale, { percent: rank.topPercent }));
  if (rank.rank != null) parts.push(rank.size != null ? t("fidelity.rank.of", locale, { rank: rank.rank, size: rank.size }) : t("fidelity.rank.rank", locale, { rank: rank.rank }));
  return parts.join(" (") + (parts.length > 1 ? ")" : "");
}

const TEST_KINDS = new Set(Object.keys(TEST_LABEL_SOURCES));

function contradictionTemplate(entry) {
  switch (entry.kind) {
    case "course_grade":
      return { letter: "fidelity.grade", multiple: "fidelity.grades", pass_fail: "fidelity.grade_other", other: "fidelity.grade_other", in_progress: "fidelity.grade_in_progress", none: "fidelity.grade_none" }[entry.state] || null;
    case "course_not_on_record": return "fidelity.course_not_on_record";
    case "gpa": return { recorded: "fidelity.gpa", none: "fidelity.gpa_none", pending: "fidelity.gpa_pending" }[entry.state] || null;
    case "ap_score": return entry.state === "none" ? "fidelity.ap_none" : entry.state === "recorded" ? "fidelity.ap_score" : null;
    case "ap_not_on_record": return entry.state === "in_progress" ? "fidelity.ap_in_progress" : "fidelity.ap_none";
    case "class_rank": return entry.state === "none" ? "fidelity.class_rank_none" : entry.state === "recorded" ? "fidelity.class_rank" : null;
    default:
      if (!TEST_KINDS.has(entry.kind)) return null;
      return { recorded: "fidelity.score", none: "fidelity.score_none", total_only: "fidelity.score_total_only" }[entry.state] || null;
  }
}

function contradictionItem(entry, locale) {
  if ((entry.kind === "ap_score" || entry.kind === "ap_not_on_record") && entry.exam) return t("fidelity.item.ap_exam", locale, { exam: entry.exam });
  if (TEST_KINDS.has(entry.kind) && entry.scoped && entry.test) return t("fidelity.item.section", locale, { test: entry.test });
  return entry.item;
}

export function describeContradiction(entry, locale = "en-US") {
  // The grade level carries its own two sentences; the shared fidelity
  // strings have no grade-level key.
  if (entry.kind === "grade_level" && entry.recordedGrade && entry.statedGrade) {
    return isKoreanLocale(locale)
      ? `학년: 기록상 ${gradeLevelLabel(entry.recordedGrade, "ko")} (답변에서는 ${gradeLevelLabel(entry.statedGrade, "ko")})`
      : `Grade level: the student is in ${gradeLevelLabel(entry.recordedGrade)} (the reply said ${gradeLevelLabel(entry.statedGrade)})`;
  }
  const key = contradictionTemplate(entry);
  if (!key) {
    // An entry built elsewhere (or before states existed) keeps the old
    // sentence.
    const recorded = entry.kind === "course_grade" && /^[ABCDF]/.test(String(entry.actual)) ? `grade ${entry.actual}` : entry.actual;
    return `${entry.item}: recorded ${recorded} (the reply said ${entry.stated})`;
  }
  const recorded = entry.kind === "class_rank" && entry.rank
    ? formatRankForLocale(entry.rank, locale)
    : entry.recorded ? formatRecordedItems(entry.recorded, locale) : entry.actual;
  return t(key, locale, { item: contradictionItem(entry, locale), recorded, stated: entry.stated });
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
  const loc = isKoreanLocale(locale) ? "ko" : "en-US";
  return `\n\n${t("fidelity.heading", loc)}\n${contradictions.map((c) => `- ${describeContradiction(c, loc)}`).join("\n")}`;
}

// ─── School mentions ──────────────────────────────────────────────────
// Common abbreviations → the institution's IPEDS-style name. Multi-word
// official names are matched from the baseline table by the caller-supplied
// `knownNames`. Students type the way students type, and until 2026-11-03
// every short code matched only in capitals, so "what's ucla's acceptance
// rate" or "is nyu a fit" reached the model with no VERIFIED DATA block, no
// College Fit read and no on-demand official read. Only the codes that are
// also ordinary words or chat shorthand ("bc" for because, "bu", "uf", "uw")
// stay capitals-only.
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

// Codes that are also ordinary words or shorthand, matched in capitals only.
const CASE_SENSITIVE_SCHOOL_ALIASES = new Set(["BC", "BU", "UF", "UW"]);

// US schools by the names Korean students and the model write in Hangul.
// Names that are also ordinary words or other places need their 대(학교)
// suffix ("브라운대", not the color 브라운; "시카고대", not the city), and a
// state flagship is kept apart from the state university ("미시간대" is
// Michigan, "미시간 주립대" Michigan State). "워싱턴대" alone is left out:
// Korean writers use it for both the University of Washington and WashU.
const KOREAN_SCHOOL_ALIASES = Object.freeze([
  ["하버드", "Harvard University"],
  ["스탠퍼드|스탠포드", "Stanford University"],
  ["예일", "Yale University"],
  ["프린스턴", "Princeton University"],
  [String.raw`(?<!브리티시\s?)컬럼비아(?!\s?칼리지)`, "Columbia University in the City of New York"],
  ["코넬", "Cornell University"],
  ["다트머스|다트마우스", "Dartmouth College"],
  [String.raw`브라운\s?대`, "Brown University"],
  [String.raw`유펜|펜실베이니아\s?대`, "University of Pennsylvania"],
  [String.raw`펜실베이니아\s?주립\s?대|펜\s?스테이트`, "Pennsylvania State University-Main Campus"],
  ["듀크", "Duke University"],
  ["노스웨스턴", "Northwestern University"],
  [String.raw`시카고\s?대`, "University of Chicago"],
  [String.raw`존스\s?홉킨스`, "Johns Hopkins University"],
  [String.raw`카네기\s?멜[런론]`, "Carnegie Mellon University"],
  [String.raw`매사추세츠\s?공(?:과\s?)?대|엠아이티`, "Massachusetts Institute of Technology"],
  [String.raw`칼텍|캘텍|캘리포니아\s?공(?:과\s?)?대`, "California Institute of Technology"],
  [String.raw`(?:UC\s?)?버클리(?!\s?음)`, "University of California-Berkeley"],
  [String.raw`UC\s?샌디에(?:이)?고`, "University of California-San Diego"],
  [String.raw`UC\s?산타\s?바바라`, "University of California-Santa Barbara"],
  [String.raw`UC\s?어바인`, "University of California-Irvine"],
  [String.raw`UC\s?데이비스`, "University of California-Davis"],
  [String.raw`UC\s?산타\s?크루즈`, "University of California-Santa Cruz"],
  ["유씨엘에이", "University of California-Los Angeles"],
  [String.raw`남가주\s?대|서던\s?캘리포니아\s?대`, "University of Southern California"],
  [String.raw`뉴욕\s?대`, "New York University"],
  [String.raw`보스턴\s?대`, "Boston University"],
  [String.raw`보스턴\s?칼리지`, "Boston College"],
  [String.raw`미시간\s?대`, "University of Michigan-Ann Arbor"],
  [String.raw`미시간\s?주립\s?대`, "Michigan State University"],
  [String.raw`조지아\s?텍|조지아\s?공대`, "Georgia Institute of Technology-Main Campus"],
  [String.raw`일리노이\s?대|일리노이\s?어바나\s?샴페인`, "University of Illinois Urbana-Champaign"],
  [String.raw`(?:UT|텍사스\s?대)\s?오스틴|텍사스\s?오스틴`, "The University of Texas at Austin"],
  [String.raw`텍사스\s?(?:A&M|에이앤엠)`, "Texas A & M University-College Station"],
  [String.raw`버지니아\s?대`, "University of Virginia-Main Campus"],
  [String.raw`버지니아\s?(?:공대|텍)`, "Virginia Tech"],
  [String.raw`노스캐롤라이나\s?대`, "University of North Carolina at Chapel Hill"],
  [String.raw`플로리다\s?대`, "University of Florida"],
  [String.raw`플로리다\s?주립\s?대`, "Florida State University"],
  [String.raw`메릴랜드\s?대`, "University of Maryland-College Park"],
  [String.raw`위스콘신\s?대`, "University of Wisconsin-Madison"],
  [String.raw`워싱턴\s?대(?:학교)?\s?(?:인\s?)?세인트\s?루이스|세인트\s?루이스\s?워싱턴\s?대|워시유`, "Washington University in St Louis"],
  [String.raw`라이스\s?대`, "Rice University"],
  ["밴더빌트", "Vanderbilt University"],
  ["에모리", "Emory University"],
  ["조지타운", "Georgetown University"],
  [String.raw`노트르담\s?대|노터데임`, "University of Notre Dame"],
  ["터프츠", "Tufts University"],
  ["노스이스턴", "Northeastern University"],
  ["퍼듀", "Purdue University-Main Campus"],
  ["럿거스", "Rutgers University-New Brunswick"],
  [String.raw`오하이오\s?주립\s?대`, "Ohio State University-Main Campus"],
  [String.raw`애리조나\s?주립\s?대`, "Arizona State University"],
  ["앰허스트|애머스트", "Amherst College"],
  ["스와스모어|스워스모어", "Swarthmore College"],
  ["포모나", "Pomona College"],
  ["보우도인", "Bowdoin College"],
  ["웰즐리|웰슬리", "Wellesley College"],
  [String.raw`칼턴\s?칼리지`, "Carleton College"],
  ["미들베리", "Middlebury College"],
  [String.raw`하비\s?머드`, "Harvey Mudd College"],
]);

const SCHOOL_ALIAS_PATTERNS = Object.freeze([
  ...Object.entries(SCHOOL_ALIASES).map(([alias, canonical]) => {
    const caseSensitive = CASE_SENSITIVE_SCHOOL_ALIASES.has(alias);
    return { re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(alias)}(?![A-Za-z0-9])`, caseSensitive ? "g" : "gi"), canonical, examCode: caseSensitive };
  }),
  ...KOREAN_SCHOOL_ALIASES.map(([source, canonical]) => ({ re: new RegExp(`(?<![가-힣A-Za-z])(?:${source})`, "g"), canonical, examCode: false })),
]);

const MAX_SCHOOL_MENTIONS = 6;

// Every school a text names, with where: aliases (English and Hangul) and
// official names. A hit inside a longer one is the longer one ("Penn State"
// is not also Penn).
function schoolHits(source, knownNames) {
  const hits = []; // { start, end, name }
  for (const { re, canonical, examCode } of SCHOOL_ALIAS_PATTERNS) {
    for (const m of source.matchAll(re)) {
      // A short code after a course name is an AP exam, not a school: "AP
      // Calculus BC" used to pull Boston College into the VERIFIED DATA
      // block (and "Physics C" is not a school either). Skip that hit and
      // keep looking, so "I took Calc BC; is BC a match?" still finds BC.
      if (examCode && /(?:calculus|physics|calc)\s*$/i.test(source.slice(Math.max(0, m.index - 12), m.index))) continue;
      hits.push({ start: m.index, end: m.index + m[0].length, name: canonical });
    }
  }
  const lower = source.toLowerCase();
  for (const known of knownNames) {
    const name = String(known || "").trim();
    if (name.length < 6 || !/\s/.test(name)) continue; // single-word names are too ambiguous
    if (lower.indexOf(name.toLowerCase()) < 0) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, "i");
    const m = re.exec(source);
    if (m) hits.push({ start: m.index, end: m.index + m[0].length, name });
  }
  return hits.filter((h) => !hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && (o.end - o.start) > (h.end - h.start)));
}

export function detectSchoolMentions(text, { knownNames = [], max = MAX_SCHOOL_MENTIONS } = {}) {
  const source = String(text || "");
  if (!source.trim()) return [];
  const out = [];
  for (const hit of schoolHits(source, knownNames).sort((a, b) => a.start - b.start)) {
    if (!out.some((name) => name.toLowerCase() === hit.name.toLowerCase())) out.push(hit.name);
  }
  return out.slice(0, max);
}

// Proper names of colleges a text names that match nothing the app knows
// ("Elm Valley College", "the University of Nowhere"), so the prompt can
// say no verified data is held for them instead of saying nothing.
const SCHOOL_PHRASE_RE = /(?<![A-Za-z])(?:(?:[A-Z][A-Za-z&'’.-]+\s+){1,4}(?:University|College|Institute of Technology|Institute)|University of(?:\s+[A-Z][A-Za-z&'’.-]+){1,3})(?![A-Za-z])/g;
const GENERIC_SCHOOL_WORDS = new Set(["The", "A", "An", "Which", "What", "Any", "Each", "Every", "My", "Your", "Our", "This", "That", "Some", "Other", "Top", "Best", "Good", "Great", "Liberal", "Arts", "Community", "State", "Public", "Private", "Ivy", "League", "Elite", "Junior", "Technical", "Online", "Local", "Small", "Big", "Large", "Selective", "Catholic", "Christian", "Research", "Early", "Dual", "Enrollment", "Common", "App", "Application", "If", "When", "Is", "Does", "Should", "Can", "How", "Why", "Where", "Do", "And", "Or", "Both", "Most", "Many", "In", "At", "For", "To", "Of"]);

export function unresolvedSchoolNames(text, { knownNames = [], max = 3 } = {}) {
  const source = String(text || "");
  if (!source.trim()) return [];
  const resolved = schoolHits(source, knownNames);
  const out = [];
  for (const m of source.matchAll(SCHOOL_PHRASE_RE)) {
    const words = m[0].split(/\s+/);
    // Drop leading generic words ("Which College", "Top Liberal Arts College").
    while (words.length && GENERIC_SCHOOL_WORDS.has(words[0])) words.shift();
    const phrase = words.join(" ");
    const start = m.index + m[0].length - phrase.length;
    if (!/\s/.test(phrase) || phrase.split(/\s+/).every((w) => GENERIC_SCHOOL_WORDS.has(w) || /^(?:University|College|Institute|of|Technology)$/.test(w))) continue;
    if (resolved.some((h) => h.start < start + phrase.length && h.end > start)) continue;
    if (!out.some((name) => name.toLowerCase() === phrase.toLowerCase())) out.push(phrase);
  }
  return out.slice(0, max);
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

// A value that is already a percentage (a CDS distribution share such as
// 0.3 or 97.3), rounded to one decimal — unlike percent(), which treats
// values at or below 1 as fractions.
function plainPercent(value) {
  return Math.round(Number(value) * 10) / 10;
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

// The wider read of the document (cds-pdf-parser.js extractExtras): SAT
// section bands, submit rates, class rank, application fee, Early Decision
// volume, the closing dates the school reported for its own cycle, the
// average first-year aid package, and the student-to-faculty ratio. Dates
// are month-day as reported and belong to the CDS's own (previous) cycle,
// so the line says so — they orient a student, they are not this year's
// deadline.
const CDS_DATE_LABELS = { regularClosing: "Regular Decision", edClosing: "Early Decision", edIIClosing: "Early Decision II", eaClosing: "Early Action", aidPriority: "aid priority", aidDeadline: "aid filing deadline" };

export function cdsExtrasParts(extras) {
  if (!extras || typeof extras !== "object") return [];
  const parts = [];
  const ebrw = range(extras.satSections?.ebrw?.p25, extras.satSections?.ebrw?.p75);
  const math = range(extras.satSections?.math?.p25, extras.satSections?.math?.p75);
  if (ebrw || math) parts.push(`enrolled SAT sections middle 50%: ${[ebrw ? `Reading & Writing ${ebrw}` : null, math ? `Math ${math}` : null].filter(Boolean).join(", ")}`);
  const actSectionParts = [["english", "English"], ["math", "Math"], ["reading", "Reading"], ["science", "Science"]]
    .map(([key, label]) => { const band = range(extras.actSections?.[key]?.p25, extras.actSections?.[key]?.p75); return band ? `${label} ${band}` : null; })
    .filter(Boolean);
  if (actSectionParts.length) parts.push(`enrolled ACT sections middle 50%: ${actSectionParts.join(", ")}`);
  if (extras.submitting?.satPct != null || extras.submitting?.actPct != null) {
    parts.push(`share of enrolled students who submitted scores: ${[extras.submitting.satPct != null ? `SAT ${extras.submitting.satPct}%` : null, extras.submitting.actPct != null ? `ACT ${extras.submitting.actPct}%` : null].filter(Boolean).join(", ")}`);
  }
  // The score-range tables: how the enrolled class's submitted scores were
  // distributed (top three non-empty bands), so a student sees where a
  // total sits beyond the middle-50% band.
  const distributionLine = (bands, label) => {
    const filled = (Array.isArray(bands) ? bands : []).filter((b) => b && Number(b.pct) > 0).sort((a, b) => Number(b.low) - Number(a.low)).slice(0, 3);
    return filled.length ? `${label}: ${filled.map((b) => `${b.low}–${b.high} ${plainPercent(b.pct)}%`).join(", ")}` : null;
  };
  const satDistribution = distributionLine(extras.scoreDistribution?.satComposite, "share of enrolled SAT submitters by total");
  if (satDistribution) parts.push(satDistribution);
  const actDistribution = distributionLine(extras.scoreDistribution?.actComposite, "share of enrolled ACT submitters by composite");
  if (actDistribution) parts.push(actDistribution);
  if (extras.classRank?.topTenthPct != null) {
    const submitted = extras.classRank.submittedPct != null ? `; ${plainPercent(extras.classRank.submittedPct)}% of enrolled students submitted a class rank` : "";
    parts.push(`${extras.classRank.topTenthPct}% of enrolled students ranked in the top tenth of their class${extras.classRank.topQuarterPct != null ? ` (${extras.classRank.topQuarterPct}% top quarter)` : ""}${submitted}`);
  }
  // C11: the enrolled class's high-school GPA distribution, summarized as
  // the shares at 4.0 and at or above the two bands beneath it.
  const gpaBands = (Array.isArray(extras.gpaDistribution) ? extras.gpaDistribution : []).filter((b) => b && Number.isFinite(Number(b.low)) && Number.isFinite(Number(b.pct)));
  if (gpaBands.length) {
    const shareAtLeast = (floor) => plainPercent(gpaBands.filter((b) => Number(b.low) >= floor).reduce((sum, b) => sum + Number(b.pct), 0));
    const at40 = gpaBands.find((b) => Number(b.low) >= 4);
    const pieces = [at40 ? `${plainPercent(at40.pct)}% had a 4.0` : null, `${shareAtLeast(3.75)}% had 3.75 or higher`, `${shareAtLeast(3.5)}% had 3.50 or higher`].filter(Boolean);
    const submitted = extras.gpa?.submittedPct != null ? ` (${plainPercent(extras.gpa.submittedPct)}% of enrolled students submitted a GPA)` : "";
    parts.push(`enrolled high-school GPA distribution: ${pieces.join(", ")}${submitted}`);
  }
  if (extras.earlyDecision?.applications && extras.earlyDecision?.admitted) {
    parts.push(`Early Decision: ${formatNumber(extras.earlyDecision.applications)} applied, ${formatNumber(extras.earlyDecision.admitted)} admitted (${percent(extras.earlyDecision.admitRate)})`);
  }
  if (extras.applicationFeeUsd != null) parts.push(`application fee ${formatNumber(extras.applicationFeeUsd)} USD`);
  if (extras.aid?.averagePackageFirstYearUsd != null) parts.push(`average first-year need-based aid package ${formatNumber(extras.aid.averagePackageFirstYearUsd)} USD`);
  if (extras.studentFacultyRatio) parts.push(`student-to-faculty ratio ${extras.studentFacultyRatio}`);
  // The remaining sections (cds-sections.js): enrollment, retention and
  // graduation as the school reports them, the wait list, Early Action,
  // transfer volume, where first-year students come from and live, the
  // year's sticker costs, the share of need met, and class size.
  if (extras.enrollment?.undergraduates) parts.push(`${formatNumber(extras.enrollment.undergraduates)} undergraduates`);
  if (extras.retention?.firstYearPct != null) parts.push(`first-year retention ${plainPercent(extras.retention.firstYearPct)}% per the CDS`);
  if (extras.graduation?.sixYearPct != null) parts.push(`six-year graduation rate ${plainPercent(extras.graduation.sixYearPct)}%${extras.graduation.cohort ? ` (${extras.graduation.cohort} cohort)` : ""}`);
  const waitlist = extras.waitlist && typeof extras.waitlist === "object" ? extras.waitlist : {};
  const waitlistParts = [waitlist.offered != null ? `${formatNumber(waitlist.offered)} offered a place` : null, waitlist.accepted != null ? `${formatNumber(waitlist.accepted)} accepted it` : null, waitlist.admitted != null ? `${formatNumber(waitlist.admitted)} admitted from it` : null].filter(Boolean);
  if (waitlistParts.length) parts.push(`wait list: ${waitlistParts.join(", ")}`);
  if (extras.earlyAction?.applications && extras.earlyAction?.admitted) parts.push(`Early Action: ${formatNumber(extras.earlyAction.applications)} applied, ${formatNumber(extras.earlyAction.admitted)} admitted (${percent(extras.earlyAction.admitRate)})`);
  const transfer = extras.transfer && typeof extras.transfer === "object" ? extras.transfer : {};
  if (transfer.applied) parts.push(`transfer students: ${[`${formatNumber(transfer.applied)} applied`, transfer.admitted != null ? `${formatNumber(transfer.admitted)} admitted` : null, transfer.enrolled != null ? `${formatNumber(transfer.enrolled)} enrolled` : null].filter(Boolean).join(", ")}`);
  if (extras.studentLife?.outOfStatePct != null) parts.push(`${plainPercent(extras.studentLife.outOfStatePct)}% of first-year students come from out of state`);
  if (extras.studentLife?.onCampusPct != null) parts.push(`${plainPercent(extras.studentLife.onCampusPct)}% of first-year students live on campus`);
  const costs = extras.costs && typeof extras.costs === "object" ? extras.costs : {};
  const tuitionParts = [costs.tuitionUsd != null ? `${formatNumber(costs.tuitionUsd)} USD` : null, costs.tuitionInStateUsd != null ? `in-state ${formatNumber(costs.tuitionInStateUsd)} USD` : null, costs.tuitionOutOfStateUsd != null ? `out-of-state ${formatNumber(costs.tuitionOutOfStateUsd)} USD` : null].filter(Boolean);
  const costParts = [tuitionParts.length ? `tuition ${tuitionParts.join(" / ")}` : null, costs.requiredFeesUsd != null ? `required fees ${formatNumber(costs.requiredFeesUsd)} USD` : null, costs.foodAndHousingUsd != null ? `food and housing ${formatNumber(costs.foodAndHousingUsd)} USD` : null].filter(Boolean);
  if (costParts.length) parts.push(`${costParts.join(", ")} (${costs.academicYear ? `${costs.academicYear} academic year, ` : ""}per the CDS)`);
  if (extras.aid?.needMetPct != null) parts.push(`average share of financial need met ${plainPercent(extras.aid.needMetPct)}%`);
  if (extras.classSize?.under20Pct != null) parts.push(`${plainPercent(extras.classSize.under20Pct)}% of class sections have fewer than 20 students`);
  const dates = extras.dates && typeof extras.dates === "object" ? extras.dates : {};
  const dateParts = Object.entries(CDS_DATE_LABELS)
    .map(([key, label]) => (dates[key]?.mmdd ? `${label} ${dates[key].mmdd.replace("-", "/")}` : null))
    .filter(Boolean);
  if (dateParts.length) parts.push(`closing dates the school reported for its CDS cycle (month/day; confirm this year's dates on its admissions page): ${dateParts.join(", ")}`);
  return parts;
}

function cdsLine(record, validated) {
  if (!record) return null;
  const parts = [];
  const admit = percent(record.overallAdmitRate);
  // The counts behind the rate. Students ask how many applied, and the
  // model was sending them to the PDF for a number the record holds.
  const b1 = record.b1 && typeof record.b1 === "object" ? record.b1 : null;
  const counts = b1
    ? [b1.applied ? `${formatNumber(b1.applied)} applied` : null, b1.admitted ? `${formatNumber(b1.admitted)} admitted` : null, b1.enrolled ? `${formatNumber(b1.enrolled)} enrolled` : null].filter(Boolean)
    : [];
  if (admit) parts.push(`admit rate ${admit}${counts.length ? ` (${counts.join(", ")})` : ""}`);
  else if (counts.length) parts.push(counts.join(", "));
  if (record.yieldRate != null) parts.push(`yield ${percent(record.yieldRate)}`);
  const sat = range(record.enrolledSAT?.p25, record.enrolledSAT?.p75);
  if (sat) parts.push(`enrolled SAT middle 50% ${sat}`);
  const act = range(record.enrolledACT?.p25, record.enrolledACT?.p75);
  if (act) parts.push(`enrolled ACT middle 50% ${act}`);
  // An average above 4.0 is on the school's weighted scale (Harvard reports
  // 4.21); the model must not read it against an unweighted GPA.
  if (record.enrolledGPA?.avg != null) parts.push(`average enrolled GPA ${record.enrolledGPA.avg}${Number(record.enrolledGPA.avg) > 4 ? " (weighted scale)" : ""}`);
  // C11 read as a band: the lower bounds of the GPA ranges that hold the
  // 25th and 75th percentile of the enrolled class.
  const gpaBand = range(record.enrolledGPA?.p25, record.enrolledGPA?.p75);
  if (gpaBand && record.enrolledGPA?.p25 !== record.enrolledGPA?.p75) parts.push(`enrolled GPA middle 50% ${gpaBand}`);
  else if (gpaBand) parts.push(`enrolled GPA 25th and 75th percentile both in the ${gpaBand} band`);
  // The policy the store reads from the document, not the raw field: an old
  // parser wrote "test_required" by default, and UCLA's block still told the
  // model its Common Data Set said "test required". When the store has no
  // reading, the block says so rather than leave the model to fill one in
  // (on a record that holds anything else; an empty one stays no line).
  const testPolicy = readCdsTestPolicy(record).value;
  const policyAt = parts.length;
  if (testPolicy) parts.push(`test policy: ${String(testPolicy).replace(/_/g, " ")}`);
  const c7 = record.c7 && typeof record.c7 === "object" ? record.c7 : {};
  const veryImportant = Object.entries(c7).filter(([, v]) => v === "very_important").map(([k]) => C7_LABELS[k] || k.replace(/_/g, " "));
  const important = Object.entries(c7).filter(([, v]) => v === "important").map(([k]) => C7_LABELS[k] || k.replace(/_/g, " "));
  if (veryImportant.length) parts.push(`admissions factors rated very important: ${veryImportant.join(", ")}`);
  if (important.length) parts.push(`rated important: ${important.join(", ")}`);
  parts.push(...cdsExtrasParts(record.extras));
  if (!parts.length) return null;
  if (!testPolicy) parts.splice(policyAt, 0, "test policy: not read from the document");
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
//
// A read with no label used to give no line at all, and the model answered
// "how do I stand at Columbia?" from memory. A withheld read (the record has
// no GPA and no SAT/ACT) says what to add; a stale read (an older profile
// snapshot or engine version) says to reopen College Fit. Neither carries a
// label or a double-check.
const STUDENT_DATA_NEEDED = { gpa: "a GPA (unweighted or weighted)", sat_or_act: "an SAT or ACT score" };

function fitReadLine(read) {
  if (!read) return null;
  const date = String(read.computedAt || "").slice(0, 10);
  const school = presentText(read.school) || "this school";
  // Stale first: a student who has since added a GPA must not be told to add one.
  if (read.stale === true) {
    return `College Fit for THIS student at ${school}: an older read (computed ${date}); the profile or the engine changed since, so reopen College Fit for a current label, and quote no label for this school.`;
  }
  if ((read.labelKey || read.provenance?.labelKey) === "insufficient_student_data") {
    const needed = (Array.isArray(read.provenance?.studentDataNeeded) ? read.provenance.studentDataNeeded : [])
      .map((key) => STUDENT_DATA_NEEDED[key]).filter(Boolean);
    return `College Fit for THIS student at ${school}: no label yet; add ${needed.length ? needed.join(" and ") : "a GPA or an SAT or ACT score"} to get one.`;
  }
  if (!read.label) return null;
  const provenance = read.provenance?.kind
    ? ({ cds_store: "validated Common Data Set", cds_live: "live Common Data Set (unverified)", cds_web: "AI web-read CDS (unverified)", college_scorecard: "College Scorecard", baseline_only: "IPEDS baseline", none: "no stored school data" }[read.provenance.kind] || read.provenance.kind)
    : "stored data";
  const dims = [];
  if (read.admissibility != null) dims.push(`admissibility ${Math.round(read.admissibility)}/100`);
  if (read.competitiveness != null) dims.push(`competitiveness ${Math.round(read.competitiveness)}/100`);
  if (read.fit != null) dims.push(`fit ${Math.round(read.fit)}/100`);
  let line = `College Fit read for THIS student (computed ${date} from ${provenance}): ${read.label}`;
  if (dims.length) line += ` — ${dims.join(", ")}`;
  if (read.confidence) line += `; evidence confidence ${read.confidence}`;
  // The admit rate the read started from: for a regular-round applicant,
  // the pool outside Early Decision, which is lower than the headline rate
  // wherever ED admits are counted in it.
  const admit = read.provenance?.admitRate;
  if (admit?.basis === "outside_early_decision" && admit.used != null) {
    const pct = (v) => `${Math.round(v * 1000) / 10}%`;
    const context = [
      admit.overall != null ? `${pct(admit.overall)} overall` : null,
      admit.earlyDecision != null ? `${pct(admit.earlyDecision)} of Early Decision applicants were admitted` : null,
    ].filter(Boolean);
    line += `; it starts from the ${pct(admit.used)} admit rate for applicants outside Early Decision`
      + (context.length ? ` (${context.join("; ")})` : "");
  }
  // No admit rate on file: the likelihood starts from 50%, and the model
  // must not present it as a school's own figure.
  if (admit && admit.used == null && admit.assumedForLikelihood != null) {
    line += `; no admit rate is on file, so this likelihood assumes ${Math.round(Number(admit.assumedForLikelihood) * 100)}%`;
  }
  line += ". Use this exact label when the student asks how they stand here.";
  if (read.verification) line += ` ${formatVerificationLine(read.verification)}.`;
  return line;
}

// `unheld` names schools the question names that nothing is held for (no
// baseline row, Common Data Set, scouted policy or fit read, or a name that
// matched no known school). Each gets a line that says so: with no line the
// model was told nothing about the school at all, and answered from memory
// as if the block's silence were permission.
export function formatVerifiedDataBlock({ schools = [], facts = [], unheld = [] } = {}) {
  const lines = [];
  const held = [];
  for (const school of schools) {
    const base = baselineLine(school.baseline);
    const cds = cdsLine(school.cds, school.cdsValidated);
    const fit = fitReadLine(school.fitRead);
    if (!base && !cds && !school.policyLine && !fit) continue;
    held.push(String(school.name || "").toLowerCase());
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
  const missing = [];
  for (const raw of Array.isArray(unheld) ? unheld : []) {
    const name = presentText(raw);
    if (!name || held.includes(name.toLowerCase()) || missing.some((m) => m.toLowerCase() === name.toLowerCase())) continue;
    missing.push(name);
  }
  for (const name of missing.slice(0, 4)) {
    lines.push(`- ${name}: no verified data held — say you don't have verified figures for this school, point the student to its Common Data Set or the College Scorecard (collegescorecard.ed.gov), and never quote a statistic for it from memory`);
  }
  if (!lines.length) return "";
  return "VERIFIED DATA (the ONLY statistics you may cite — quote each figure exactly as written here and attribute it with the bracketed source; if a number you need is not listed, say you don't have verified data for it and point the student to nces.ed.gov/ipeds or the school's Common Data Set; never estimate a statistic from memory, and never attach a source to a figure that is not listed here):\n" + lines.join("\n");
}

// Whether a block holds any data, not only "no verified data held" lines:
// the chat's _meta.verifiedData means held data was sent.
export function blockHoldsVerifiedData(block) {
  return String(block || "").split("\n").some((line) => /^- /.test(line) && !/^- .*?: no verified data held — /.test(line));
}
