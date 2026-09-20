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

export const TEST_KEYS = Object.freeze(Object.keys(TEST_CATALOG));

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

// The sections an entry actually carries, in catalog order, with labels.
// Unknown keys are ignored so a stray field never reaches the model.
export function sectionEntries(entry) {
  const defs = sectionDefs(entry?.test);
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

// The total the sections imply, or null when a section is missing or the
// test has no rule. ACT rounds the mean of the four subject scores to the
// nearest whole number (halves up); IELTS rounds the mean to the nearest
// half band (.25 and .75 round up, as the test does).
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

// Range and step checks for a whole entry, plus the consistency rule
// between sections and total. Returns the problems as short sentences so a
// form can show them verbatim.
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

// The stored shape of a test-score list: known tests only, numeric totals,
// numeric sections from the catalog, a trimmed subject, a YYYY-MM date.
// Entries that fail the range checks are dropped rather than guessed at —
// the client validates before it saves, so a bad entry here came from an
// older build or a hand-written request.
export function normalizeTestScores(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const key = testKey(raw.test);
    const spec = TEST_CATALOG[key];
    if (!spec) continue;
    const sections = {};
    for (const def of spec.sections) {
      const value = numberOrNull(raw.sections?.[def.key]);
      if (value != null) sections[def.key] = value;
    }
    let total = numberOrNull(raw.totalScore ?? raw.total ?? raw.score);
    if (total == null) total = deriveTotal(key, sections);
    const entry = { test: key, totalScore: total };
    if (Object.keys(sections).length) entry.sections = sections;
    const subject = String(raw.subject || "").trim().slice(0, 60);
    if (subject) entry.subject = subject;
    const date = String(raw.date || "").trim();
    if (/^\d{4}-\d{2}$/.test(date)) entry.date = date;
    if (!validateTestEntry(entry).ok) continue;
    out.push(entry);
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
