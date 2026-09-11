// College value fit scoring — the priorities matrix under the College Fit
// card.
//
// Deterministically compares already sourced college value themes (quoted
// mission-page values, or the admission factors a school declares in section
// C7 of its Common Data Set) with the whole student record. The scorer
// performs no retrieval or model calls; callers supply values with their own
// trusted provenance.
//
// Evidence comes from four places:
//   1. Courses — token overlap plus type hints (AP, IB, honors and dual
//      enrollment speak to rigor).
//   2. Activities — token overlap plus Common App category hints, and the
//      character profile each activity's own description yields (leadership,
//      community and character, talent, sustained commitment, impact, major
//      focus). A "Character / Personal Qualities" priority is evidenced by an
//      activity whose description carries service, mentorship or integrity
//      signals, not by its category alone; the stored strength vector (its
//      tier, prestige and file evidence) sharpens the read when present.
//   3. Academics — GPA, class rank, every test score with its sections, and
//      AP exam results, placed against the school's enrolled class when the
//      College Fit read is supplied (above, inside or below its middle 50%).
//      Before this, a school that declared "Academic GPA" very important
//      showed "no profile match" next to a 3.9.
//   4. Nothing — an essay, recommendations, an interview or family
//      background cannot be read from the profile, and the matrix says so
//      instead of reporting a missing match.
// The output is a structured matrix the frontend renders directly.

import { vectorizeEC } from "./ec-vectorizer.js";
import { projectStrengthToLegacyVector } from "./ec-strength-vectorizer.js";
import { formatClassRank, formatSections, normalizeClassRank, testLabel } from "./test-catalog.js";
import { courseLevel, describeCourseRigor, LEVEL_LABELS, readCourseRigor } from "./course-rigor.js";

// ─── Fit scoring (rule-based, deterministic) ───────────────────────────
// We compute a fit score for each (item, value) pair using:
//   1. Token-overlap signal (cheap baseline, surfaces obvious matches)
//   2. Type signal (e.g. AP/Honors courses align with "intellectual rigor")
//   3. Category signal (e.g. research ECs align with "inquiry")
//   4. Trait signal (an activity's leadership / character / talent read)
//   5. Academic signal (GPA, rank, tests, AP exams against the priority)

// Keyed by the level course-rigor.js reads from a course's type or its
// name, so "AP Calculus BC" left typed regular still speaks to rigor.
const TYPE_VALUE_HINTS = {
  ap:               ["intellectual rigor", "academic depth", "challenge", "intellectual curiosity", "rigor", "advanced placement"],
  ib:               ["interdisciplinary", "global perspective", "international", "intellectual rigor", "rigor"],
  honors:           ["intellectual rigor", "academic depth", "challenge", "rigor"],
  dual_enrollment:  ["college readiness", "academic ambition", "intellectual curiosity", "rigor"],
  a_level:          ["intellectual rigor", "academic depth", "challenge", "rigor", "international"],
};

const TYPE_LABELS = LEVEL_LABELS;

// Per-category value-theme hints. Used by the rule-based fit-scorer to
// boost (theme × category) pairs that have an obvious alignment. The
// LLM strategist sees the raw category + description and reasons more
// holistically; these hints are a cheap baseline for the deterministic
// pre-score the UI renders next to each value.
// Keys are the Common App's 30 activity types (in slug form — see
// frontend's EC_CATEGORIES). Legacy slugs ("club"/"varsity"/"arts"/
// "work") are aliased to their new equivalents for backward compat.
const CATEGORY_VALUE_HINTS = {
  // Common App taxonomy (30 categories)
  academic:                  ["intellectual rigor", "academic ambition", "scholarship", "intellectual curiosity"],
  art:                       ["creativity", "expression", "originality", "aesthetics"],
  athletics_club:            ["teamwork", "discipline", "perseverance", "character"],
  athletics_varsity:         ["leadership", "discipline", "teamwork", "character", "perseverance"],
  career_oriented:           ["real-world", "professionalism", "career readiness", "ambition", "work experience"],
  community_service:         ["service", "civic engagement", "community", "public good", "impact", "volunteer"],
  computer_tech:             ["innovation", "problem solving", "technical depth", "creativity"],
  cultural:                  ["global perspective", "identity", "community", "inclusion", "heritage"],
  dance:                     ["expression", "discipline", "creativity", "performance"],
  debate_speech:             ["critical thinking", "communication", "rigor", "argumentation"],
  environmental:             ["sustainability", "stewardship", "civic engagement", "impact"],
  family_responsibilities:   ["responsibility", "perseverance", "character", "maturity"],
  foreign_exchange:          ["global perspective", "cross-cultural", "adaptability", "open-mindedness"],
  foreign_language:          ["global perspective", "cross-cultural", "scholarship", "open-mindedness"],
  internship:                ["real-world", "professionalism", "career readiness", "ambition", "work experience"],
  journalism:                ["communication", "civic engagement", "rigor", "truth-seeking"],
  jrotc:                     ["leadership", "discipline", "service", "character"],
  lgbt:                      ["inclusion", "identity", "advocacy", "community", "courage"],
  music_instrumental:        ["expression", "discipline", "creativity", "performance"],
  music_vocal:               ["expression", "discipline", "creativity", "performance"],
  religious:                 ["service", "community", "values", "character"],
  research:                  ["inquiry", "intellectual curiosity", "discovery", "scholarship", "rigor"],
  robotics:                  ["problem solving", "innovation", "technical depth", "teamwork", "creativity"],
  school_spirit:             ["community", "leadership", "school engagement"],
  science_math:              ["intellectual curiosity", "scholarship", "rigor", "problem solving"],
  social_justice:            ["civic engagement", "advocacy", "inclusion", "impact", "courage"],
  student_govt:              ["leadership", "civic engagement", "community", "service"],
  theater_drama:             ["expression", "creativity", "collaboration", "performance"],
  work_paid:                 ["responsibility", "perseverance", "character", "real-world", "maturity", "work experience", "employment"],
  other:                     ["initiative"],

  // Legacy aliases (pre-Common-App-expansion slugs) — keep so old
  // profiles still get a non-empty hint set.
  club:    ["initiative", "community", "leadership"],
  varsity: ["leadership", "discipline", "teamwork", "character"],
  arts:    ["creativity", "expression", "originality"],
  work:    ["responsibility", "perseverance", "character", "real-world", "work experience"],
};

// Every activity speaks to a priority about extracurricular involvement as
// such, whatever its category.
const EC_UNIVERSAL_HINTS = ["extracurricular", "activities", "involvement"];

// ─── The character profile an activity yields ─────────────────────────
// The six-factor read of an activity (from its 150-character description,
// merged with the stored strength vector when there is one) maps onto the
// qualities a school names: leadership onto "leadership", community and
// character onto "character / personal qualities", "service" and
// "volunteer", talent and awards onto "talent / ability", and so on. A
// trait counts once it clears the threshold, and a strong one (0.7) reads
// as strong evidence.
const TRAIT_KEYS = [
  "leadership_and_initiative",
  "community_and_character",
  "talents_and_awards",
  "passion_and_consistency",
  "impact_and_scope",
  "relevance_to_intended_major",
];

const TRAIT_VALUE_HINTS = {
  leadership_and_initiative:   ["leadership", "leader", "initiative"],
  community_and_character:     ["character", "personal qualities", "service", "community", "empathy", "integrity", "civic", "volunteer", "kindness", "compassion", "public good", "citizenship", "responsibility"],
  talents_and_awards:          ["talent", "ability", "excellence", "achievement", "award", "distinction", "mastery", "accomplishment"],
  passion_and_consistency:     ["commitment", "perseverance", "dedication", "passion", "persistence", "sustained", "discipline"],
  impact_and_scope:            ["impact", "public good", "contribution", "engagement"],
  relevance_to_intended_major: ["intellectual curiosity", "inquiry", "scholarship", "academic interest", "intellectual"],
};

const TRAIT_LABELS = {
  leadership_and_initiative: "leadership",
  community_and_character: "character",
  talents_and_awards: "talent",
  passion_and_consistency: "commitment",
  impact_and_scope: "impact",
  relevance_to_intended_major: "major_focus",
};

// One service word and one mentoring word in a 150-character description
// read 0.45 on the lexicon, which is a fair claim to character; a single
// mention (0.15) is not.
const TRAIT_THRESHOLD = 0.4;
const TRAIT_STRONG = 0.7;
// The strength vector's community/character value is a proxy (sustained
// dedication, leadership and narrative fit), so on its own it can support a
// fair read but never a strong one; explicit service, mentorship or
// integrity words in the description can.
const PROXY_TRAIT_DAMPING = { community_and_character: 0.6 };

// ─── Academic evidence ────────────────────────────────────────────────
const ACADEMIC_VALUE_HINTS = {
  gpa:   ["gpa", "grade", "academic record", "academic excellence", "academic achievement", "academic performance", "academic success", "scholastic", "academic strength"],
  rank:  ["class rank", "rank in class", "class standing"],
  test:  ["standardized test", "test score", "sat", "act", "testing"],
  ap:    ["advanced placement", "ap exam", "ap score", "college-level", "rigor", "academic depth", "challenge", "intellectual rigor"],
  rigor: ["rigor", "advanced placement", "college-level", "course load", "courseload", "course selection", "curriculum", "academic depth", "challenge", "honors"],
};

// Priorities the profile cannot show. The matrix labels these instead of
// reporting "no match" (an essay is written later; recommendations and an
// interview are other people's reads; family background is not evidence).
const UNREADABLE_THEMES = [
  ["essay",           /\bessay|personal statement|writing sample/i],
  ["recommendations", /\brecommendation/i],
  ["interview",       /\binterview/i],
  ["interest",        /level of (?:applicant'?s? )?interest|demonstrated interest/i],
  ["background",      /first[- ]generation|alumni|legacy|geograph|residen|religio|racial|ethnic/i],
];

const TONE_RANK = { strong: 3, fair: 2, weak: 1, info: 0 };

function tokenize(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
}
function tokenOverlap(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n;
}

// A hint matches at a word start ("rigor" reads "rigorous"); a hint of
// three letters or fewer must stand alone, so "act" never fires inside
// "activities" or "impact" and "sat" never inside "satisfaction".
function hintRe(hint) {
  const h = String(hint || "").toLowerCase().trim();
  const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}${h.length <= 3 ? "\\b" : ""}`, "i");
}
function matchesAnyHint(text, hints) {
  for (const hint of hints || []) if (hintRe(hint).test(text)) return true;
  return false;
}
function valueText(value) {
  return `${value?.theme || ""} ${value?.summary || ""}`;
}

function scoreItemAgainstValue(itemText, hintList, value) {
  const text = valueText(value);
  let score = 0;
  // Token-overlap baseline
  score += tokenOverlap(itemText, text) * 0.3;
  // Hint-based boost
  if (matchesAnyHint(text, hintList)) score += 1.0;
  return score;
}

function readabilityOf(value) {
  const theme = String(value?.theme || "");
  for (const [reason, re] of UNREADABLE_THEMES) if (re.test(theme)) return reason;
  return null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function round1(x) { return Math.round(Number(x || 0) * 10) / 10; }
function round2(x) { return Math.round(Number(x || 0) * 100) / 100; }

function positionTone(position) {
  if (position === "above") return "strong";
  if (position === "within") return "fair";
  if (position === "below") return "weak";
  return null;
}
function betterTone(a, b) {
  return (TONE_RANK[b] ?? -1) > (TONE_RANK[a] ?? -1) ? b : a;
}
function activityTone(character) {
  const tier = character?.tier;
  return tier === "tier_1_distinctive" || tier === "tier_2_strong" ? "strong" : "fair";
}

// GPA, class rank, every test with its sections, and the AP exam results,
// each with the hints that tie it to a priority and, when the College Fit
// read for the school is supplied, its place against the enrolled class.
function academicEvidence(profile, comparison) {
  const items = [];

  // The course load as one line — how many APs were taken (courses, or
  // exams no course names) and how many carry exam scores, with the IB,
  // dual-enrollment, A-Level and honors courses — placed against the load
  // the school's admitted average implies when the College Fit read is
  // supplied. Before this, rigor was evidenced only course by course, and
  // an AP recorded as an exam result alone was not course rigor.
  const rigor = readCourseRigor(profile?.courses, profile?.apScores);
  if (rigor.items.length) {
    const read = comparison?.rigor || null;
    const position = read?.position || null;
    const tone = position ? positionTone(position) : (rigor.units >= 5 ? "strong" : rigor.units >= 2 ? "fair" : "weak");
    // The same units the comparison block shows (both come from
    // course-rigor.js; the College Fit read's copy wins when supplied).
    const detail = { units: read?.units ?? rigor.units, apTaken: rigor.apTaken, apScored: rigor.apScored, expectation: read?.expectation ?? null };
    items.push({ kind: "rigor", hints: ACADEMIC_VALUE_HINTS.rigor, label: `Course rigor: ${describeCourseRigor(rigor)}`, tone, position, detail });
  }

  const gpa = numberOrNull(profile?.gpaUnweighted ?? profile?.gpa?.unweighted);
  const weighted = numberOrNull(profile?.gpaWeighted ?? profile?.gpa?.weighted);
  if (gpa != null || weighted != null) {
    const read = comparison?.gpa || null;
    const position = read?.position && read.position !== "unknown" ? read.position : null;
    const label = gpa != null
      ? `GPA ${gpa}${weighted != null ? ` (${weighted} weighted)` : ""}`
      : `Weighted GPA ${weighted}`;
    const tone = position ? positionTone(position) : ((gpa ?? Math.min(weighted, 4)) >= 3.5 ? "fair" : "weak");
    const detail = read?.average != null ? { average: read.average, weighted: read.averageScale === "weighted" } : null;
    items.push({ kind: "gpa", hints: ACADEMIC_VALUE_HINTS.gpa, label, tone, position, detail });
  }

  const rank = normalizeClassRank(profile?.classRank);
  if (rank) {
    const read = comparison?.classRank || null;
    const shareAbove = numberOrNull(read?.shareAbove);
    const position = shareAbove != null ? (shareAbove <= 10 ? "above" : shareAbove <= 50 ? "within" : "below") : null;
    const tone = position ? positionTone(position) : (rank.topPercent <= 10 ? "strong" : rank.topPercent <= 25 ? "fair" : "weak");
    const detail = read?.school?.topTenthPct != null ? { topTenthPct: read.school.topTenthPct } : null;
    items.push({ kind: "rank", hints: ACADEMIC_VALUE_HINTS.rank, label: `Class rank ${formatClassRank(rank)}`, tone, position, detail });
  }

  for (const entry of Array.isArray(profile?.testScores) ? profile.testScores : []) {
    if (!entry || !entry.test || numberOrNull(entry.totalScore) == null) continue;
    const testKey = String(entry.test).toLowerCase();
    const usedRead = comparison?.tests?.used;
    const used = usedRead && String(usedRead.test || "").toLowerCase() === testKey ? usedRead : null;
    const alternative = used ? null : (comparison?.tests?.alternatives || []).find((a) => String(a?.test || "").toLowerCase() === testKey) || null;
    const read = used || alternative;
    const position = read?.position && read.position !== "unknown" ? read.position : null;
    const sections = formatSections(entry);
    const label = `${testLabel(entry.test)} ${entry.totalScore}${sections ? ` (${sections})` : ""}`;
    const withhold = Boolean(used) && comparison?.tests?.advice === "withhold";
    const tone = withhold ? "weak" : (position ? positionTone(position) : "fair");
    const detail = read?.band?.low != null && read?.band?.high != null ? { band: { low: read.band.low, high: read.band.high } } : null;
    items.push({ kind: "test", hints: ACADEMIC_VALUE_HINTS.test, label, tone, position, detail, advice: withhold ? "withhold" : null });
  }

  const exams = (Array.isArray(profile?.apScores) ? profile.apScores : [])
    .map((a) => ({ name: String(a?.exam || a?.subject || a?.name || "").trim(), score: Number(a?.score) }))
    .filter((a) => a.name && Number.isFinite(a.score) && a.score >= 1 && a.score <= 5);
  if (exams.length) {
    const average = round1(exams.reduce((sum, e) => sum + e.score, 0) / exams.length);
    const names = exams.slice(0, 4).map((e) => `${e.name} ${e.score}`).join(", ") + (exams.length > 4 ? `, +${exams.length - 4} more` : "");
    items.push({ kind: "ap", hints: ACADEMIC_VALUE_HINTS.ap, label: `AP exams: ${names}`, tone: average >= 4 ? "strong" : average >= 3 ? "fair" : "weak", position: null, detail: { average } });
  }

  return items;
}

// The six-factor character read of one activity: the lexicon read of its
// own description, lifted by the stored strength vector's projection when
// the activity has been vectorized (that read also carries file evidence).
function activityCharacter(activity, row, majorInterest) {
  let lexical = null;
  try { lexical = vectorizeEC(activity, majorInterest).vector; } catch { lexical = null; }
  const projected = row
    ? projectStrengthToLegacyVector({
      dedication: row.dedication, achievement: row.achievement, leadership: row.leadership,
      prestige: row.prestige, major_spike: row.major_spike, narrative_fit: row.narrative_fit,
    }).vector
    : null;
  const traits = {};
  for (const key of TRAIT_KEYS) {
    const damping = PROXY_TRAIT_DAMPING[key] ?? 1;
    traits[key] = round2(Math.max(Number(lexical?.[key] || 0), Number(projected?.[key] || 0) * damping));
  }
  return {
    name: activity?.name || "",
    category: activity?.category || null,
    role: activity?.role || null,
    traits,
    tier: row?.tier_label || row?.tierLabel || null,
    prestige: row ? round2(Number(row.prestige || 0)) : null,
  };
}

function rowFactors(row) {
  if (!row) return null;
  if (row.factors && typeof row.factors === "object") {
    return { ...row.factors, tier_label: row.tierLabel || row.tier_label || null, prestige: row.factors.prestige ?? row.prestige };
  }
  return row;
}

/**
 * Score the student's record against a school's values or declared
 * admission priorities.
 *
 * @param {Array} values — [{ theme, summary, ... }]
 * @param {object} profile — assembleProfileForGeneration shape (courses,
 *   activities, gpaUnweighted/gpaWeighted, classRank, testScores, apScores,
 *   majorInterest, goals).
 * @param {object} [options]
 * @param {Array}  [options.strengthRows] — ec_strength_vectors rows (or
 *   their public shape) for this student.
 * @param {object} [options.comparison] — the College Fit read's
 *   profileComparison for this school, when one can be computed.
 * @param {string} [options.majorInterest]
 * @returns {{ values, courses, ecs, academics, characterProfile,
 *   perValueCoverage, overall, readableValues }}
 */
export function computeFit(values, profile, options = {}) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  const majorInterest = options.majorInterest ?? profile?.majorInterest ?? null;
  const rowsByName = new Map();
  for (const row of Array.isArray(options.strengthRows) ? options.strengthRows : []) {
    const name = String(row?.ec_name ?? row?.ecName ?? "").trim().toLowerCase();
    if (name) rowsByName.set(name, rowFactors(row));
  }

  const courses = (profile?.courses || []).map(c => {
    const level = courseLevel(c);
    const itemText = `${c.name || ""} ${c.type || ""}`;
    const hints = TYPE_VALUE_HINTS[level] || [];
    const perValue = list.map(v => ({
      theme: v.theme,
      score: Math.round(scoreItemAgainstValue(itemText, hints, v) * 100) / 100,
    }));
    const rigorous = Boolean(TYPE_VALUE_HINTS[level]);
    const topGrade = /^a/i.test(String(c.grade || "").trim());
    return { name: c.name, type: c.type, level, perValue, tone: rigorous && topGrade ? "strong" : "fair" };
  });

  const activities = (profile?.activities || profile?.ecs || []).map(e => {
    const row = rowsByName.get(String(e?.name || "").trim().toLowerCase()) || null;
    const character = activityCharacter(e, row, majorInterest);
    const itemText = `${e.name || ""} ${e.role || ""} ${e.description || ""}`;
    const hints = [...(CATEGORY_VALUE_HINTS[e.category] || []), ...EC_UNIVERSAL_HINTS];
    const perValue = list.map(v => {
      const base = scoreItemAgainstValue(itemText, hints, v);
      const text = valueText(v);
      const traits = TRAIT_KEYS.filter((key) => character.traits[key] >= TRAIT_THRESHOLD && matchesAnyHint(text, TRAIT_VALUE_HINTS[key]));
      const traitScore = traits.length ? Math.max(...traits.map((key) => character.traits[key])) : 0;
      return {
        theme: v.theme,
        score: Math.round((base + traitScore) * 100) / 100,
        matched: base > 0.5,
        traits,
      };
    });
    return { name: e.name, category: e.category, role: e.role, perValue, character };
  });

  const academics = academicEvidence(profile, options.comparison || null);

  // Per-value coverage: every piece of the record that speaks to the value,
  // strongest first. Hits count evidence that reads as strong or fair; a
  // score below the school's range is listed, but it is not a match.
  const perValueCoverage = list.map((v, i) => {
    const text = valueText(v);
    const evidence = [];
    // Academic reads lead (the course-load line, a score placed against
    // the class), then the courses behind them, then activities; the
    // stable sort by tone keeps that order among equals.
    for (const item of academics) {
      if (!matchesAnyHint(text, item.hints)) continue;
      const { hints: _hints, ...rest } = item;
      evidence.push(rest);
    }
    for (const c of courses) {
      if (c.perValue[i].score > 0.5) {
        evidence.push({ kind: "course", label: `${c.name}${TYPE_LABELS[c.level] ? ` (${TYPE_LABELS[c.level]})` : ""}`, tone: c.tone, position: null });
      }
    }
    for (const a of activities) {
      const p = a.perValue[i];
      if (!p.matched && p.traits.length === 0) continue;
      const traitTone = p.traits.length
        ? (Math.max(...p.traits.map((key) => a.character.traits[key])) >= TRAIT_STRONG ? "strong" : "fair")
        : null;
      const tone = p.matched ? betterTone(activityTone(a.character), traitTone || "info") : traitTone;
      evidence.push({
        kind: "activity",
        label: a.role ? `${a.name} (${a.role})` : `${a.name}`,
        tone,
        position: null,
        traits: p.traits.map((key) => TRAIT_LABELS[key]),
      });
    }
    evidence.sort((x, y) => (TONE_RANK[y.tone] ?? -1) - (TONE_RANK[x.tone] ?? -1));
    const hits = evidence.filter(e => e.tone === "strong" || e.tone === "fair").length;
    const reason = readabilityOf(v);
    return {
      theme: v.theme,
      hits,
      evidence,
      ...(reason ? { unreadable: true, reason } : {}),
    };
  });

  // Overall fit = share of the readable values with at least one match; a
  // priority the profile cannot show does not count against the student.
  const readable = perValueCoverage.filter(p => !p.unreadable);
  const covered = readable.filter(p => p.hits > 0).length;
  const overall = readable.length > 0 ? Math.round((covered / readable.length) * 100) : 0;

  return {
    values: list,
    courses: courses.map(({ name, type, level, perValue }) => ({ name, type, level, perValue })),
    ecs: activities.map(({ name, category, role, perValue }) => ({ name, category, role, perValue })),
    academics: academics.map(({ hints: _hints, ...rest }) => rest),
    characterProfile: activities.map((a) => a.character),
    perValueCoverage,
    overall,
    readableValues: readable.length,
  };
}
