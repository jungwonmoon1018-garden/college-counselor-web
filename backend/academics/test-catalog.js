// ═══════════════════════════════════════════════════════════════════════
// TEST CATALOG — the standardized tests a student profile records, the
// score range of each, and the sections each one reports.
// ═══════════════════════════════════════════════════════════════════════
// One definition serves the STUDENT PROFILE block and the fidelity check
// (chat-grounding.js), the College Fit read (positioning-engine.js), and the
// profile normalization on sync. The student app carries a mirror in
// frontend/src/test-scores.js so the survey and the dashboard validate the
// same ranges; tests/test-catalog.test.js pins the two copies together.
//
// A section marked `composite: false` (ACT Writing) is reported but never
// folded into the total; `derive` says how a total follows from the
// sections when the student enters those first.
//
// The ACT has two formats. The enhanced ACT (online from April 2025, every
// national date from September 2025) makes the composite the rounded mean
// of English, Math and Reading and reports the optional Science section on
// its own, so Science is `composite: false` like Writing. A sitting dated
// before `legacy.before` used the old four-section mean. Until this rule
// existed the form averaged all four for every sitting, auto-filled a
// current student's 35 as 33 and then refused the real 35.
//
// `scales` are other score scales of the same test, chosen by the entry's
// `scale` field: TOEFL iBT's 1-6 band (reported from January 2026, with the
// 0-120 score alongside during the transition) and PSAT 8/9 (240-1440).
// They stay under the test's own key so every reader that groups sittings
// by test, the fidelity check among them, still finds them. Before they
// existed a band 5 was stored as a failing 5 of 120, a 5.5 was refused and
// a ninth grader's PSAT 8/9 below 320 could not be saved. A TOEFL total of
// 6 or below with no scale is ambiguous (`ambiguousAtOrBelow`), so it is
// refused with a request for the scale rather than guessed at.

export const TEST_CATALOG = Object.freeze({
  sat: {
    label: "SAT",
    total: { min: 400, max: 1600, step: 10 },
    derive: "sum",
    sections: [
      { key: "readingWriting", label: "Reading & Writing", min: 200, max: 800, step: 10 },
      { key: "math", label: "Math", min: 200, max: 800, step: 10 },
    ],
  },
  psat: {
    label: "PSAT",
    total: { min: 320, max: 1520, step: 10 },
    derive: "sum",
    sections: [
      { key: "readingWriting", label: "Reading & Writing", min: 160, max: 760, step: 10 },
      { key: "math", label: "Math", min: 160, max: 760, step: 10 },
    ],
    scales: {
      "8/9": {
        label: "PSAT 8/9",
        total: { min: 240, max: 1440, step: 10 },
        sections: [
          { key: "readingWriting", label: "Reading & Writing", min: 120, max: 720, step: 10 },
          { key: "math", label: "Math", min: 120, max: 720, step: 10 },
        ],
      },
    },
  },
  act: {
    label: "ACT",
    total: { min: 1, max: 36, step: 1 },
    derive: "mean",
    legacy: { before: "2025-04", composite: ["english", "math", "reading", "science"], note: "with Science, as the ACT counted it before April 2025" },
    sections: [
      { key: "english", label: "English", min: 1, max: 36, step: 1 },
      { key: "math", label: "Math", min: 1, max: 36, step: 1 },
      { key: "reading", label: "Reading", min: 1, max: 36, step: 1 },
      { key: "science", label: "Science", min: 1, max: 36, step: 1, composite: false },
      { key: "writing", label: "Writing", min: 2, max: 12, step: 1, composite: false },
    ],
  },
  toefl: {
    label: "TOEFL",
    total: { min: 0, max: 120, step: 1 },
    derive: "sum",
    sections: [
      { key: "reading", label: "Reading", min: 0, max: 30, step: 1 },
      { key: "listening", label: "Listening", min: 0, max: 30, step: 1 },
      { key: "speaking", label: "Speaking", min: 0, max: 30, step: 1 },
      { key: "writing", label: "Writing", min: 0, max: 30, step: 1 },
    ],
    ambiguousAtOrBelow: 6,
    scales: {
      band: {
        label: "TOEFL (1-6 band)",
        total: { min: 1, max: 6, step: 0.5 },
        derive: "mean-half",
        sections: [
          { key: "reading", label: "Reading", min: 1, max: 6, step: 0.5 },
          { key: "listening", label: "Listening", min: 1, max: 6, step: 0.5 },
          { key: "speaking", label: "Speaking", min: 1, max: 6, step: 0.5 },
          { key: "writing", label: "Writing", min: 1, max: 6, step: 0.5 },
        ],
      },
    },
  },
  ielts: {
    label: "IELTS",
    total: { min: 0, max: 9, step: 0.5 },
    derive: "mean-half",
    sections: [
      { key: "listening", label: "Listening", min: 0, max: 9, step: 0.5 },
      { key: "reading", label: "Reading", min: 0, max: 9, step: 0.5 },
      { key: "writing", label: "Writing", min: 0, max: 9, step: 0.5 },
      { key: "speaking", label: "Speaking", min: 0, max: 9, step: 0.5 },
    ],
  },
  duolingo: {
    label: "Duolingo English Test",
    total: { min: 10, max: 160, step: 5 },
    derive: null,
    sections: [
      { key: "literacy", label: "Literacy", min: 10, max: 160, step: 5 },
      { key: "comprehension", label: "Comprehension", min: 10, max: 160, step: 5 },
      { key: "conversation", label: "Conversation", min: 10, max: 160, step: 5 },
      { key: "production", label: "Production", min: 10, max: 160, step: 5 },
    ],
  },
  sat_subject: { label: "SAT Subject Test", total: { min: 200, max: 800, step: 10 }, derive: null, sections: [] },
  clep: { label: "CLEP", total: { min: 20, max: 80, step: 1 }, derive: null, sections: [] },
});

export const TEST_KEYS = Object.freeze(Object.keys(TEST_CATALOG));

export function testKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function testLabel(test) {
  const key = testKey(test);
  return TEST_CATALOG[key]?.label || (key ? key.toUpperCase() : "test");
}

// The scale an entry names when its test has one by that name, else null
// (the test's own scale).
export function scaleKey(test, scale) {
  const key = String(scale ?? "").trim();
  return key && TEST_CATALOG[testKey(test)]?.scales?.[key] ? key : null;
}

// The spec an entry is scored on: the test's own, or the named scale laid
// over it (its label, ranges, sections and derive rule).
export function testSpec(test, scale) {
  const base = TEST_CATALOG[testKey(test)];
  if (!base) return null;
  const variant = scaleKey(test, scale) ? base.scales[String(scale).trim()] : null;
  return variant ? { ...base, ...variant } : base;
}

// "TOEFL (1-6 band)", "PSAT 8/9", or the test's own label.
export function entryLabel(entry) {
  return testSpec(entry?.test, entry?.scale)?.label || testLabel(entry?.test);
}

export function sectionDefs(test, scale) {
  return testSpec(test, scale)?.sections || [];
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The sections an entry actually carries, in catalog order, with labels.
// Unknown keys are ignored so a stray field never reaches the model.
export function sectionEntries(entry) {
  const defs = sectionDefs(entry?.test, entry?.scale);
  const sections = entry?.sections && typeof entry.sections === "object" ? entry.sections : {};
  const out = [];
  for (const def of defs) {
    const value = numberOrNull(sections[def.key]);
    if (value != null) out.push({ key: def.key, label: def.label, value });
  }
  return out;
}

// "Reading & Writing 720, Math 780" — the rendering both the profile block
// and the fidelity footnote use.
export function formatSections(entry) {
  return sectionEntries(entry).map((s) => `${s.label} ${s.value}`).join(", ");
}

function onStep(value, step) {
  if (!step) return true;
  return Math.abs(value / step - Math.round(value / step)) < 1e-6;
}

function datedBefore(date, month) {
  const text = String(date || "");
  return /^\d{4}-\d{2}/.test(text) && text.slice(0, 7) < month;
}

// The sections a composite is the mean or sum of: the ACT's three since the
// enhanced format, its four for a sitting dated before it.
function compositeKeys(spec, date) {
  if (spec.legacy && datedBefore(date, spec.legacy.before)) return spec.legacy.composite;
  return spec.sections.filter((s) => s.composite !== false).map((s) => s.key);
}

function totalFrom(spec, keys, sections) {
  const values = keys.map((key) => numberOrNull(sections?.[key]));
  if (!values.length || values.some((v) => v == null)) return null;
  if (spec.derive === "sum") return values.reduce((a, b) => a + b, 0);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (spec.derive === "mean") return Math.floor(mean + 0.5);
  if (spec.derive === "mean-half") return Math.floor(mean * 2 + 0.5) / 2;
  return null;
}

// The total the sections imply, or null when a section is missing or the
// test has no rule. The ACT rounds the mean of English, Math and Reading
// (of all four with Science for a sitting dated before April 2025) to the
// nearest whole number, halves up; IELTS and the TOEFL band round the mean
// to the nearest half band (.25 and .75 round up, as the tests do).
export function deriveTotal(test, sections, { date = null, scale = null } = {}) {
  const spec = testSpec(test, scale);
  if (!spec || !spec.derive) return null;
  return totalFrom(spec, compositeKeys(spec, date), sections);
}

// Every total the sections can stand for, the one the date implies first.
// An undated or recent ACT sitting may still be an old-format one (a school
// day or a spring 2025 paper sitting), so its four-section mean is accepted
// beside the three-section one.
export function acceptedTotals(test, sections, { date = null, scale = null } = {}) {
  const spec = testSpec(test, scale);
  if (!spec || !spec.derive) return [];
  const out = [];
  const primary = totalFrom(spec, compositeKeys(spec, date), sections);
  if (primary != null) out.push(primary);
  if (spec.legacy && !datedBefore(date, spec.legacy.before)) {
    const legacy = totalFrom(spec, spec.legacy.composite, sections);
    if (legacy != null && !out.includes(legacy)) out.push(legacy);
  }
  return out;
}

// Range and step checks for a whole entry, plus the consistency rule
// between sections and total. Returns the problems as short sentences so a
// form can show them verbatim, and a `reason` code when the entry needs a
// choice rather than a fix (`scale_needed`).
export function validateTestEntry(entry) {
  const errors = [];
  const key = testKey(entry?.test);
  if (!TEST_CATALOG[key]) return { ok: false, errors: [`Unknown test "${entry?.test}".`] };
  const rawScale = String(entry?.scale ?? "").trim();
  if (rawScale && !scaleKey(key, rawScale)) return { ok: false, errors: [`Unknown ${testLabel(key)} scale "${rawScale}".`] };
  const scale = scaleKey(key, rawScale);
  const spec = testSpec(key, scale);
  const total = numberOrNull(entry?.totalScore);
  const label = spec.label;
  const range = (r) => `${r.min}-${r.max}${r.step && r.step !== 1 ? ` in steps of ${r.step}` : ""}`;
  if (total == null) errors.push(`Enter a ${label} score.`);
  else if (total < spec.total.min || total > spec.total.max || !onStep(total, spec.total.step)) {
    errors.push(`${label} scores must be ${range(spec.total)}.`);
  } else if (!scale && spec.ambiguousAtOrBelow != null && total <= spec.ambiguousAtOrBelow) {
    const band = Object.values(spec.scales || {})[0];
    return {
      ok: false,
      reason: "scale_needed",
      errors: [`A ${label} score of ${total} looks like a ${band?.label || "band"} score. Choose that scale, or enter the ${range(spec.total)} score.`],
    };
  }
  const sections = entry?.sections && typeof entry.sections === "object" ? entry.sections : {};
  for (const def of spec.sections) {
    const value = numberOrNull(sections[def.key]);
    if (sections[def.key] != null && sections[def.key] !== "" && value == null) {
      errors.push(`${label} ${def.label} must be a number.`);
      continue;
    }
    if (value == null) continue;
    if (value < def.min || value > def.max || !onStep(value, def.step)) errors.push(`${label} ${def.label} must be ${range(def)}.`);
  }
  const accepted = acceptedTotals(key, sections, { date: entry?.date, scale });
  if (accepted.length && total != null && !errors.length) {
    const tolerance = spec.derive === "sum" ? 0 : (spec.derive === "mean" ? 1 : 0.5);
    if (!accepted.some((derived) => Math.abs(derived - total) <= tolerance)) {
      const labels = Object.fromEntries(spec.sections.map((s) => [s.key, s.label]));
      const names = compositeKeys(spec, entry?.date).map((k) => labels[k] || k).join(", ");
      const other = accepted.length > 1 && spec.legacy ? ` (${accepted[1]} ${spec.legacy.note})` : "";
      errors.push(spec.derive === "sum"
        ? `${label} ${names} must add up to the total.`
        : `${label} ${names} average to ${accepted[0]}${other}, not ${total}.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// A sitting is kept by month. The forms send YYYY-MM, but older builds and
// hand-written requests sent "2026-3", "3/2026", "March 2026" or a full
// date, and those used to vanish without a word. Returns "YYYY-MM", "" for
// no date, or null for a date that cannot be read (the caller says so).
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export function normalizeTestDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  let year = null;
  let month = null;
  let m;
  if ((m = text.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2}(?:[T ].*)?)?$/))) { year = Number(m[1]); month = Number(m[2]); }
  else if ((m = text.match(/^(\d{1,2})[-/.](\d{4})$/))) { month = Number(m[1]); year = Number(m[2]); }
  else if ((m = text.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월$/))) { year = Number(m[1]); month = Number(m[2]); }
  else if ((m = text.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) {
    const word = m[1].toLowerCase();
    const index = MONTH_NAMES.findIndex((name) => name.startsWith(word));
    if (index < 0) return null;
    month = index + 1;
    year = Number(m[2]);
  } else return null;
  if (!(month >= 1 && month <= 12) || !(year >= 1990 && year <= 2100)) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

// One entry in its stored shape, or null when it is not a known test: a
// numeric total, numeric sections from the catalog, a known scale, a
// trimmed subject, a YYYY-MM date. `dateUnreadable` is set (and the date
// left off) when a date was sent that could not be read.
export function normalizeTestEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = testKey(raw.test);
  if (!TEST_CATALOG[key]) return null;
  const scale = scaleKey(key, raw.scale);
  const sections = {};
  for (const def of sectionDefs(key, scale)) {
    const value = numberOrNull(raw.sections?.[def.key]);
    if (value != null) sections[def.key] = value;
  }
  const date = normalizeTestDate(raw.date);
  let total = numberOrNull(raw.totalScore ?? raw.total ?? raw.score);
  if (total == null) total = deriveTotal(key, sections, { date, scale });
  const entry = { test: key, totalScore: total };
  if (scale) entry.scale = scale;
  if (Object.keys(sections).length) entry.sections = sections;
  const subject = String(raw.subject || "").trim().slice(0, 60);
  if (subject) entry.subject = subject;
  if (date) entry.date = date;
  // A scale this catalog does not know is kept for validation to refuse,
  // never silently read on the test's own scale.
  const rawScale = String(raw.scale ?? "").trim();
  if (rawScale && !scale) entry.scale = rawScale;
  return { entry, dateUnreadable: date === null };
}

// The stored shape of a test-score list. Entries that fail the range checks
// are dropped rather than guessed at — the client validates before it
// saves, so a bad entry here came from an older build or a hand-written
// request. profile-input.js reports what it drops.
export function normalizeTestScores(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const normalized = normalizeTestEntry(raw);
    if (!normalized || !validateTestEntry(normalized.entry).ok) continue;
    out.push(normalized.entry);
  }
  return out;
}

// ─── Class rank ───────────────────────────────────────────────────────
// Recorded as the student's standing from the top ("top 5%"), or as a
// rank in a class of a known size, which implies the share. Either form
// yields `topPercent`; a rank without a size is kept but says nothing
// about standing.
export function normalizeClassRank(value) {
  if (!value || typeof value !== "object") return null;
  const rank = numberOrNull(value.rank);
  const size = numberOrNull(value.size);
  let topPercent = numberOrNull(value.topPercent);
  if (rank != null && size != null) {
    if (rank < 1 || size < rank) return null; // a rank past the end of the class is not a rank
    topPercent = Math.round((rank / size) * 1000) / 10;
  }
  if (topPercent != null && (topPercent <= 0 || topPercent > 100)) topPercent = null;
  if (topPercent == null && rank == null) return null;
  const out = {};
  if (topPercent != null) out.topPercent = topPercent;
  if (rank != null && rank >= 1) out.rank = Math.round(rank);
  if (size != null && size >= 1) out.size = Math.round(size);
  return Object.keys(out).length ? out : null;
}

export function formatClassRank(classRank) {
  const rank = normalizeClassRank(classRank);
  if (!rank) return "";
  const parts = [];
  if (rank.topPercent != null) parts.push(`top ${rank.topPercent}%`);
  if (rank.rank != null) parts.push(rank.size != null ? `${rank.rank} of ${rank.size}` : `rank ${rank.rank}`);
  return parts.join(" (") + (parts.length > 1 ? ")" : "");
}
