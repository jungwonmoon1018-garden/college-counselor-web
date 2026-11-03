// vector-utils.js — the small helpers the activity vectorizer and the
// directionality vectorizer share (text normalizing, the major-bucket match,
// clamping and rounding). Moved out of ec-vectorizer.js on 2026-09-20, which
// re-exports the ones it exported.
// Utilities
export function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// The major bucket a free-text intended major names, or null when it names
// none: blank, "Undecided", or a field no rule knows. Korean names are read
// as well as English ones (the survey takes the major as free text, and
// students type 컴퓨터공학 or 간호학). Hangul has no \b word boundary in a
// JavaScript regex, so the Korean names are plain substrings.
//
// Order is deliberate: MORE-specific buckets before their generic parents
// so "computational biology" doesn't collapse to "biology", and computer
// science before engineering so 컴퓨터공학 is not read as engineering.
export function matchMajorBucketStrict(major) {
  const m = normalizeText(major);
  if (!m) return null;
  if (/computational biology|comp bio|bioinformatic|biostat|genomic|mitochondrial|생물정보|계산생물/.test(m)) return "computational_biology";
  if (/biomedical engineer|bme\b|medical device|의공학|의용공학|바이오메디컬/.test(m)) return "biomedical_engineering";
  if (/materials science|nanotech|metallurgy|polymer|신소재|재료공학/.test(m)) return "materials_science";
  if (/data science|statistic|\banalytics\b|데이터|통계/.test(m)) return "data_science";
  if (/neuroscience|neural|\bbrain\b|cognitive|뇌과학|신경과학|인지과학/.test(m)) return "neuroscience";
  if (/\b(cs|comp sci|computer sci|computer science|software)\b|컴퓨터|소프트웨어|전산|인공지능/.test(m)) return "computer_science";
  if (/engineer|공학|기계|전자|전기/.test(m)) return "engineering";
  if (/nurs|간호/.test(m)) return "nursing";
  if (/bio|pre.?med|생명|생물|의예|의학|의대|약학|치의|수의/.test(m)) return "biology";
  if (/chem|화학/.test(m)) return "chemistry";
  if (/physic|astrophys|물리|천문/.test(m)) return "physics";
  if (/math|수학/.test(m)) return "mathematics";
  if (/econ|경제/.test(m)) return "economics";
  if (/business|finance|entrepreneur|경영|금융|회계|창업/.test(m)) return "business";
  if (/public policy|think tank|nonprofit|정책|행정/.test(m)) return "public_policy";
  if (/international relations|\bir\b|diplomac|foreign policy|geopolitic|국제|외교/.test(m)) return "international_relations";
  if (/pre.?law|\blaw\b|legal studies|paralegal|법학|법대|로스쿨/.test(m)) return "pre_law";
  if (/politic|government|정치/.test(m)) return "political_science";
  if (/history|역사|사학/.test(m)) return "history";
  if (/journalism|reporter|newspaper|언론|저널리즘/.test(m)) return "journalism";
  if (/communicat|\bcomms?\b|public relations|advertis|media studies|미디어|신문방송|광고|홍보|커뮤니케이션/.test(m)) return "communications";
  if (/linguistic|phonolog|언어학/.test(m)) return "linguistics";
  if (/philosoph|ethic|bioethic|철학|윤리/.test(m)) return "philosophy";
  if (/anthropolog|ethnograph|인류학/.test(m)) return "anthropology";
  if (/sociolog|사회학/.test(m)) return "sociology";
  if (/english|literature|writing|영문|국문|문학|문예창작/.test(m)) return "english";
  if (/psych|심리/.test(m)) return "psychology";
  if (/architecture|urban design|건축/.test(m)) return "architecture";
  if (/\bfilm\b|cinematograph|screenplay|영화/.test(m)) return "film";
  if (/\bart\b|fine arts|visual|미술|디자인/.test(m)) return "art";
  if (/music|음악|작곡|성악/.test(m)) return "music";
  if (/theat(er|re)|drama|연극|공연/.test(m)) return "theater";
  if (/environment|climate|sustainab|환경|기후/.test(m)) return "environmental_science";
  if (/public health|epidemiolog|보건/.test(m)) return "public_health";
  if (/education|teaching|pedagog|tutoring|교육/.test(m)) return "education";
  return null;
}

// The bucket with the old default kept for the activity, narrative and
// directionality readers, which ask "which keywords" and cope with any
// bucket. College Fit must not use it: a student with no major, or one
// typed in Korean, was read as a computer-science applicant, which added
// two coursework red flags and turned an in-range school into a Reach
// (fit-1). Fit reads matchMajorBucketStrict instead.
export function matchMajorBucket(major) {
  return matchMajorBucketStrict(major) ?? "computer_science";
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
