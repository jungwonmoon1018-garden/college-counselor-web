// ═══════════════════════════════════════════════════════════════════════
// POLICY ROUTER — Deterministic topic classification and compliance gates
// ═══════════════════════════════════════════════════════════════════════
// This module is the first layer in the request pipeline. It classifies
// every incoming query into a topic type, determines source constraints,
// selects the appropriate model tier, and enforces compliance gates.
//
// IMPORTANT: This module is 100% deterministic — no LLM calls.
// ═══════════════════════════════════════════════════════════════════════

import { llmDebug } from "./llm-adapters/llm-log.js";

// ─── Topic Type Definitions ───
// regulated:     FAFSA, FERPA, eligibility, legal, compliance
// high_stakes:   Deadlines, school policies, financial aid amounts, scholarship eligibility
// coaching:      EC strategy, essay brainstorming, activity suggestions, college list building
// administrative: Profile updates, data export, account management
// crisis:        Self-harm, abuse, emergency
export const TOPIC_TYPES = {
  REGULATED: "regulated",
  HIGH_STAKES: "high_stakes",
  COACHING: "coaching",
  ADMINISTRATIVE: "administrative",
  CRISIS: "crisis",
};

// ─── Model Tiers ───
// The tier enum keeps the HAIKU / SONNET / OPUS names for backward
// compatibility (existing call sites across orchestration-engine,
// ec-strength-vectorizer, and ap-concept-vectorizer reference them
// directly). The SMALL / MEDIUM / LARGE aliases point at the same
// values — new code should prefer the provider-agnostic names.
//   small  = routing, extraction, classification, moderation, OCR validation
//   medium = source-grounded coaching, synthesis, trend analysis
//   large  = complex synthesis, conflict resolution, essay critique
export const MODEL_TIERS = {
  NONE: "none",
  HAIKU: "haiku",
  SONNET: "sonnet",
  OPUS: "opus",
  // Provider-agnostic aliases — mapped 1:1 to the names above.
  SMALL: "haiku",
  MEDIUM: "sonnet",
  LARGE: "opus",
  // Strategy Council (Pillar 9). Dispatched to council.convene() instead
  // of callLLM. Council execution is explicit and sequential.
  COUNCIL: "council",
};

// Subintents that should convene the 5-seat Strategy Council instead of
// hitting a single model. Per the Pillar 9 design these are the truly
// high-stakes strategic decisions — everything else stays on the single-
// model tier ladder.
export const STRATEGY_COUNCIL_SUBINTENTS = new Set([
  "ec_strategy",
  "essay",
  "college_list",
  "strategy",
  "course_planning", // "what courses/APs should I take next year" — high-stakes
]);

// ─── Escalation threshold: Sonnet must report confidence below this to escalate to Opus ───
const OPUS_ESCALATION_THRESHOLD = 0.45;

// ─── Keyword patterns for topic classification ───
const PATTERNS = {
  // Deterministic crisis triggers are STATEMENTS ABOUT THE STUDENT'S OWN
  // SAFETY, not topic words. The earlier lexicon fired on bare "abuse",
  // "emergency", "danger", "threatened" and on "end my …" — so "how do I end
  // my essay?" and "I volunteer in the emergency room" got the crisis
  // hotlines instead of an answer. Ordinary stress ("I'm hopeless at
  // chemistry", "overwhelmed") is not a crisis: the client adds a supportive
  // footer for that without blocking the answer.
  crisis: [
    // Self-harm / suicidal ideation, first person.
    /\b(?:suicid\w*|kill(?:ing)?\s+myself|self[- ]?harm(?:ing)?|(?:want|wanted|wanting|going|ready)\s+to\s+die|wanna\s+die|end(?:ing)?\s+my\s+(?:own\s+)?life|end\s+it\s+all|take\s+my\s+(?:own\s+)?life|hurt(?:ing)?\s+myself|cut(?:ting)?\s+myself|don'?t\s+want\s+to\s+(?:live|be\s+alive|wake\s+up|exist|be\s+here)|no\s+reason\s+to\s+(?:live|go\s+on)|better\s+off\s+dead|not\s+worth\s+living|wish\s+i\s+(?:was|were)\s+dead|overdos(?:e|ing))\b/i,
    // Abuse, assault, grooming — the student says it is happening to them.
    /\b(?:(?:my|our)\s+(?:dad|father|mom|mother|parents?|step(?:dad|mom|father|mother)|coach|teacher|tutor|boyfriend|girlfriend|partner|uncle|aunt|brother|sister|cousin|guardian|relative)\s+(?:hits?|beats?|abuses?|touch(?:es|ed)|molest(?:s|ed)?|assault(?:s|ed)?|hurts?|chokes?|threatens?)\s+me|i(?:'m| am| was| have been| get| got)\s+(?:being\s+)?(?:physically|sexually|emotionally|verbally)?\s*(?:abused|molested|assaulted|raped|groomed|beaten)|(?:he|she|they|someone|an?\s+adult)\s+(?:is\s+|are\s+)?(?:hits?|beats?|abuses?|touch(?:es|ed)|molest(?:s|ed)|grooming|groomed|raped?|assaulted)\s+me|domestic\s+violence\s+(?:at|in)\s+(?:my\s+)?home)\b/i,
    // Immediate danger — the student says they are not safe right now.
    /\b(?:i(?:'m| am)\s+(?:in\s+danger|not\s+safe|unsafe|scared\s+(?:for\s+my\s+life|to\s+go\s+home))|(?:someone|he|she|they)\s+(?:is\s+|are\s+)?threaten(?:s|ing|ed)\s+(?:to\s+(?:hurt|kill)\s+)?me|(?:it'?s|this\s+is)\s+an\s+emergency|i\s+don'?t\s+feel\s+safe\s+(?:at\s+home|at\s+school|anywhere|here))\b/i,
    // Korean (a first-class locale here, with Korean crisis hotlines). No \b —
    // word boundaries behave poorly for CJK; match the lexemes directly.
    /(자살|자해|죽고\s*싶|죽고싶|목숨을\s*끊|극단적\s*선택|살기\s*싫|죽어\s*버리고\s*싶)/,
    /(학대|성추행|성폭행|폭행|가정폭력)(?:을|를)?\s*(?:당하|당했|당하고|받고|받았|겪|겪고)/,
    /(위험에\s*처|안전하지\s*않|저는\s*위험해)/,
  ],
  regulated: {
    fafsa: /\bfafsa\b|\bstudent\s*aid\s*index\b|\bsai\b|\befc\b|\bexpected\s*family\s*contribution\b|\bfederal\s*student\s*aid\b|\bstudentaid\.gov\b|\bfsa\s*id\b|\bcontributor\b.*\bfafsa\b/i,
    // "school records" alone is how students describe their transcript; the
    // regulated sense needs a rights / access / disclosure word nearby.
    ferpa: /\bferpa\b|\bfamily\s*educational\s*rights\b|\bstudent\s*privacy\b|\b(?:education|school)\s+records?\b[^.?!]{0,60}\b(?:rights?|access|privacy|amend\w*|disclos\w*|release\w*|consent|request\w*|see|view)\b|\b(?:rights?|access|privacy|amend\w*|disclos\w*|release\w*|consent|request\w*)\b[^.?!]{0,60}\b(?:education|school)\s+records?\b/i,
    financial_aid_policy: /\bneed[- ]blind\b|\bneed[- ]aware\b|\bcss\s*profile\b|\binstitutional\s*aid\b|\binstitutional\s*methodology\b|\bfinancial\s*aid\s*policy\b/i,
    // Federal-aid eligibility only. "Am I eligible for Princeton" and
    // scholarship qualification questions are coaching.
    eligibility: /\b(?:am\s+i|are\s+we|is\s+my\s+\w+|do\s+i|would\s+i|will\s+i|can\s+i)\s+(?:be\s+|still\s+)?(?:eligible|qualify|qualified)\b[^.?!]{0,60}\b(?:fafsa|federal|financial\s+aid|student\s+aid|pell|loans?|grants?|work[- ]study|aid)\b|\b(?:fafsa|federal\s+(?:student\s+)?aid|pell|financial\s+aid|student\s+aid)\b[^.?!]{0,40}\b(?:eligib\w*|qualif\w*)\b|\bcitizenship\s+requirement\b|\bselective\s+service\b/i,
    // Bare "legal" ("legal studies", "paralegal") is not a compliance question.
    legal_compliance: /\blegal\s+(?:rights?|requirements?|obligations?|status|issues?|questions?)\b|\bcompliance\b|\bregulations?\b|\b(?:federal|state)\s+law\b|\btitle\s+ix\b|\bada\s+accommodations?\b/i,
  },
  high_stakes: {
    // "Early decision" on its own is a strategy topic ("should I apply
    // ED?"); it counts here only next to a date word.
    deadlines: /\bdeadlines?\b|\bdue\s+dates?\b|\bwhen\s+(?:is|are|do|does|did|will)\b[^.?!]{0,60}\b(?:due|deadline|close|open|apply\s+by)\b|\bpriority\s+deadline\b|\bapplications?\s+(?:closes?|opens?)\b|\brolling\s+admissions?\b/i,
    // Money questions, not every "how much" or "scholarship" mention.
    financial_amounts: /\bhow\s+much\b[^.?!]{0,50}\b(?:costs?|tuition|pay|aid|money|loans?|scholarships?|price|afford\w*|owe|borrow|expensive)\b|\b(?:tuition|net\s+price|sticker\s+price|cost\s+of\s+attendance|room\s+and\s+board|afford\w*)\b|\b(?:pell|merit\s+aid|financial\s+aid|need[- ]based\s+aid|student\s+loans?|federal\s+loans?|work[- ]study|stipends?)\b|\b(?:scholarships?|grants?|loans?)\b[^.?!]{0,40}(?:\b(?:amount|worth|how\s+much|dollars?|cover|pays?|full[- ]ride|full\s+tuition|money)\b|\$)|\$\s?\d/i,
    school_policies: /\btest[- ]optional\b|\btest[- ]required\b|\bsuperscore\b|\bscore\s*choice\b|\bapplication\s*requirement\b|\brequired\s*document\b/i,
    official_stats: /\bacceptance\s*rate\b|\badmission\s*rate\b|\bclass\s*profile\b|\bmiddle\s*50\b|\b(25th|75th)\s*percentile\b/i,
  },
  coaching: {
    ec_strategy: /\bextracurricular(s)?\b|\becs?\b|\bactivit(y|ies)\b|\bspike\b|\bhook\b|\bsummer\s*(program|activit|plan)\b|\bleadership\b|\bvolunteer\b|\binternship\b|\bresearch\b/i,
    essay: /\bessay\b|\bnarrative\b|\bpersonal\s*statement\b|\bsupplement\b|\bcommon\s*app\s*essay\b|\bwriting\b.*\b(help|review|feedback)\b/i,
    college_list: /\bcollege\s*list\b|\bschool\s*list\b|\breach\b|\bmatch\b|\bsafety\b|\btarget\b|\bchance\s*me\b|\bcan\s*i\s*get\s*in\b|\bfit\b|\bcompare\s*college/i,
    course_planning: /\bcourse\s*(selection|load|rigor|plan|planning|schedul)\b|\b(what|which)\s+(aps?|ib|honors|classes|courses|electives)\b|\b(classes|courses|schedule|curriculum)\b[^.?!]{0,40}\b(take|pick|choose|next\s+(year|semester|fall|spring))\b/i,
    strategy: /\bstrategy\b|\bplan\b|\broadmap\b|\b4[- ]year\b|\bjunior\s*year\b|\bsenior\s*year\b|\btimeline\b/i,
    gpa_benchmark: /\bgpa\b|\bsat\b|\bact\b|\bpercentile\b|\bbenchmark\b|\bhow\s*(do|does)\s*(my|i)\s*(compare|stack)\b/i,
  },
};

const TOPIC_SOURCE_DOMAINS = Object.freeze({
  fafsa: ["studentaid.gov", "fsapartners.ed.gov"],
  eligibility: ["studentaid.gov", "fsapartners.ed.gov"],
  financial_aid_policy: ["studentaid.gov", "fsapartners.ed.gov"],
  ferpa: ["studentprivacy.ed.gov", "ed.gov"],
  official_stats: ["collegescorecard.ed.gov", "api.data.gov", "nces.ed.gov"],
});

const TOPIC_TERMS = Object.freeze({
  fafsa: ["fafsa", "student aid", "federal aid", "eligibility"],
  eligibility: ["eligibility", "eligible", "citizenship", "ssn", "enrollment"],
  financial_aid_policy: ["financial aid", "fafsa", "need blind", "need aware"],
  ferpa: ["ferpa", "student privacy", "education record"],
  deadlines: ["deadline", "due date", "early action", "early decision", "regular decision"],
  financial_amounts: ["tuition", "net price", "financial aid", "grant", "scholarship", "cost"],
  school_policies: ["policy", "test optional", "test required", "application requirement"],
  official_stats: ["acceptance", "admission rate", "sat", "act", "enrollment", "graduation"],
});

function normalizedTopicType(topicType) {
  return String(topicType || "").toLowerCase();
}

function sourceDomain(evidence) {
  if (evidence?.source_domain) return String(evidence.source_domain).toLowerCase();
  try {
    return new URL(evidence?.source_url || "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isEvidenceUnexpired(evidence, now = new Date()) {
  if (!evidence || evidence.superseded_by) return false;
  if (["expired", "stale", "superseded"].includes(String(evidence.trust_level || "").toLowerCase())) return false;
  const expiry = evidence.expires_at || evidence.expiresAt;
  if (!expiry) return true;
  const timestamp = Date.parse(expiry);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

export function isEvidenceRelevant(evidence, subIntent) {
  if (!evidence) return false;
  const intent = String(subIntent || "").toLowerCase();
  const directTopics = [
    evidence.topic_type,
    evidence.sub_intent,
    evidence.claim_category,
    evidence.fact_key,
    ...(Array.isArray(evidence.relevant_topics) ? evidence.relevant_topics : []),
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  if (directTopics.some((value) => value === intent || value.includes(intent))) return true;

  const domain = sourceDomain(evidence);
  if ((TOPIC_SOURCE_DOMAINS[intent] || []).some((allowed) => domain === allowed || domain.endsWith("." + allowed))) {
    return true;
  }

  const text = [
    evidence.fact_key,
    evidence.fact_value,
    evidence.claim_category,
    evidence.claim,
    evidence.source_title,
  ].filter(Boolean).join(" ").toLowerCase();
  return (TOPIC_TERMS[intent] || [intent.replaceAll("_", " ")])
    .filter((term) => term.length >= 3)
    .some((term) => text.includes(term));
}

export function isVerifiedEvidenceForTopic(evidence, subIntent, { now = new Date() } = {}) {
  const explicitFactVerification = String(evidence?.confidence || "").toLowerCase() === "verified";
  const reviewedOfficialEvidence = evidence?.evidence_type === 1 &&
    String(evidence?.trust_level || "").toLowerCase() === "official" &&
    Boolean(evidence?.verified_at);
  if (!explicitFactVerification && !reviewedOfficialEvidence) return false;
  if (!evidence?.source_url && !evidence?.source_domain) return false;
  if (!isEvidenceUnexpired(evidence, now)) return false;
  return isEvidenceRelevant(evidence, subIntent);
}

// Single source of truth for the crisis lexicon (PATTERNS.crisis). Used by the
// deterministic crisis path AND by any surface that must never echo a minor's
// crisis words back — e.g. a chat-thread title. Keeps one canonical check so
// the two never drift.
export function isCrisisText(text) {
  const s = (text || "").trim();
  if (!s) return false;
  return PATTERNS.crisis.some((pattern) => pattern.test(s));
}

// ─── Main classification function ───
export function classifyTopic(query, conversationContext = {}) {
  const text = (query || "").trim().toLowerCase();
  if (!text) {
    return {
      topicType: TOPIC_TYPES.ADMINISTRATIVE,
      intent: "empty_query",
      subIntent: null,
      sourceConstraint: "none",
      modelTier: MODEL_TIERS.NONE,
      gates: [],
      confidence: 1.0,
      rationale: "Empty query — no classification needed.",
    };
  }

  // 1. Crisis detection — always first, highest priority
  for (const pattern of PATTERNS.crisis) {
    if (pattern.test(text)) {
      return {
        topicType: TOPIC_TYPES.CRISIS,
        intent: "crisis_detected",
        subIntent: null,
        sourceConstraint: "none",
        modelTier: MODEL_TIERS.NONE,
        gates: ["crisis_protocol"],
        confidence: 0.95,
        rationale: "Crisis keywords detected. Route to deterministic crisis response.",
      };
    }
  }

  // 2. Regulated topics
  for (const [subIntent, pattern] of Object.entries(PATTERNS.regulated)) {
    if (pattern.test(text)) {
      return {
        topicType: TOPIC_TYPES.REGULATED,
        intent: "regulated",
        subIntent,
        sourceConstraint: "trusted_only",
        modelTier: MODEL_TIERS.NONE, // Start with rules engine, escalate if needed
        gates: ["source_verification", "no_source_no_answer", "advisory_only_disclosure"],
        confidence: 0.88,
        rationale: `Regulated topic (${subIntent}). Rules engine first, trusted sources only, no-source-no-answer enforced.`,
      };
    }
  }

  // 3. High-stakes topics
  for (const [subIntent, pattern] of Object.entries(PATTERNS.high_stakes)) {
    if (pattern.test(text)) {
      return {
        topicType: TOPIC_TYPES.HIGH_STAKES,
        intent: "high_stakes",
        subIntent,
        sourceConstraint: "official_required",
        modelTier: subIntent === "deadlines" || subIntent === "official_stats"
          ? MODEL_TIERS.NONE   // Pure lookup
          : MODEL_TIERS.SONNET, // May need synthesis for financial amounts
        gates: ["source_verification", "official_source_mode"],
        confidence: 0.82,
        rationale: `High-stakes topic (${subIntent}). Official source required. Speculative responses blocked.`,
      };
    }
  }

  // 4. Coaching topics
  // Start with the cheapest tier that can reasonably handle the request.
  // Strategic coaching starts at medium, never large; large models require
  // an explicit, separately budgeted action.
  const HEAVY_COACHING_SUBINTENTS = new Set([
    "ec_strategy", "essay", "college_list", "strategy", "course_planning",
  ]);
  for (const [subIntent, pattern] of Object.entries(PATTERNS.coaching)) {
    if (pattern.test(text)) {
      let modelTier = MODEL_TIERS.HAIKU;
      if (subIntent === "gpa_benchmark") modelTier = MODEL_TIERS.NONE;
      else if (HEAVY_COACHING_SUBINTENTS.has(subIntent)) modelTier = MODEL_TIERS.SONNET;
      return {
        topicType: TOPIC_TYPES.COACHING,
        intent: "coaching",
        subIntent,
        sourceConstraint: "evidence_grounded",
        modelTier,
        gates: ["coaching_label"],
        confidence: 0.78,
        rationale: `Coaching topic (${subIntent}). ${modelTier === MODEL_TIERS.OPUS ? "Cross-source strategy — large model required." : "Evidence-grounded synthesis with coaching label."}`,
      };
    }
  }

  // 5. Default: general coaching
  return {
    topicType: TOPIC_TYPES.COACHING,
    intent: "coaching",
    subIntent: "general",
    sourceConstraint: "evidence_grounded",
    modelTier: MODEL_TIERS.HAIKU,
    gates: ["coaching_label"],
    confidence: 0.5,
    rationale: "No specific topic matched. Default to evidence-grounded coaching.",
  };
}

// ─── Lookup vs. guidance ───
// The no-source gate refuses only a PURE LOOKUP — "when is X's deadline",
// "what is Y's acceptance rate" — because a wrong date or admit rate is
// worse than no answer. Strategy, comparison and explanation questions on
// the same topics ("should I apply early decision", "how much does the
// acceptance rate matter") are general guidance: the model answers with the
// verified data it holds and says plainly what it cannot confirm.
const LOOKUP_ASK_RE = /\b(?:when|what|what's|whats|which|how\s+many|give\s+me|tell\s+me|list|show\s+me|find|look\s+up|do\s+you\s+(?:know|have)|is\s+(?:it|the|there))\b/i;
const GUIDANCE_RE = /\b(?:should|shouldn't|would\s+it|worth|better|best|vs\.?|versus|differ\w*|compar\w*|means?|meaning|explain|understand|why|how\s+(?:do|does|did|can|could|should|important|much\s+do(?:es)?)|strateg\w*|chances?|odds|decide|deciding|decided|choos\w*|pros|cons|matters?|good\s+idea|bad\s+idea|advice|advise|recommend\w*|plan|planning|prepar\w*|manag\w*|organiz\w*|keep\s+track|tips?|help\s+me|thoughts?|opinion|ok(?:ay)?\s+to|worr\w*|stress\w*|realistic|competitive|likely|typical\w*|usually|generally|in\s+general|on\s+average|improve|increase|boost|affect|impact|prioriti\w*|handle|balance|too\s+late|missed|miss|extension|extend|late)\b/i;

export function isLookupQuestion(query, subIntent) {
  const text = String(query || "").trim();
  if (!text) return false;
  const intent = String(subIntent || "").toLowerCase();
  if (intent !== "deadlines" && intent !== "official_stats") return false;
  if (GUIDANCE_RE.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  return LOOKUP_ASK_RE.test(text) || words <= 8;
}

// ─── Compliance gate enforcement ───
// context.query is the student's question and context.schoolNamed says
// whether it names a specific school; with both, only a pure lookup about a
// named school is refused. Callers that pass no context keep the strict
// no-source-no-answer behaviour for deadline and statistics topics.
export function enforceGates(topicType, subIntent, availableEvidence = [], context = {}) {
  const results = [];
  const normalizedType = normalizedTopicType(topicType);

  if (normalizedType === TOPIC_TYPES.CRISIS) {
    results.push({
      gate: "crisis_protocol",
      passed: true,
      action: "deterministic_crisis_response",
      reason: "Crisis detected — bypass all model calls, return crisis resources.",
    });
    return { allowed: true, gates: results, fallback: null };
  }

  if (normalizedType === TOPIC_TYPES.REGULATED || normalizedType === TOPIC_TYPES.HIGH_STAKES) {
    const verifiedEvidence = availableEvidence.filter((e) =>
      isVerifiedEvidenceForTopic(e, subIntent)
    );

    if (verifiedEvidence.length === 0) {
      // Informational questions must not be stonewalled: REGULATED topics
      // (FAFSA / financial-aid / FERPA) and non-lookup HIGH_STAKES topics
      // (costs, aid amounts in general terms, school policies) get grounded
      // GENERAL guidance labeled unverified, with the advisory disclosure
      // and an official-source pointer. Only the pure-lookup topics — exact
      // deadlines and official statistics — keep the hard no-source-no-answer
      // gate, because a wrong date or admit rate is worse than no answer.
      const hardLookup = normalizedType === TOPIC_TYPES.HIGH_STAKES &&
        ["deadlines", "official_stats"].includes(String(subIntent || "").toLowerCase());
      const pureLookup = context.query === undefined ? true : isLookupQuestion(context.query, subIntent);
      const schoolNamed = context.schoolNamed === undefined ? true : Boolean(context.schoolNamed);
      if (!hardLookup || !pureLookup || !schoolNamed) {
        results.push({
          gate: "no_source_no_answer",
          passed: true,
          action: "allow_unverified_general_guidance",
          reason: "No verified source matched — answering with general guidance labeled as unverified, with an official-source pointer.",
        });
        results.push({
          gate: "advisory_only_disclosure",
          passed: true,
          action: "attach_advisory_disclosure",
          reason: "General regulated-topic guidance always carries the advisory disclosure.",
        });
        return {
          allowed: true,
          gates: results,
          fallback: null,
          generalGuidance: {
            unverified: true,
            suggestedSource: getSuggestedOfficialSource(subIntent),
          },
        };
      }

      // HIGH_STAKES lookups (deadlines, official stats) stay hard-gated:
      // a wrong deadline or admit rate is worse than no answer.
      results.push({
        gate: "no_source_no_answer",
        passed: false,
        action: "return_no_verified_answer",
        reason: "No verified source available for this high-stakes topic.",
      });
      return {
        allowed: false,
        gates: results,
        fallback: {
          message: "No verified answer available for this question.",
          suggestedSource: getSuggestedOfficialSource(subIntent),
          reason: "No official source matched this query in our verified database.",
        },
      };
    }

    results.push({
      gate: "source_verification",
      passed: true,
      action: "proceed_with_evidence",
      reason: `${verifiedEvidence.length} verified evidence item(s) available.`,
    });
  }

  if (normalizedType === TOPIC_TYPES.COACHING) {
    results.push({
      gate: "coaching_label",
      passed: true,
      action: "label_as_coaching",
      reason: "Output will be labeled as non-binding coaching suggestion.",
    });
  }

  return { allowed: true, gates: results, fallback: null };
}

// ─── Model tier selection with escalation logic ───
//
// Strategy Council rule (Pillar 9): when the subIntent is in the
// council-eligible set AND we're not already inside a council-spawned
// sub-call, return COUNCIL instead of OPUS. The orchestration engine
// detects the marker and dispatches to council.convene().
export function selectModelTier(...args) {
  const tier = selectModelTierInner(...args);
  const [topicType, subIntent, queryComplexity] = args;
  llmDebug("TIER", "selectModelTier", { topicType, subIntent, queryComplexity: queryComplexity || "normal", tier });
  return tier;
}

function selectModelTierInner(topicType, subIntent, queryComplexity = "normal", priorAttempt = null, opts = {}) {
  const explicitCouncil = opts.explicitCouncil === true;
  const allowPaidEscalation = opts.allowPaidEscalation === true && opts.budgetApproved === true;

  // Crisis: never use a model
  if (topicType === TOPIC_TYPES.CRISIS) return MODEL_TIERS.NONE;

  // Administrative: never use a model
  if (topicType === TOPIC_TYPES.ADMINISTRATIVE) return MODEL_TIERS.NONE;

  // Regulated: start with rules engine
  if (topicType === TOPIC_TYPES.REGULATED) {
    if (!priorAttempt) return MODEL_TIERS.NONE;
    // If rules engine couldn't fully answer, escalate to Sonnet for grounded synthesis
    if (priorAttempt.tier === MODEL_TIERS.NONE && priorAttempt.needsSynthesis) {
      return MODEL_TIERS.SONNET;
    }
    // If Sonnet couldn't resolve (low confidence), escalate to Opus
    if (priorAttempt.tier === MODEL_TIERS.SONNET &&
        priorAttempt.confidence < OPUS_ESCALATION_THRESHOLD &&
        allowPaidEscalation) {
      return MODEL_TIERS.OPUS;
    }
    return priorAttempt.tier;
  }

  // High-stakes: deadlines and stats are lookup-only
  if (topicType === TOPIC_TYPES.HIGH_STAKES) {
    if (subIntent === "deadlines" || subIntent === "official_stats") return MODEL_TIERS.NONE;
    if (!priorAttempt) return MODEL_TIERS.SONNET;
    if (priorAttempt.tier === MODEL_TIERS.SONNET &&
        priorAttempt.confidence < OPUS_ESCALATION_THRESHOLD &&
        allowPaidEscalation) {
      return MODEL_TIERS.OPUS;
    }
    return MODEL_TIERS.SONNET;
  }

  // Coaching
  if (topicType === TOPIC_TYPES.COACHING) {
    if (subIntent === "gpa_benchmark") return MODEL_TIERS.NONE;

    // Heavy strategic subintents — convene the 5-seat Strategy Council
    // when allowed. Falls back to OPUS when the caller is already inside
    // a council sub-call (avoids infinite recursion).
    if (STRATEGY_COUNCIL_SUBINTENTS.has(subIntent)) {
      if (explicitCouncil) return MODEL_TIERS.COUNCIL;
      return MODEL_TIERS.SONNET;
    }
    if (!priorAttempt) return MODEL_TIERS.HAIKU;
    // Escalate any other complex coaching turn to Opus on retry.
    if (priorAttempt.tier === MODEL_TIERS.HAIKU &&
        priorAttempt.confidence < OPUS_ESCALATION_THRESHOLD &&
        queryComplexity === "complex" &&
        allowPaidEscalation) {
      return MODEL_TIERS.SONNET;
    }
    return priorAttempt.tier || MODEL_TIERS.HAIKU;
  }

  return MODEL_TIERS.SONNET;
}

// ─── Check if query can be fully handled by rules engine (T0) ───
// `query` is optional: when provided, a FAFSA-tagged question is only routed
// to the deterministic eligibility checker when it actually asks about
// eligibility/qualification. General FAFSA questions ("how does the FAFSA
// work?") used to get squeezed into an eligibility-rules answer; they now
// fall through to grounded synthesis under the general-guidance gate.
export function canHandleDeterministically(topicType, subIntent, query = "") {
  const deterministicRoutes = new Set([
    `${TOPIC_TYPES.CRISIS}:crisis_detected`,
    `${TOPIC_TYPES.REGULATED}:fafsa`,        // Eligibility checks
    `${TOPIC_TYPES.REGULATED}:eligibility`,
    `${TOPIC_TYPES.HIGH_STAKES}:deadlines`,
    `${TOPIC_TYPES.HIGH_STAKES}:official_stats`,
    `${TOPIC_TYPES.COACHING}:gpa_benchmark`,
    `${TOPIC_TYPES.ADMINISTRATIVE}:empty_query`,
  ]);
  if (!deterministicRoutes.has(`${topicType}:${subIntent}`)) return false;
  // The deterministic checker answers FEDERAL-AID eligibility checks only.
  // "Eligible/qualify" phrasing alone spans admissions ("am I eligible for
  // Princeton?"), scholarships, and program questions — serving those the
  // federal FAFSA checklist buried real questions under boilerplate. Require
  // both an eligibility verb AND explicit federal-aid context.
  if (topicType === TOPIC_TYPES.REGULATED && (subIntent === "fafsa" || subIntent === "eligibility") && String(query || "").trim()) {
    return /\b(eligib\w*|qualif\w*)\b/i.test(query)
      && /\b(fafsa|federal|financial\s+aid|student\s+aid|pell|loan|grant)\b/i.test(query);
  }
  return true;
}

// ─── Check Opus budget ───
export function checkOpusBudget(studentId, opusUsageToday, config = {}) {
  const dailyCap = config.OPUS_DAILY_CAP || 5;
  const monthlyCap = config.OPUS_MONTHLY_CAP || 50;

  return {
    allowed: opusUsageToday.daily < dailyCap && opusUsageToday.monthly < monthlyCap,
    dailyRemaining: Math.max(0, dailyCap - opusUsageToday.daily),
    monthlyRemaining: Math.max(0, monthlyCap - opusUsageToday.monthly),
    reason: opusUsageToday.daily >= dailyCap
      ? "Daily Opus budget exceeded. Complex queries will use Sonnet."
      : opusUsageToday.monthly >= monthlyCap
        ? "Monthly Opus budget exceeded."
        : null,
  };
}

// ─── Build full routing decision ───
export function routeRequest(query, conversationContext = {}, availableEvidence = [], config = {}) {
  const classification = classifyTopic(query, conversationContext);
  const gateResult = enforceGates(classification.topicType, classification.subIntent, availableEvidence, { query });

  if (!gateResult.allowed) {
    return {
      classification,
      gateResult,
      modelTier: MODEL_TIERS.NONE,
      action: "return_fallback",
      fallback: gateResult.fallback,
    };
  }

  let modelTier = selectModelTier(
    classification.topicType,
    classification.subIntent,
    conversationContext.queryComplexity || "normal",
    conversationContext.priorAttempt || null,
    {
      explicitCouncil: conversationContext.explicitCouncil === true,
      allowPaidEscalation: conversationContext.allowPaidEscalation === true,
      budgetApproved: conversationContext.budgetApproved === true,
    },
  );

  const isDeterministic = canHandleDeterministically(classification.topicType, classification.subIntent, query);

  // General-guidance mode (regulated topic, no verified evidence): the rules
  // engine has nothing to answer with and a fact-store lookup would come back
  // empty, so route to medium-tier synthesis. The composer labels everything
  // as unverified coaching with the official-source pointer.
  if (!isDeterministic && gateResult.generalGuidance && modelTier === MODEL_TIERS.NONE) {
    modelTier = MODEL_TIERS.SONNET;
  }

  let action;
  if (isDeterministic) action = "rules_engine";
  else if (modelTier === MODEL_TIERS.NONE) action = "fact_store_lookup";
  else if (modelTier === MODEL_TIERS.COUNCIL) action = "strategy_council";
  else action = "model_synthesis";

  return {
    classification,
    gateResult,
    modelTier,
    isDeterministic,
    action,
    generalGuidance: gateResult.generalGuidance || null,
  };
}

// ─── Helper: suggest official source for a regulated sub-intent ───
function getSuggestedOfficialSource(subIntent) {
  const sources = {
    fafsa: { url: "https://studentaid.gov", label: "StudentAid.gov" },
    ferpa: { url: "https://studentprivacy.ed.gov", label: "Student Privacy Policy Office" },
    financial_aid_policy: { url: "https://studentaid.gov", label: "StudentAid.gov" },
    eligibility: { url: "https://studentaid.gov/apply-for-aid/fafsa/eligibility", label: "FAFSA Eligibility (StudentAid.gov)" },
    legal_compliance: { url: "https://ed.gov", label: "U.S. Department of Education" },
    deadlines: { url: null, label: "Check the college's official admissions website" },
    financial_amounts: { url: null, label: "Contact the college's financial aid office directly" },
    school_policies: { url: null, label: "Check the college's official admissions website" },
    official_stats: { url: "https://collegescorecard.ed.gov", label: "College Scorecard (U.S. Dept. of Education)" },
  };
  return sources[subIntent] || { url: null, label: "Consult the relevant official source directly" };
}
