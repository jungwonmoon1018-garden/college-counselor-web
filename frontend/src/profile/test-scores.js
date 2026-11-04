// ═══════════════════════════════════════════════════════════════════════
// test-scores.js — the standardized tests the profile records, their score
// ranges, and the sections each one reports. A mirror of
// backend/academics/test-catalog.js (a backend test pins the two copies together) so
// the survey, the dashboard editor and the server validate the same rules.
// ═══════════════════════════════════════════════════════════════════════

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

// The order the survey's test chips use; short labels for the chips.
export const TEST_ORDER = Object.freeze([
  ["sat", "SAT"], ["act", "ACT"], ["psat", "PSAT"], ["toefl", "TOEFL"], ["ielts", "IELTS"],
  ["sat_subject", "SAT Subject"], ["duolingo", "Duolingo"], ["clep", "CLEP"],
]);

function rangeLabel(r) {
  return `${r.min}-${r.max}${r.step === 0.5 ? ".0" : ""}`;
}

// { sat: { min, max, step, label }, … } — the shape the survey's number
// inputs and hints were built around. scoreLimits() gives the same for an
// entry's chosen scale.
export const TEST_SCORE_LIMITS = Object.freeze(Object.fromEntries(
  Object.entries(TEST_CATALOG).map(([key, spec]) => [key, { ...spec.total, label: rangeLabel(spec.total) }]),
));

export function testKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function testLabel(test) {
  const key = testKey(test);
  return TEST_CATALOG[key]?.label || (key ? key.toUpperCase() : "test");
}

export function scaleKey(test, scale) {
  const key = String(scale ?? "").trim();
  return key && TEST_CATALOG[testKey(test)]?.scales?.[key] ? key : null;
}

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

export function scoreLimits(test, scale) {
  const spec = testSpec(test, scale);
  return spec ? { ...spec.total, label: rangeLabel(spec.total) } : null;
}

// The scale picker for a test with more than one scale: the test's own
// first (value ""), then each named one. TOEFL's band score arrived in
// January 2026; a student who types a band 5 on the 0-120 scale is asked
// to pick this rather than stored as 5 of 120.
const SCALE_CHOICE_LABELS = Object.freeze({
  toefl: { "": "0-120 score", band: "1-6 band score (2026 and later)" },
  psat: { "": "PSAT/NMSQT or PSAT 10 (320-1520)", "8/9": "PSAT 8/9 (240-1440)" },
});
export function scaleChoices(test) {
  const key = testKey(test);
  const spec = TEST_CATALOG[key];
  if (!spec?.scales) return [];
  const labels = SCALE_CHOICE_LABELS[key] || {};
  return ["", ...Object.keys(spec.scales)].map((value) => ({
    value,
    label: labels[value] || (value ? `${spec.scales[value].label} ${rangeLabel(spec.scales[value].total)}` : `${spec.label} ${rangeLabel(spec.total)}`),
  }));
}

export function sectionDefs(test, scale) {
  return testSpec(test, scale)?.sections || [];
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function sectionEntries(entry) {
  const sections = entry?.sections && typeof entry.sections === "object" ? entry.sections : {};
  const out = [];
  for (const def of sectionDefs(entry?.test, entry?.scale)) {
    const value = numberOrNull(sections[def.key]);
    if (value != null) out.push({ key: def.key, label: def.label, value });
  }
  return out;
}

export function formatSections(entry, { short = false } = {}) {
  const abbreviations = { readingWriting: "R&W", english: "E", math: "M", reading: "R", science: "S", writing: "W", listening: "L", speaking: "Sp", literacy: "Lit", comprehension: "Comp", conversation: "Conv", production: "Prod" };
  return sectionEntries(entry)
    .map((s) => `${short ? (abbreviations[s.key] || s.label) : s.label} ${s.value}`)
    .join(short ? " · " : ", ");
}

function onStep(value, step) {
  if (!step) return true;
  return Math.abs(value / step - Math.round(value / step)) < 1e-6;
}

function datedBefore(date, month) {
  const text = String(date || "");
  return /^\d{4}-\d{2}/.test(text) && text.slice(0, 7) < month;
}

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

export function deriveTotal(test, sections, { date = null, scale = null } = {}) {
  const spec = testSpec(test, scale);
  if (!spec || !spec.derive) return null;
  return totalFrom(spec, compositeKeys(spec, date), sections);
}

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

// ─── Form ⇄ entry ─────────────────────────────────────────────────────
// Forms hold strings (what the inputs show); entries hold numbers (what the
// profile stores).
export function blankTestForm(test = "sat") {
  const key = TEST_CATALOG[testKey(test)] ? testKey(test) : "sat";
  return { test: key, scale: "", totalScore: "", date: "", subject: "", sections: Object.fromEntries(sectionDefs(key).map((d) => [d.key, ""])) };
}

export function entryToForm(entry) {
  const form = blankTestForm(entry?.test);
  form.scale = scaleKey(form.test, entry?.scale) || "";
  form.totalScore = entry?.totalScore != null ? String(entry.totalScore) : "";
  form.date = entry?.date || "";
  form.subject = entry?.subject || "";
  for (const def of sectionDefs(form.test, form.scale)) {
    const value = entry?.sections?.[def.key];
    form.sections[def.key] = value != null && value !== "" ? String(value) : "";
  }
  return form;
}

export function formToEntry(form) {
  const key = testKey(form?.test);
  const scale = scaleKey(key, form?.scale);
  const sections = {};
  for (const def of sectionDefs(key, scale)) {
    const value = numberOrNull(form?.sections?.[def.key]);
    if (value != null) sections[def.key] = value;
  }
  const total = numberOrNull(form?.totalScore) ?? deriveTotal(key, sections, { date: form?.date, scale });
  const entry = { test: key, totalScore: total };
  if (scale) entry.scale = scale;
  if (Object.keys(sections).length) entry.sections = sections;
  if (form?.date) entry.date = form.date;
  const subject = String(form?.subject || "").trim().slice(0, 60);
  if (subject) entry.subject = subject;
  return entry;
}

// Section edits refill the total whenever every composite section is set
// (the SAT total is the sum of its two sections; the ACT composite the
// rounded mean of English, Math and Reading). A total the student typed is
// kept when one of the test's formats yields it, or while the older ACT
// format could still yield it (Science not entered yet), so a four-section
// composite is not overwritten by the three-section one; before that a
// student who typed her real 35 watched it turn into 33. A test without a
// rule keeps whatever total the student typed.
export function withSection(form, key, value) {
  const sections = { ...(form.sections || {}), [key]: value };
  const accepted = acceptedTotals(form.test, sections, { date: form.date, scale: form.scale });
  if (!accepted.length) return { ...form, sections };
  const typed = numberOrNull(form.totalScore);
  const spec = testSpec(form.test, form.scale);
  const legacyPending = Boolean(spec?.legacy) && !datedBefore(form.date, spec.legacy.before)
    && totalFrom(spec, spec.legacy.composite, sections) == null;
  const keep = typed != null && (accepted.includes(typed) || legacyPending);
  return { ...form, sections, totalScore: keep ? form.totalScore : String(accepted[0]) };
}

// A scale change re-derives the total from the sections when it can and
// otherwise keeps what was typed.
export function withScale(form, scale) {
  const next = { ...form, scale: scaleKey(form.test, scale) || "" };
  const derived = deriveTotal(next.test, next.sections, { date: next.date, scale: next.scale });
  return derived != null ? { ...next, totalScore: String(derived) } : next;
}

// ─── Class rank ───────────────────────────────────────────────────────
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
