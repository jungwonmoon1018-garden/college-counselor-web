// server/ec-ranking.js — the model-ranked activity candidates and spike ideas,
// the deadline shape, the prestige explanation and the legacy activity-vector
// shape. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (OVERDUE_RESHOW_MONTH, RANK_TIERS, ragStmts).
import { assembleProfileForGeneration } from "./verified-data.js";
import { getSchoolPriorities, schoolPrioritiesPromptBlock } from "./narrative-calendar.js";
import { parseLLMJson, safeParseJSON } from "./model-calls.js";
import { matchMajorBucket as matchMajorBucketFn } from "../activities/ec-vectorizer.js";
import { getPrestigeExplanation } from "../activities/friendly-labels.js";
import { projectStrengthToLegacyVector } from "../activities/ec-strength-vectorizer.js";

let deps;
export function bindEcRanking(serverDeps) { deps = serverDeps; }

export async function llmRankCandidates({ callLLM, modelConfig, studentId, active, candidates, targetSchools }) {
  const profile = assembleProfileForGeneration(studentId) || {};
  const summary = profileSummaryForPrompt(profile, active);
  const priorities = await getSchoolPriorities(targetSchools || []);
  const schoolBlock = schoolPrioritiesPromptBlock(priorities);
  const themes = (active?.themes || []).map((th) => (typeof th === "string" ? th : th?.theme)).filter(Boolean).slice(0, 12).join(", ");
  const list = candidates.slice(0, 25)
    .map((c, i) => `${i + 1}. ${String(c?.name || "").trim()}${c?.description ? ` — ${String(c.description).trim()}` : ""}`)
    .join("\n");
  const prompt = `You are ranking candidate extracurricular IDEAS a student is weighing, by how much each would strengthen THIS student's application.

STUDENT NARRATIVE (the story everything should reinforce):
"${active?.narrativeText || ""}"
Narrative themes: ${themes || "(none yet)"}

STUDENT PROFILE:
${summary}${schoolBlock}

CANDIDATE IDEAS:
${list}

Judge each idea SEMANTICALLY — do NOT rely on literal keyword overlap. Weigh how strongly it reinforces the student's narrative and intended major and how well it fits the target schools' supplied priorities. No browsing is available: never claim external selectivity, prestige, or feasibility unless the supplied context supports it. Never invent facts about the student.

Return ONLY a JSON array, exactly one object per candidate, no prose, no markdown:
[
  {
    "name": "<exact candidate name from the list>",
    "fit": <number 0..1 — how much it strengthens THIS application>,
    "tier": "tier_1_distinctive|tier_2_strong|tier_3_developing|tier_4_foundational",
    "rationale": "<1-2 sentences, specific to this student and their story>",
    "prestigeNote": "<optional one line on real selectivity/prestige if researched>",
    "sources": ["<url you used>", "..."]
  }
]`;
  const resp = await callLLM({
    // Semantic ranking uses the packaged LARGE/reasoning tier. Reasoning
    // models burn output budget on internal thinking before the visible JSON,
    // so allow a generous max_tokens floor.
    model: modelConfig.models?.large || modelConfig.models?.medium,
    max_tokens: 8192,
    system: "You are a precise, honest college admissions analyst. Rank candidate ECs by genuine fit to the student, grounded in real evidence. Output ONLY the requested JSON array.",
    messages: [{ role: "user", content: prompt }],
  });
  const text = (resp?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const parsed = parseLLMJson(text);
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.candidates) ? parsed.candidates : []);
  return arr
    .map((it) => ({
      name: String(it?.name || "").trim(),
      fit: Math.max(0, Math.min(1, Number(it?.fit))),
      tier: deps.RANK_TIERS.includes(it?.tier) ? it.tier : null,
      rationale: String(it?.rationale || "").slice(0, 400),
      prestigeNote: it?.prestigeNote ? String(it.prestigeNote).slice(0, 300) : null,
      sources: Array.isArray(it?.sources) ? it.sources.slice(0, 5).map((u) => String(u).slice(0, 400)) : [],
    }))
    .filter((x) => x.name && Number.isFinite(x.fit));
}

// LLM re-rank for the Spike Finder: decide which existing activities should
// lead the application using the narrative, target-school priorities, and
// supplied factor evidence—not unsupported outside prestige claims.
export async function llmRankSpike({ callLLM, modelConfig, studentId, active, vectors, targetSchools }) {
  const profile = assembleProfileForGeneration(studentId) || {};
  const summary = profileSummaryForPrompt(profile, active);
  const priorities = await getSchoolPriorities(targetSchools || []);
  const schoolBlock = schoolPrioritiesPromptBlock(priorities);
  const list = vectors.slice(0, 25).map((v, i) => {
    const f = v.factors || {};
    return `${i + 1}. ${v.ecName} [tier=${v.tierLabel || "?"}; major_spike=${(f.major_spike ?? 0).toFixed?.(2) ?? f.major_spike}; narrative_fit=${(f.narrative_fit ?? 0).toFixed?.(2) ?? f.narrative_fit}; prestige=${(f.prestige ?? 0).toFixed?.(2) ?? f.prestige}]`;
  }).join("\n");
  const prompt = `Decide which of this student's EXISTING activities should LEAD their application (the 2-3 that define their "spike"), and which are supporting.

STUDENT NARRATIVE:
"${active?.narrativeText || "(none yet)"}"

STUDENT PROFILE:
${summary}${schoolBlock}

ACTIVITIES (with current factor scores):
${list}

Judge holistically: which activities most define a coherent, distinctive story aligned to the intended major and the target schools' supplied priorities. No browsing is available: rely only on the supplied factor evidence and never invent external prestige or achievements.

Return ONLY a JSON array, one object per activity, no prose:
[
  { "name": "<exact activity name>", "lead": <true|false>, "leadScore": <0..1>, "rationale": "<1 sentence why it leads or supports>", "sources": ["<url>"] }
]`;
  const resp = await callLLM({
    // Packaged LARGE/reasoning tier for semantic spike selection. Generous
    // max_tokens for the thinking phase.
    model: modelConfig.models?.large || modelConfig.models?.medium,
    max_tokens: 8192,
    system: "You are a precise college admissions analyst selecting a student's leading activities. Output ONLY the requested JSON array.",
    messages: [{ role: "user", content: prompt }],
  });
  const text = (resp?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const parsed = parseLLMJson(text);
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.activities) ? parsed.activities : []);
  return arr
    .map((it) => ({
      name: String(it?.name || "").trim(),
      lead: Boolean(it?.lead),
      leadScore: Math.max(0, Math.min(1, Number(it?.leadScore))),
      rationale: String(it?.rationale || "").slice(0, 300),
      sources: Array.isArray(it?.sources) ? it.sources.slice(0, 4).map((u) => String(u).slice(0, 400)) : [],
    }))
    .filter((x) => x.name);
}

// Compact deterministic narrative-fit tagger — same model as the candidate
// ranker (bucket hit + theme overlap → predicted tier). Used to annotate
// LLM-generated EC ideas so the student sees how each lands against their
// story without a second LLM call.
export function tagIdeaWithNarrative(text, active) {
  if (!active) return { bucketHit: false, themeHits: 0, predictedNarrativeFit: null, predictedTier: null };
  const combined = String(text || "").toLowerCase();
  const narrativeThemes = (active.themes || [])
    .map((th) => (typeof th === "string" ? th : th?.theme))
    .filter(Boolean)
    .map((th) => String(th).toLowerCase());
  const narrativeBuckets = new Set((active.majorBuckets || []).map(String));
  const candidateBucket = matchMajorBucketFn(combined);
  const bucketHit = Boolean(candidateBucket && narrativeBuckets.has(candidateBucket));
  let themeHits = 0;
  for (const theme of narrativeThemes) {
    if (theme.length < 4) continue;
    if (combined.includes(theme)) themeHits += theme.includes(" ") ? 2 : 1;
  }
  const predictedNarrativeFit = Math.round(Math.min(1, (bucketHit ? 0.5 : 0) + Math.min(0.5, themeHits * 0.08)) * 100) / 100;
  let predictedTier = "tier_4_foundational";
  if (bucketHit && themeHits >= 3) predictedTier = "tier_2_strong";
  else if (bucketHit || themeHits >= 4) predictedTier = "tier_3_developing";
  return { bucketHit, themeHits, predictedNarrativeFit, predictedTier };
}

// Build a compact, PII-light profile summary string for generation prompts.
export function profileSummaryForPrompt(profile, active) {
  const lines = [];
  if (profile.majorInterest) lines.push(`Intended major: ${profile.majorInterest}`);
  if (profile.gpaUnweighted != null) lines.push(`GPA: ${profile.gpaUnweighted}${profile.gpaWeighted != null ? ` (weighted ${profile.gpaWeighted})` : ""}`);
  const tests = (profile.testScores || []).map(t => `${String(t.test || "").toUpperCase()} ${t.totalScore ?? t.total ?? ""}`.trim()).filter(Boolean);
  if (tests.length) lines.push(`Test scores: ${tests.join(", ")}`);
  const aps = (profile.apScores || []).map(a => `${a.name || a.exam || "AP"}${a.score ? ` (${a.score})` : ""}`).filter(Boolean);
  if (aps.length) lines.push(`AP exams: ${aps.slice(0, 12).join(", ")}`);
  const courses = (profile.courses || []).slice(0, 30).map(c => `${c.name || "?"}${c.type ? ` [${c.type}]` : ""}`);
  if (courses.length) lines.push(`Courses (${(profile.courses || []).length}):\n  ${courses.join("\n  ")}`);
  const acts = (profile.activities || []).slice(0, 20).map(a => `${a.name || "?"} (${a.category || "other"}${a.role ? `, ${a.role}` : ""}) — ${(a.description || "").slice(0, 140)}`);
  if (acts.length) lines.push(`Current activities (${(profile.activities || []).length}):\n  ${acts.join("\n  ")}`);
  const goals = (profile.goals || []).map(g => g.school || g.name).filter(Boolean);
  if (goals.length) lines.push(`Target schools: ${goals.slice(0, 12).join(", ")}`);
  if (active?.themes?.length) {
    const themes = active.themes.map(th => (typeof th === "string" ? th : th?.theme)).filter(Boolean);
    if (themes.length) lines.push(`Narrative themes: ${themes.slice(0, 10).join(", ")}`);
  }
  return lines.join("\n");
}

export function shouldCullOverdue(nowMs) {
  return new Date(nowMs ?? Date.now()).getMonth() < deps.OVERDUE_RESHOW_MONTH;
}

export function shapeDeadline(row, nowMs) {
  if (!row) return null;
  const due = row.due_at ? new Date(row.due_at).getTime() : null;
  const n = nowMs || Date.now();
  const daysUntil = due != null ? Math.round((due - n) / 86400000) : null;
  let collegeIds = [];
  try { if (row.college_ids_json) collegeIds = JSON.parse(row.college_ids_json); } catch {}
  return {
    id: row.id,
    title: row.title,
    dueAt: row.due_at,
    category: row.category,
    notes: row.notes,
    status: row.status,
    collegeIds,
    daysUntil,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The prestige explanation for a strength row: the row's own read first
// (computed from this student's name, description, awards and attachment
// text), then the shared by-name cache. The cache is keyed by activity name
// across students, so a "Math Team" read from one student's "AIME
// qualifier" description must never explain another student's "Math Team".
export function prestigeExplanationFor(row, ecName) {
  const reasoning = row ? safeParseJSON(row.reasoning_json, null)?.prestige : null;
  if (reasoning && (reasoning.rationale || reasoning.catalogMatch)) {
    return {
      score: row.prestige ?? reasoning.score ?? 0,
      source: row.prestige_source || reasoning.source || "unavailable",
      rationale: reasoning.rationale || null,
      sourcesCited: Array.isArray(reasoning.sourcesCited) ? reasoning.sourcesCited : [],
      catalogMatch: reasoning.catalogMatch || null,
      matchedIn: reasoning.matchedIn || null,
      level: reasoning.level || null,
      nextLevel: reasoning.nextLevel || null,
      provider: null,
      model: null,
      fetchedAt: row.updated_at || row.computed_at || null,
    };
  }
  return getPrestigeExplanation(deps.ragStmts, ecName);
}

export function shapeLegacyECVectorFromStrengthRow(row) {
  if (!row) return null;
  const projected = projectStrengthToLegacyVector({
    dedication: row.dedication,
    achievement: row.achievement,
    leadership: row.leadership,
    prestige: row.prestige,
    major_spike: row.major_spike,
    narrative_fit: row.narrative_fit,
  });
  return {
    id: row.id,
    ecName: row.ec_name,
    description: row.description,
    majorContext: null,
    vector: projected.vector,
    composite: projected.composite,
    label: projected.label,
    hoursPerWeek: row.hours_per_week,
    weeksPerYear: row.weeks_per_year,
    yearsActive: row.years_active,
    reasoning: safeParseJSON(row.reasoning_json, {}),
    isOverridden: Boolean(row.is_overridden),
    computedAt: row.computed_at,
    updatedAt: row.updated_at,
    sourceSystem: "ec_strength_vectors",
  };
}
