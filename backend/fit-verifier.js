// ═══════════════════════════════════════════════════════════════════════
// FIT VERIFIER — the College Fit double-check.
// ═══════════════════════════════════════════════════════════════════════
// A College Fit read is computed from stored data (Common Data Set store,
// IPEDS baseline, a cached Scorecard row). This module re-checks the numbers
// and policies that read depended on against the live web, in three
// independent ways, and says whether the read still stands:
//
//   1. College Scorecard API (live IPEDS) — admit rate, SAT/ACT ranges.
//   2. The school's own admissions pages, read deterministically by the
//      policy scout — test policy, plan deadlines, fee.
//   3. The same official pages read by the medium-tier model as a second,
//      independent reader; its test-policy claim only counts when the quote
//      it cites appears verbatim in the fetched text.
//
// Every check records what the fit used, what the live source says, and a
// status (consistent / differs / unavailable / info). When a live value
// differs, the fit is re-scored with the live inputs so the student sees
// whether the label would move. Pure orchestration: the caller injects the
// Scorecard lookup, the page reader, the model, and the re-scorer.

import { verifyQuote } from "./college-research.js";

export const FIT_VERIFY_TTL_DAYS = 1;
const MAX_MODEL_PAGE_CHARS = 9_000;

const TOLERANCE = Object.freeze({
  admitRatePoints: 1.0,  // percentage points
  admitRateRelative: 0.2,
  satPoints: 40,
  actPoints: 2,
});

export function normalizeTestPolicyBucket(value) {
  const v = String(value || "").toLowerCase();
  if (!v) return null;
  if (/optional|blind|deemphas|de-emphas|flexible|free/.test(v)) return "test_optional_or_deemphasized";
  if (/required|considered/.test(v)) return "test_considered_or_required";
  return null;
}

export function describeTestPolicyBucket(bucket) {
  if (bucket === "test_optional_or_deemphasized") return "test-optional / de-emphasized";
  if (bucket === "test_considered_or_required") return "tests considered or required";
  return "unknown";
}

function closeEnough(a, b, tolerance) {
  if (a == null || b == null) return null;
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function rangeText(low, high) {
  if (low == null && high == null) return null;
  return low != null && high != null ? `${low}–${high}` : String(low ?? high);
}

function titleCase(text) {
  return String(text || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Deterministic comparisons ─────────────────────────────────────────
// `used` is what the fit computed with: { acceptanceRate (percent), sat25,
// sat75, act25, act75, testPolicy (bucket), source, cdsYear }. `scorecard`
// is a live Scorecard row (percent admit rate). `policy` is the scout's live
// policy object; `modelPolicy` the model's quote-verified read.
export function compareFitInputs({ used = {}, scorecard = null, policy = null, modelPolicy = null, policyFailure = null } = {}) {
  const checks = [];
  const usedSource = used.source || "stored data";
  const scorecardLabel = "College Scorecard (live IPEDS)";

  {
    const live = scorecard?.acceptanceRate ?? null;
    const within = closeEnough(used.acceptanceRate, live, TOLERANCE.admitRatePoints)
      || (used.acceptanceRate != null && live != null
        && Math.abs(used.acceptanceRate - live) / Math.max(live, 0.1) <= TOLERANCE.admitRateRelative);
    checks.push({
      field: "acceptance_rate",
      label: "Admit rate",
      used: used.acceptanceRate != null ? `${used.acceptanceRate}%` : null,
      usedSource,
      live: live != null ? `${live}%` : null,
      liveSource: live != null ? scorecardLabel : null,
      status: used.acceptanceRate == null || live == null ? "unavailable" : (within ? "consistent" : "differs"),
    });
  }
  {
    const usedRange = rangeText(used.sat25, used.sat75);
    const liveRange = rangeText(scorecard?.sat25, scorecard?.sat75);
    const ok = closeEnough(used.sat25, scorecard?.sat25, TOLERANCE.satPoints)
      && closeEnough(used.sat75, scorecard?.sat75, TOLERANCE.satPoints);
    checks.push({
      field: "sat_range",
      label: "SAT middle 50%",
      used: usedRange,
      usedSource,
      live: liveRange,
      liveSource: liveRange ? scorecardLabel : null,
      status: !usedRange || !liveRange ? "unavailable" : (ok ? "consistent" : "differs"),
    });
  }
  {
    const usedRange = rangeText(used.act25, used.act75);
    const liveRange = rangeText(scorecard?.act25, scorecard?.act75);
    const ok = closeEnough(used.act25, scorecard?.act25, TOLERANCE.actPoints)
      && closeEnough(used.act75, scorecard?.act75, TOLERANCE.actPoints);
    checks.push({
      field: "act_range",
      label: "ACT middle 50%",
      used: usedRange,
      usedSource,
      live: liveRange,
      liveSource: liveRange ? scorecardLabel : null,
      status: !usedRange || !liveRange ? "unavailable" : (ok ? "consistent" : "differs"),
    });
  }
  // Test policy — two independent readers of the official pages. Two that
  // agree (or a single reader) give the live value; two that disagree are
  // reported as inconclusive rather than picking a side.
  {
    const usedBucket = normalizeTestPolicyBucket(used.testPolicy);
    const scoutBucket = normalizeTestPolicyBucket(policy?.testPolicy?.value);
    const modelBucket = modelPolicy?.quoteVerified ? normalizeTestPolicyBucket(modelPolicy.value) : null;
    const readers = [];
    if (scoutBucket) readers.push({ reader: "official-site parser", bucket: scoutBucket, evidence: policy.testPolicy.evidence, sourceUrl: policy.testPolicy.sourceUrl });
    if (modelBucket) readers.push({ reader: "model (quote verified)", bucket: modelBucket, evidence: modelPolicy.evidence, sourceUrl: modelPolicy.sourceUrl });
    const agreed = readers.length === 2 ? readers[0].bucket === readers[1].bucket : null;
    const liveBucket = readers.length === 0 ? null : (agreed === false ? null : readers[0].bucket);
    const liveEvidence = readers[0] || null;
    let status;
    if (agreed === false) status = "inconclusive";
    else if (!liveBucket) status = "unavailable";
    else if (!usedBucket) status = "info";
    else status = usedBucket === liveBucket ? "consistent" : "differs";
    checks.push({
      field: "test_policy",
      label: "Testing policy",
      used: usedBucket ? describeTestPolicyBucket(usedBucket) : null,
      usedSource: used.testPolicySource || usedSource,
      live: liveBucket
        ? describeTestPolicyBucket(liveBucket)
        : (readers.length ? readers.map((r) => `${r.reader}: ${describeTestPolicyBucket(r.bucket)}`).join(" vs ") : null),
      liveSource: liveEvidence?.sourceUrl || null,
      evidence: liveEvidence?.evidence || null,
      readers: readers.map((r) => ({ reader: r.reader, value: describeTestPolicyBucket(r.bucket) })),
      status,
      liveBucket,
      officialSiteStatus: policyFailure || "read",
    });
  }
  // Deadlines and the fee are informational — the fit doesn't score them,
  // but a student reading a fit label should see the current dates.
  for (const [plan, entry] of Object.entries(policy?.deadlines || {})) {
    if (!entry?.date) continue;
    checks.push({
      field: `deadline_${plan}`,
      label: `${titleCase(plan)} deadline`,
      used: null,
      usedSource: null,
      live: entry.date,
      liveSource: entry.sourceUrl,
      evidence: entry.evidence,
      status: "info",
    });
  }
  if (policy?.applicationFee?.amount != null) {
    checks.push({
      field: "application_fee",
      label: "Application fee",
      used: null,
      usedSource: null,
      live: `${policy.applicationFee.amount} USD`,
      liveSource: policy.applicationFee.sourceUrl,
      status: "info",
    });
  }
  return checks;
}

export function verdictFromChecks(checks) {
  const scored = checks.filter((c) => ["consistent", "differs", "inconclusive"].includes(c.status));
  if (!scored.length) return "unverifiable";
  if (scored.some((c) => c.status === "differs")) return "discrepancies_found";
  if (scored.some((c) => c.status === "inconclusive")) return "inconclusive";
  return "consistent";
}

// Live inputs for a re-score: the official site wins for policy; for the
// numbers, a validated CDS as new as Scorecard's data year stays, otherwise
// the live Scorecard row wins.
export function liveInputsFor({ used = {}, scorecard = null, checks = [], scorecardDataYear = 2024 } = {}) {
  const next = { ...used };
  const changed = [];
  const cdsFresh = used.source === "cds_store" && Number(used.cdsYear) >= scorecardDataYear;
  const differs = (field) => checks.find((c) => c.field === field)?.status === "differs";
  if (scorecard && !cdsFresh) {
    if (differs("acceptance_rate") && scorecard.acceptanceRate != null) { next.acceptanceRate = scorecard.acceptanceRate; changed.push("acceptance_rate"); }
    if (differs("sat_range") && scorecard.sat25 != null) { next.sat25 = scorecard.sat25; next.sat75 = scorecard.sat75; changed.push("sat_range"); }
    if (differs("act_range") && scorecard.act25 != null) { next.act25 = scorecard.act25; next.act75 = scorecard.act75; changed.push("act_range"); }
  }
  const policyCheck = checks.find((c) => c.field === "test_policy");
  if (policyCheck && (policyCheck.status === "differs" || policyCheck.status === "info") && policyCheck.liveBucket) {
    next.testPolicy = policyCheck.liveBucket;
    changed.push("test_policy");
  }
  return { inputs: next, changed };
}

// ─── The model as a second reader ──────────────────────────────────────
export function buildReviewMessages({ school, used = {}, pages = [] }) {
  const system = [
    "You double-check a college-admissions fit calculation against the school's OWN admissions pages. Reply with ONLY valid JSON, no markdown fences.",
    'Schema: {"testPolicy": {"value": "test_optional"|"test_required"|"test_blind"|"unknown", "evidence": "<EXACT quote of at most 25 words copied verbatim from the page text>", "sourceUrl": "<PAGE url the quote came from>"}, "notes": ["<a policy detail from the pages that changes how a first-year applicant should read this fit: a major-specific test requirement, a plan that no longer exists, a changed deadline>"], "summary": "<two plain sentences for a 16-18 year old>"}',
    "Rules:",
    "- Read only what the pages say about FIRST-YEAR admission for the upcoming cycle. If the pages don't state a test policy, use \"unknown\" and an empty evidence string.",
    "- \"evidence\" must be copied character-for-character from the page text; never paraphrase inside it.",
    "- Never invent statistics. Do not restate the numbers you were given unless a page contradicts them, in which case say so in notes with a quote.",
    "- At most 4 notes. No advice, no predictions.",
  ].join("\n");
  const policyText = used.testPolicy ? describeTestPolicyBucket(normalizeTestPolicyBucket(used.testPolicy)) : "unknown";
  const usedLines = [
    `School: ${school}`,
    `Numbers the fit used: admit rate ${used.acceptanceRate != null ? `${used.acceptanceRate}%` : "unknown"}; SAT middle 50% ${rangeText(used.sat25, used.sat75) || "unknown"}; ACT middle 50% ${rangeText(used.act25, used.act75) || "unknown"}; test policy assumed: ${policyText} (source: ${used.source || "stored data"}).`,
  ];
  let budget = MAX_MODEL_PAGE_CHARS;
  const serialized = [];
  for (const page of pages) {
    if (budget <= 0) break;
    const text = String(page.text || "").slice(0, Math.min(budget, 4_000));
    budget -= text.length;
    serialized.push(`PAGE — ${page.url}\n${text}`);
  }
  return { system, user: `${usedLines.join("\n")}\n\nOFFICIAL PAGES:\n\n${serialized.join("\n\n────────\n\n")}` };
}

function parseJsonLoose(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

// A reply that isn't strict JSON (a quote with an unescaped double quote
// inside the evidence string is the usual culprit) is read field by field
// instead of being thrown away; a reply with nothing recoverable is reported
// as unparseable so the gap is visible rather than silent.
function extractReviewFields(text) {
  const src = String(text || "");
  const str = (key) => {
    const m = src.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    return m ? m[1].replace(/\\"/g, "\"").replace(/\\n/g, " ").trim() : "";
  };
  const value = (src.match(/"value"\s*:\s*"(test_optional|test_required|test_blind|unknown)"/i) || [])[1] || "";
  const notesBlock = (src.match(/"notes"\s*:\s*\[([\s\S]*?)\]/) || [])[1] || "";
  const notes = [...notesBlock.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => m[1].trim());
  if (!value && !notes.length && !str("summary")) return null;
  return { testPolicy: { value, evidence: str("evidence"), sourceUrl: str("sourceUrl") }, notes, summary: str("summary") };
}

export function parseReviewReply(text, pages = []) {
  const body = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const parsed = parseJsonLoose(body) || extractReviewFields(body);
  if (!parsed || typeof parsed !== "object") {
    return { status: "unparseable", excerpt: body.slice(0, 160) };
  }
  const value = String(parsed.testPolicy?.value || "unknown").toLowerCase();
  const evidence = String(parsed.testPolicy?.evidence || "").trim();
  const verifiedUrl = evidence ? verifyQuote(evidence, pages) : null;
  return {
    status: "ok",
    testPolicy: {
      value: ["test_optional", "test_required", "test_blind"].includes(value) ? value : "unknown",
      evidence: verifiedUrl ? evidence.slice(0, 300) : null,
      sourceUrl: verifiedUrl || null,
      quoteVerified: Boolean(verifiedUrl),
    },
    notes: (Array.isArray(parsed.notes) ? parsed.notes : [])
      .map((n) => String(n || "").trim()).filter(Boolean).slice(0, 4).map((n) => n.slice(0, 300)),
    summary: String(parsed.summary || "").trim().slice(0, 600),
  };
}

// ─── Orchestration ─────────────────────────────────────────────────────
export async function verifyCollegeFit({
  school,                 // { name, unitId, homepage }
  used = {},              // inputs the fit computed with (see compareFitInputs)
  lookupScorecard,        // async ({ name, unitId }) → normalized Scorecard row | null
  readPolicy,             // async (target) → { site, pages, policy, failure }
  callLLM = null,         // async ({ system, messages, ... }) → model result
  model = undefined,
  rescore = null,         // (liveInputs) → { finalPositioningScore, overallPositioningLabel }
  original = null,        // { finalPositioningScore, overallPositioningLabel }
  now = new Date(),
} = {}) {
  const sources = [];
  let scorecard = null;
  try {
    scorecard = (await lookupScorecard?.({ name: school.name, unitId: school.unitId })) || null;
    if (scorecard) sources.push({ kind: "college_scorecard", label: "College Scorecard (live IPEDS)", url: "https://collegescorecard.ed.gov/" });
  } catch { scorecard = null; }

  let live = { pages: [], policy: null, failure: "not_attempted" };
  try {
    live = (await readPolicy?.({ name: school.name, unitId: school.unitId, website: school.homepage || null })) || live;
  } catch (err) {
    live = { pages: [], policy: null, failure: err?.message || "read_failed" };
  }
  if (live.pages?.length) {
    sources.push({ kind: "official_site", label: "Official admissions pages", urls: live.pages.map((p) => p.url) });
  }

  let modelReview = null;
  if (callLLM && live.pages?.length) {
    try {
      const { system, user } = buildReviewMessages({ school: school.name, used, pages: live.pages });
      const result = await callLLM({ model, max_tokens: 700, temperature: 0, system, messages: [{ role: "user", content: user }] });
      const text = Array.isArray(result?.content)
        ? result.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("")
        : String(result?.text || "");
      modelReview = parseReviewReply(text, live.pages);
    } catch (err) {
      modelReview = { status: "failed", error: String(err?.message || "").slice(0, 120) };
      sources.push({ kind: "model_review", label: "Model review unavailable", error: modelReview.error });
    }
  }

  const checks = compareFitInputs({
    used,
    scorecard,
    policy: live.policy,
    modelPolicy: modelReview?.status === "ok" ? modelReview.testPolicy : null,
    policyFailure: live.failure,
  });
  const verdict = verdictFromChecks(checks);
  const { inputs: liveInputs, changed } = liveInputsFor({ used, scorecard, checks });
  let recomputed = null;
  if (rescore && changed.length) {
    try {
      const next = rescore(liveInputs);
      recomputed = {
        changedInputs: changed,
        finalPositioningScore: next?.finalPositioningScore ?? null,
        overallPositioningLabel: next?.overallPositioningLabel ?? null,
        labelChanged: Boolean(original?.overallPositioningLabel && next?.overallPositioningLabel
          && original.overallPositioningLabel !== next.overallPositioningLabel),
      };
    } catch { recomputed = null; }
  }

  return {
    school: school.name,
    checkedAt: now.toISOString(),
    verdict,
    checks,
    sources,
    officialSite: live.failure ? { status: live.failure } : { status: "read", pages: live.pages.length },
    modelReview: !modelReview
      ? null
      : modelReview.status === "ok"
        ? { status: "ok", summary: modelReview.summary, notes: modelReview.notes, testPolicy: modelReview.testPolicy }
        : modelReview,
    recomputed,
    original: original
      ? { finalPositioningScore: original.finalPositioningScore ?? null, overallPositioningLabel: original.overallPositioningLabel ?? null }
      : null,
  };
}

// One line for the chat's VERIFIED DATA block.
export function formatVerificationLine(verification) {
  if (!verification) return "";
  const date = String(verification.checkedAt || "").slice(0, 10);
  const label = {
    consistent: "consistent with live sources",
    discrepancies_found: "live sources differ from the stored data",
    inconclusive: "official pages were inconclusive on test policy",
    unverifiable: "could not be checked against live sources",
  }[verification.verdict] || verification.verdict;
  const differing = (verification.checks || [])
    .filter((c) => c.status === "differs")
    .map((c) => `${c.label}: fit used ${c.used}, live ${c.live}`);
  const moved = verification.recomputed?.labelChanged
    ? `; with live inputs the read moves to ${verification.recomputed.overallPositioningLabel}`
    : "";
  return `College Fit double-check (${date}): ${label}${differing.length ? ` — ${differing.join("; ")}` : ""}${moved}`;
}
