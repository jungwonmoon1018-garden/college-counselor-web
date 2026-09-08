// ═══════════════════════════════════════════════════════════════════════
// test-scores.js — the standardized tests the profile records, their score
// ranges, and the sections each one reports. A mirror of
// backend/test-catalog.js (a backend test pins the two copies together) so
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
  },
  act: {
    label: "ACT",
    total: { min: 1, max: 36, step: 1 },
    derive: "mean",
    sections: [
      { key: "english", label: "English", min: 1, max: 36, step: 1 },
      { key: "math", label: "Math", min: 1, max: 36, step: 1 },
      { key: "reading", label: "Reading", min: 1, max: 36, step: 1 },
      { key: "science", label: "Science", min: 1, max: 36, step: 1 },
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
// inputs and hints were built around.
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

export function sectionDefs(test) {
  return TEST_CATALOG[testKey(test)]?.sections || [];
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function sectionEntries(entry) {
  const sections = entry?.sections && typeof entry.sections === "object" ? entry.sections : {};
  const out = [];
  for (const def of sectionDefs(entry?.test)) {
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

export function deriveTotal(test, sections) {
  const spec = TEST_CATALOG[testKey(test)];
  if (!spec || !spec.derive) return null;
  const composite = spec.sections.filter((s) => s.composite !== false);
  const values = composite.map((s) => numberOrNull(sections?.[s.key]));
  if (!values.length || values.some((v) => v == null)) return null;
  if (spec.derive === "sum") return values.reduce((a, b) => a + b, 0);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (spec.derive === "mean") return Math.floor(mean + 0.5);
  if (spec.derive === "mean-half") return Math.floor(mean * 2 + 0.5) / 2;
  return null;
}

export function validateTestEntry(entry) {
  const errors = [];
  const key = testKey(entry?.test);
  const spec = TEST_CATALOG[key];
  if (!spec) return { ok: false, errors: [`Unknown test "${entry?.test}".`] };
  const total = numberOrNull(entry?.totalScore);
  const label = spec.label;
  const range = (r) => `${r.min}-${r.max}${r.step && r.step !== 1 ? ` in steps of ${r.step}` : ""}`;
  if (total == null) errors.push(`Enter a ${label} score.`);
  else if (total < spec.total.min || total > spec.total.max || !onStep(total, spec.total.step)) {
    errors.push(`${label} scores must be ${range(spec.total)}.`);
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
  const derived = deriveTotal(key, sections);
  if (derived != null && total != null && !errors.length) {
    const tolerance = spec.derive === "sum" ? 0 : (spec.derive === "mean" ? 1 : 0.5);
    if (Math.abs(derived - total) > tolerance) {
      const names = spec.sections.filter((s) => s.composite !== false).map((s) => s.label).join(", ");
      errors.push(spec.derive === "sum"
        ? `${label} ${names} must add up to the total.`
        : `${label} ${names} average to ${derived}, not ${total}.`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ─── Form ⇄ entry ─────────────────────────────────────────────────────
// Forms hold strings (what the inputs show); entries hold numbers (what the
// profile stores).
export function blankTestForm(test = "sat") {
  const key = TEST_CATALOG[testKey(test)] ? testKey(test) : "sat";
  return { test: key, totalScore: "", date: "", subject: "", sections: Object.fromEntries(sectionDefs(key).map((d) => [d.key, ""])) };
}

export function entryToForm(entry) {
  const form = blankTestForm(entry?.test);
  form.totalScore = entry?.totalScore != null ? String(entry.totalScore) : "";
  form.date = entry?.date || "";
  form.subject = entry?.subject || "";
  for (const def of sectionDefs(form.test)) {
    const value = entry?.sections?.[def.key];
    form.sections[def.key] = value != null && value !== "" ? String(value) : "";
  }
  return form;
}

export function formToEntry(form) {
  const key = testKey(form?.test);
  const sections = {};
  for (const def of sectionDefs(key)) {
    const value = numberOrNull(form?.sections?.[def.key]);
    if (value != null) sections[def.key] = value;
  }
  const total = numberOrNull(form?.totalScore) ?? deriveTotal(key, sections);
  const entry = { test: key, totalScore: total };
  if (Object.keys(sections).length) entry.sections = sections;
  if (form?.date) entry.date = form.date;
  const subject = String(form?.subject || "").trim().slice(0, 60);
  if (subject) entry.subject = subject;
  return entry;
}

// Section edits refill the total whenever every composite section is set
// (the SAT total is the sum of its two sections; the ACT composite the
// rounded mean of four). A test without a rule keeps whatever total the
// student typed.
export function withSection(form, key, value) {
  const sections = { ...(form.sections || {}), [key]: value };
  const derived = deriveTotal(form.test, sections);
  return { ...form, sections, totalScore: derived != null ? String(derived) : form.totalScore };
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
