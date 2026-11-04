// ═══════════════════════════════════════════════════════════════════════
// PROFILE INPUT — what a profile sync may store.
// ═══════════════════════════════════════════════════════════════════════
// POST /api/students/sync stored the body as sent. The student app checks
// its forms, but a value from an older build, a hand-written request, or a
// vault saved before a form gained its check went straight into the
// snapshot, the STUDENT PROFILE block and College Fit: a GPA of 39 (a
// missed decimal) or 95 (a 100-point average), an SAT of 1700, an AP score
// of 9. A GPA sent as text, or a course list that was not a list, crashed
// the whole save with a 500 instead.
//
// Every field is checked here before the snapshot is written. A value
// that cannot be stored is set aside and named in `setAside`, so the app
// can tell the student and the rest of the save still lands:
//   • a GPA out of range or not a number keeps the last stored GPA;
//   • a list field that is not a list keeps the last stored list;
//   • a bad entry inside a list (a test score outside its range, an AP
//     score that is not 1–5, an entry that is not an object) is dropped,
//     except that a bad test or AP score is replaced by the stored entry
//     it stands for (same test, scale, date and subject; same exam and
//     year) when there is one;
//   • a class rank that reads as nothing keeps the last stored rank.
// A field that is simply absent keeps today's meaning (no GPA, empty list).
// Set-aside test and AP entries are named one by one (`entries`: the
// place in the list, a label such as "SAT 1700", the reason in words, and
// `kept` when the stored version stood in). Before that a stale vault copy
// of a score wiped the stored one, the score lists and the rank were never
// kept, and every auto-save repeated "1 test score couldn't be read"
// without saying which.
// The frontend mirrors GPA_LIMITS in src/profile/gpa.js and the AP year
// rule in src/profile/ap-entry.js; tests/profile-input.test.js pins both.

import { normalizeTestEntry, normalizeTestDate, normalizeTestScores, normalizeClassRank, validateTestEntry, entryLabel, scaleKey, testKey } from "./test-catalog.js";
import { apExamKey, apFirstExamYear } from "./ap-exams.js";

// Unweighted GPAs are reported on 4.0, 4.3 or 5.0 scales (transcript import
// accepts the same 0–5); weighted scales reach 5.0 or 6.0.
export const GPA_LIMITS = Object.freeze({
  unweighted: Object.freeze({ min: 0, max: 5 }),
  weighted: Object.freeze({ min: 0, max: 6 }),
});

const NUMERIC_TEXT = /^\s*-?\d+(?:\.\d+)?\s*$/;

// The survey's "no GPA yet" and "no test taken yet" answers, the only
// values the app sends for them (fid-5). They are stored with the snapshot
// so the chat can say "none yet" instead of "not recorded" on any device.
export const PROFILE_STATUS_VALUES = Object.freeze({
  gpaStatus: Object.freeze(["pending"]),
  testingStatus: Object.freeze(["planned"]),
});

// A finite number, or numeric text such as "3.85"; anything else is null.
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && NUMERIC_TEXT.test(value)) return Number(value);
  return null;
}

const isPlainObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);

function gpaPart(raw, limits, previous, field, setAside) {
  if (raw == null || raw === "") return null;
  const value = toNumber(raw);
  if (value == null) {
    setAside.push({ field, reason: "not_a_number" });
    return keepPrevious(previous, limits);
  }
  if (value < limits.min || value > limits.max) {
    setAside.push({ field, reason: "out_of_range" });
    return keepPrevious(previous, limits);
  }
  return Math.round(value * 100) / 100;
}

// The last stored value stands in for one that was set aside, unless it is
// itself out of range (stored before these checks existed).
function keepPrevious(previous, limits) {
  const value = toNumber(previous);
  return value != null && value >= limits.min && value <= limits.max ? value : null;
}

function listField(raw, previous, field, setAside) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  setAside.push({ field, reason: "not_a_list" });
  return Array.isArray(previous) ? previous : [];
}

function dropInvalid(list, keep, field, setAside) {
  const out = list.filter(keep);
  if (out.length < list.length) setAside.push({ field, reason: "invalid_entry", count: list.length - out.length });
  return out;
}

// The latest year with AP scores out: scores are released in early July, so
// until then last year's are the newest. The app's latestApScoreYear
// (src/profile/ap-entry.js) uses the same rule; the server read the
// calendar year until 2026-11, so from January to June it kept a year
// whose scores were not out and the app refused it on the next edit.
export function latestApScoreYear(now = new Date()) {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

const apName = (raw) => String(raw?.exam ?? raw?.subject ?? raw?.name ?? "").trim();

// One AP entry in its stored shape, or { error } with the reason in words.
// A whole score 1–5 for a named exam (an entry with no exam name says
// nothing and is dropped). The year is kept when a score from it can
// exist, from the exam's first year (2000, or later for the newest exams in
// ap-exams.js) through the latest year with scores out; another year is
// dropped and the entry kept. Until 2026-10-09 any year to 2100 was kept.
function normalizeApEntry(raw, latest) {
  if (!isPlainObject(raw)) return { error: "This entry isn't an AP score." };
  const name = apName(raw);
  if (!name) return { error: "The exam isn't named." };
  const score = toNumber(raw.score);
  if (score == null || !Number.isInteger(score) || score < 1 || score > 5) return { error: "AP scores run 1-5." };
  const entry = { ...raw, score };
  const year = toNumber(raw.year);
  const first = Math.max(2000, apFirstExamYear(name) ?? 2000);
  if (year != null && Number.isInteger(year) && year >= first && year <= latest) entry.year = year;
  else delete entry.year;
  return { entry };
}

function normalizeApScores(list, now = new Date()) {
  const latest = latestApScoreYear(now);
  return list.map((raw) => normalizeApEntry(raw, latest).entry).filter(Boolean);
}

const apIdentity = (entry) => `${(apExamKey(apName(entry)) || apName(entry).replace(/^AP\s+/i, "")).toLowerCase()}|${toNumber(entry?.year) ?? ""}`;
const testIdentity = (entry) => [testKey(entry?.test), scaleKey(entry?.test, entry?.scale) || "", normalizeTestDate(entry?.date) || "", String(entry?.subject || "").trim().toLowerCase()].join("|");

// "SAT 1700 (2026-03)", "AP Biology 9 (2026)": how the student will
// recognize the entry. Nothing here reaches the model or the log.
function testEntryLabel(raw) {
  if (!isPlainObject(raw)) return "an entry that isn't a test score";
  const total = raw.totalScore ?? raw.total ?? raw.score;
  const subject = String(raw.subject || "").trim().slice(0, 40);
  const date = String(raw.date || "").trim().slice(0, 20);
  return `${entryLabel(raw)}${subject ? ` (${subject})` : ""}${total != null && total !== "" ? ` ${String(total).slice(0, 12)}` : ""}${date ? ` (${date})` : ""}`;
}
function apEntryLabel(raw) {
  if (!isPlainObject(raw)) return "an entry that isn't an AP score";
  const name = apName(raw).replace(/^AP\s+/i, "").slice(0, 60) || "unnamed exam";
  const score = raw.score != null && raw.score !== "" ? ` ${String(raw.score).slice(0, 6)}` : "";
  const year = raw.year != null && raw.year !== "" ? ` (${String(raw.year).slice(0, 6)})` : "";
  return `AP ${name}${score}${year}`;
}

// One set-aside item per field and reason, carrying the entries it names.
function setAsideEntry(setAside, field, reason, detail) {
  let item = setAside.find((s) => s.field === field && s.reason === reason && Array.isArray(s.entries));
  if (!item) {
    item = { field, reason, count: 0, entries: [] };
    setAside.push(item);
  }
  item.count += 1;
  item.entries.push(detail);
}

// A list of entries checked one by one. A bad entry is replaced by the
// stored entry with the same identity when the list does not already carry
// it, so a stale copy cannot wipe what the student had.
function checkEntries(sent, previousList, { field, normalize, identity, label }, setAside) {
  const results = sent.map((raw) => normalize(raw));
  const out = [];
  const used = new Set(results.filter((r) => r.entry).map((r) => JSON.stringify(r.entry)));
  results.forEach((result, index) => {
    const raw = sent[index];
    if (result.entry) {
      out.push(result.entry);
      if (result.note) setAsideEntry(setAside, field, result.note.reason, { index, label: label(raw), message: result.note.message });
      return;
    }
    const id = isPlainObject(raw) ? identity(raw) : null;
    const twin = id == null ? null : previousList.find((p) => identity(p) === id && !used.has(JSON.stringify(p)));
    if (twin) {
      used.add(JSON.stringify(twin));
      out.push(twin);
    }
    setAsideEntry(setAside, field, result.reason || "invalid_entry", { index, label: label(raw), message: result.error, ...(twin ? { kept: true } : {}) });
  });
  return out;
}

function normalizeTestForSync(raw) {
  const normalized = normalizeTestEntry(raw);
  if (!normalized) return { error: isPlainObject(raw) ? "This isn't a test this profile records." : "This entry isn't a test score." };
  const check = validateTestEntry(normalized.entry);
  if (!check.ok) return { error: check.errors[0], reason: check.reason };
  if (normalized.dateUnreadable) {
    return { entry: normalized.entry, note: { reason: "date_unreadable", message: "The test date couldn't be read, so it was left off. Pick the month again." } };
  }
  return { entry: normalized.entry };
}

/**
 * Check a sync body before it is stored.
 * @param {object} input    { profile, activities, goals, majorInterest } as sent
 * @param {object} previous the last stored values (from the latest snapshot):
 *                          { gpaUnweighted, gpaWeighted, courses, activities,
 *                            goals, majorInterest, testScores, apScores, classRank,
 *                            gpaStatus, testingStatus }
 * @param {object} options  { now }: the clock an AP score's year is checked against
 * @returns {{ profile, activities, goals, majorInterest, setAside: Array<{field, reason, count?, kept?, entries?: Array<{index, label, message, kept?}>}> }}
 */
export function normalizeSyncInput({ profile, activities, goals, majorInterest } = {}, previous = {}, { now = new Date() } = {}) {
  const setAside = [];
  const source = isPlainObject(profile) ? profile : {};
  if (profile != null && !isPlainObject(profile)) setAside.push({ field: "profile", reason: "not_an_object" });

  const out = { ...source };

  // GPA: both parts checked on their own; an absent GPA stays absent.
  if (isPlainObject(source.gpa)) {
    const unweighted = gpaPart(source.gpa.unweighted, GPA_LIMITS.unweighted, previous.gpaUnweighted, "gpa.unweighted", setAside);
    const weighted = gpaPart(source.gpa.weighted, GPA_LIMITS.weighted, previous.gpaWeighted, "gpa.weighted", setAside);
    out.gpa = unweighted == null && weighted == null ? null : { ...source.gpa, unweighted, weighted };
  } else if (source.gpa != null) {
    setAside.push({ field: "gpa", reason: "not_an_object" });
    const unweighted = keepPrevious(previous.gpaUnweighted, GPA_LIMITS.unweighted);
    const weighted = keepPrevious(previous.gpaWeighted, GPA_LIMITS.weighted);
    out.gpa = unweighted == null && weighted == null ? null : { unweighted, weighted };
  }

  // Courses: a list of objects.
  out.courses = dropInvalid(listField(source.courses, previous.courses, "courses", setAside), isPlainObject, "courses", setAside);

  // Test scores: the catalog's ranges and section sums, one entry at a
  // time; a list that is not a list keeps the stored list.
  const previousTests = normalizeTestScores(Array.isArray(previous.testScores) ? previous.testScores : []);
  if (source.testScores != null && !Array.isArray(source.testScores)) {
    setAside.push({ field: "testScores", reason: "not_a_list" });
    out.testScores = previousTests;
  } else {
    const sent = Array.isArray(source.testScores) ? source.testScores : [];
    out.testScores = checkEntries(sent, previousTests, { field: "testScores", normalize: normalizeTestForSync, identity: testIdentity, label: testEntryLabel }, setAside);
  }

  // AP exam scores: whole numbers 1–5 for a named exam; a year no score can
  // come from is dropped from its entry, not the entry itself.
  const latestAp = latestApScoreYear(now);
  const previousAp = normalizeApScores(Array.isArray(previous.apScores) ? previous.apScores : [], now);
  if (source.apScores != null && !Array.isArray(source.apScores)) {
    setAside.push({ field: "apScores", reason: "not_a_list" });
    out.apScores = previousAp;
  } else {
    const sent = Array.isArray(source.apScores) ? source.apScores : [];
    out.apScores = checkEntries(sent, previousAp, { field: "apScores", normalize: (raw) => normalizeApEntry(raw, latestAp), identity: apIdentity, label: apEntryLabel }, setAside);
  }

  // Class rank: syncStudentData stores normalizeClassRank's reading. A rank
  // that reads as nothing (past the end of the class, a share over 100%) is
  // named here, and the stored rank stands in for it: a typo of 500 of 400
  // used to replace a stored 5 of 400 with nothing. An absent rank is
  // still a clear.
  if (source.classRank != null && normalizeClassRank(source.classRank) == null) {
    const kept = normalizeClassRank(previous.classRank);
    setAside.push({ field: "classRank", reason: "out_of_range", ...(kept ? { kept: true } : {}) });
    out.classRank = kept;
  }

  // The GPA and testing statuses. An absent one is no statement: the app
  // sends the whole profile, so absence is a clear. An unknown one is set
  // aside for the stored one. A GPA or a test score on the record outranks
  // the statement that there is none, as the app's merge has it
  // (profile-reconcile.js cohere).
  for (const [field, allowed] of Object.entries(PROFILE_STATUS_VALUES)) {
    const raw = source[field];
    if (raw == null || raw === "") {
      out[field] = null;
    } else if (typeof raw === "string" && allowed.includes(raw.trim())) {
      out[field] = raw.trim();
    } else {
      const kept = allowed.includes(previous[field]) ? previous[field] : null;
      setAside.push({ field, reason: "unknown_status", ...(kept ? { kept: true } : {}) });
      out[field] = kept;
    }
  }
  if (isPlainObject(out.gpa) && (toNumber(out.gpa.unweighted) != null || toNumber(out.gpa.weighted) != null)) out.gpaStatus = null;
  if (out.testScores.length) out.testingStatus = null;

  const outActivities = dropInvalid(listField(activities, previous.activities, "activities", setAside), isPlainObject, "activities", setAside);
  const outGoals = dropInvalid(
    listField(goals, previous.goals, "goals", setAside),
    (g) => (typeof g === "string" && g.trim() !== "") || isPlainObject(g),
    "goals",
    setAside,
  );

  let outMajor = null;
  if (typeof majorInterest === "string") outMajor = majorInterest.trim() || null;
  else if (majorInterest != null) {
    setAside.push({ field: "majorInterest", reason: "not_text" });
    outMajor = typeof previous.majorInterest === "string" ? previous.majorInterest : null;
  }

  return { profile: out, activities: outActivities, goals: outGoals, majorInterest: outMajor, setAside };
}

// The last stored values, read from a profile_snapshots row.
export function previousFromSnapshot(row, parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } }) {
  if (!row) return {};
  return {
    gpaUnweighted: row.gpa_unweighted,
    gpaWeighted: row.gpa_weighted,
    courses: parse(row.courses_json, []),
    activities: parse(row.activities_json, []),
    goals: parse(row.goals_json, []),
    majorInterest: row.major_interest,
    testScores: parse(row.test_scores_json, []),
    apScores: parse(row.ap_scores_json, []),
    classRank: parse(row.class_rank_json, null),
    gpaStatus: row.gpa_status || null,
    testingStatus: row.testing_status || null,
  };
}
