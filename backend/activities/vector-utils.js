// vector-utils.js — the small helpers the activity vectorizer and the
// directionality vectorizer share (text normalizing, the major-bucket match,
// clamping and rounding). Moved out of ec-vectorizer.js on 2026-09-20, which
// re-exports the ones it exported.
// Utilities
export function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function matchMajorBucket(major) {
  const m = normalizeText(major);
  // Order is deliberate: MORE-specific buckets before their generic parents
  // so "computational biology" doesn't collapse to "biology".
  if (/computational biology|comp bio|bioinformatic|biostat|genomic|mitochondrial/.test(m)) return "computational_biology";
  if (/biomedical engineer|bme\b|medical device/.test(m)) return "biomedical_engineering";
  if (/materials science|nanotech|metallurgy|polymer/.test(m)) return "materials_science";
  if (/data science|statistic|\banalytics\b/.test(m)) return "data_science";
  if (/neuroscience|neural|\bbrain\b|cognitive/.test(m)) return "neuroscience";
  if (/\b(cs|comp sci|computer sci|computer science|software)\b/.test(m)) return "computer_science";
  if (/engineer/.test(m)) return "engineering";
  if (/bio|pre.?med/.test(m)) return "biology";
  if (/chem/.test(m)) return "chemistry";
  if (/physic|astrophys/.test(m)) return "physics";
  if (/math/.test(m)) return "mathematics";
  if (/econ/.test(m)) return "economics";
  if (/business|finance|entrepreneur/.test(m)) return "business";
  if (/public policy|think tank|nonprofit/.test(m)) return "public_policy";
  if (/international relations|ir\b|diplomac|foreign policy|geopolitic/.test(m)) return "international_relations";
  if (/politic|government/.test(m)) return "political_science";
  if (/history/.test(m)) return "history";
  if (/journalism|reporter|newspaper/.test(m)) return "journalism";
  if (/linguistic|phonolog/.test(m)) return "linguistics";
  if (/philosoph|ethic|bioethic/.test(m)) return "philosophy";
  if (/anthropolog|ethnograph/.test(m)) return "anthropology";
  if (/english|literature|writing/.test(m)) return "english";
  if (/psych/.test(m)) return "psychology";
  if (/architecture|urban design/.test(m)) return "architecture";
  if (/\bfilm\b|cinematograph|screenplay/.test(m)) return "film";
  if (/\bart\b|fine arts|visual/.test(m)) return "art";
  if (/music/.test(m)) return "music";
  if (/theat(er|re)|drama/.test(m)) return "theater";
  if (/environment|climate|sustainab/.test(m)) return "environmental_science";
  if (/public health|epidemiolog/.test(m)) return "public_health";
  if (/education|teaching|pedagog|tutoring/.test(m)) return "education";
  return "computer_science"; // sensible neutral default
}

export function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function round2(x) {
  return Math.round((x || 0) * 100) / 100;
}

export function safeArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}
