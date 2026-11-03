// ═══════════════════════════════════════════════════════════════════════
// RULES ENGINE — Deterministic logic for FAFSA, deadlines, percentiles
// ═══════════════════════════════════════════════════════════════════════
// Handles all logic that can be computed without an LLM call.
// This module is the T0 (cost=$0) tier of the architecture.
// ═══════════════════════════════════════════════════════════════════════

import crypto from "node:crypto";

// The federal eligibility rules, one entry per award year, each reviewed
// against that year's FSA Handbook before it is added. There used to be a
// single hard-coded 2026-27 record: on 2027-07-01 every rule would have
// dropped out of the verified lane with no warning, and nothing said that
// this cycle's seniors file the 2027-28 form (time-4, debt-4). Add the next
// year only from its published handbook (2027-28 Volume 1 was not out on
// 2026-11-03); until then fafsaRulesetStatus warns the counselor from 60
// days before the newest entry expires, and once none covers the date the
// chat sends FAFSA eligibility questions to the model as labeled general
// guidance with the StudentAid.gov pointer.
export const FAFSA_RULESETS = Object.freeze([
  Object.freeze({
    id: "fafsa_eligibility_2026_2027",
    academicYear: "2026-2027",
    effectiveAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2027-06-30T23:59:59.999Z",
    sourceUrl: "https://fsapartners.ed.gov/knowledge-center/fsa-handbook/2026-2027/vol1/ch1-school-determined-requirements",
    sourceTitle: "2026-2027 Federal Student Aid Handbook, Volume 1, Chapter 1",
    sourceDomain: "fsapartners.ed.gov",
  }),
]);

const DAY_MS = 24 * 60 * 60 * 1000;
export const FAFSA_RULESET_WARNING_DAYS = 60;

// The FAFSA for an award year opens on October 1 before it begins (the
// 2027-28 form on 2026-10-01), and a senior files the form for the year
// they enroll, so a ruleset is usable from its form's opening day.
function formOpensAt(ruleset) {
  const effective = new Date(ruleset.effectiveAt);
  return ruleset.formOpensAt ? Date.parse(ruleset.formOpensAt) : Date.UTC(effective.getUTCFullYear() - 1, 9, 1);
}

// The award year of the newest FAFSA form open on `now`.
function newestOpenAwardYear(now) {
  const start = now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return `${start}-${start + 1}`;
}

// Prefers the award year whose FAFSA opened most recently, otherwise the
// one in effect; null when no reviewed ruleset covers `now`.
export function selectFafsaRuleset(now = new Date(), rulesets = FAFSA_RULESETS) {
  const t = now.getTime();
  return [...rulesets]
    .filter((r) => formOpensAt(r) <= t && t <= Date.parse(r.expiresAt))
    .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0] || null;
}

// For the admin status payload and the boot log line: each ruleset with the
// days left before it expires (negative once it has), and a warning from
// FAFSA_RULESET_WARNING_DAYS before the newest one lapses or once none
// covers the date.
export function fafsaRulesetStatus(now = new Date(), rulesets = FAFSA_RULESETS) {
  const t = now.getTime();
  const rows = rulesets.map((r) => ({
    id: r.id,
    academicYear: r.academicYear,
    expiresAt: r.expiresAt,
    daysLeft: Math.ceil((Date.parse(r.expiresAt) - t) / DAY_MS),
  }));
  const current = selectFafsaRuleset(now, rulesets);
  const newest = rows.reduce((best, row) => (!best || Date.parse(row.expiresAt) > Date.parse(best.expiresAt) ? row : best), null);
  let warning = null;
  if (!current) {
    warning = `No FAFSA eligibility ruleset covers ${now.toISOString().slice(0, 10)}: FAFSA eligibility questions get labeled general guidance until the ${newestOpenAwardYear(now)} FSA Handbook rules are reviewed and added to FAFSA_RULESETS in backend/chat/rules-engine.js.`;
  } else if (newest && newest.daysLeft <= FAFSA_RULESET_WARNING_DAYS) {
    warning = `The ${newest.academicYear} FAFSA eligibility ruleset expires in ${newest.daysLeft} day(s) (${newest.expiresAt.slice(0, 10)}); review the next award year's FSA Handbook and add it to FAFSA_RULESETS in backend/chat/rules-engine.js.`;
  }
  return { rulesets: rows, current: current?.id || null, warning };
}

// ═══════════════════════════════════════════════════════════
// FAFSA ELIGIBILITY PRE-CHECK
// ═══════════════════════════════════════════════════════════
// Deterministic checklist based on published FAFSA eligibility rules.
// Source: https://studentaid.gov/apply-for-aid/fafsa/eligibility

const FAFSA_ELIGIBILITY_RULES = [
  {
    id: "citizenship",
    label: "U.S. Citizenship or Eligible Noncitizen Status",
    description: "Must be a U.S. citizen, U.S. national, or eligible noncitizen (e.g., permanent resident with Green Card).",
    required: true,
    source: "https://studentaid.gov/apply-for-aid/fafsa/eligibility/citizenship-status",
  },
  {
    id: "ssn",
    label: "Valid Social Security Number",
    description: "Must have a valid Social Security number (exceptions: students from the Freely Associated States).",
    required: true,
    source: "https://studentaid.gov/apply-for-aid/fafsa/eligibility",
  },
  {
    id: "enrollment",
    label: "Enrollment in an Eligible Program",
    description: "Must be enrolled or accepted as a regular student in an eligible degree or certificate program.",
    required: true,
    source: "https://studentaid.gov/apply-for-aid/fafsa/eligibility",
  },
  {
    id: "high_school_completion",
    label: "High School Diploma, GED, or Equivalent",
    description: "Must have a high school diploma, GED, or completed homeschool at secondary level.",
    required: true,
    source: "https://studentaid.gov/apply-for-aid/fafsa/eligibility",
  },
  {
    id: "satisfactory_progress",
    label: "Satisfactory Academic Progress",
    description: "Must maintain satisfactory academic progress (SAP) in college, as defined by your school.",
    required: true,
    source: "https://studentaid.gov/apply-for-aid/fafsa/eligibility",
  },
  {
    id: "no_drug_conviction",
    label: "No Drug Conviction During Federal Aid Period",
    description: "As of the FAFSA Simplification Act (2024-2025 onward), drug convictions no longer affect eligibility for federal student aid.",
    required: false,
    note: "This rule was removed starting with the 2024-2025 FAFSA. Previous years had restrictions.",
    source: "https://studentaid.gov/apply-for-aid/fafsa/eligibility",
  },
  {
    id: "not_in_default",
    label: "Not in Default on Federal Student Loans",
    description: "Must not be in default on a federal student loan or owe a refund on a federal grant.",
    required: true,
    source: "https://studentaid.gov/apply-for-aid/fafsa/eligibility",
  },
];

export function runFAFSAEligibilityCheck(studentData = {}, { now = new Date(), rulesets = FAFSA_RULESETS } = {}) {
  const ruleset = selectFafsaRuleset(now, rulesets);
  if (!ruleset) {
    // The route reads this message as "not answerable here" and sends the
    // question to the model under the regulated advisory prefix.
    return {
      available: false,
      eligible: null,
      results: [],
      message: "No deterministic rule is available for this FAFSA question: no reviewed FAFSA eligibility ruleset covers this date.",
      advisory: "Check the current requirements at https://studentaid.gov/apply-for-aid/fafsa/eligibility.",
      source: "https://studentaid.gov/apply-for-aid/fafsa/eligibility",
      removedRequirements: [],
    };
  }
  const supplied = studentData && typeof studentData === "object" ? studentData : {};
  const results = FAFSA_ELIGIBILITY_RULES.map((rule) => {
    const fieldValue = supplied[rule.id];
    let status = "unknown"; // unknown, pass, fail, not_applicable

    if (!rule.required) {
      status = "not_applicable";
    } else if (fieldValue === true) {
      status = "pass";
    } else if (fieldValue === false) {
      status = "fail";
    }

    return {
      ruleId: rule.id,
      label: rule.label,
      description: rule.description,
      required: rule.required,
      status,
      source: rule.source,
      note: rule.note || null,
      academicYear: ruleset.academicYear,
      effectiveAt: ruleset.effectiveAt,
      expiresAt: ruleset.expiresAt,
      sourceTitle: ruleset.sourceTitle,
      sourceDomain: ruleset.sourceDomain,
    };
  });

  const allPassed = results
    .filter((r) => r.required && r.status !== "not_applicable")
    .every((r) => r.status === "pass" || r.status === "unknown");

  const anyFailed = results.some((r) => r.status === "fail" && r.required);
  const unknownCount = results.filter((r) => r.status === "unknown" && r.required).length;
  const requiredCount = results.filter((r) => r.required).length;

  // The chat supplies no answers, so a checklist question used to get
  // "6 eligibility item(s) have not been confirmed yet" and nothing else.
  // With nothing supplied the summary introduces the requirements instead,
  // and names the handbook they come from: from October seniors file the
  // next award year's form, whose handbook may not be out yet.
  const openYear = newestOpenAwardYear(now);
  const handbook = `the ${ruleset.academicYear} Federal Student Aid Handbook`;
  const yearNote = openYear !== ruleset.academicYear
    ? ` The ${openYear} FAFSA (the form seniors file this cycle) follows the ${openYear} handbook, which is not reflected here yet; the basic requirements rarely change, but confirm them on StudentAid.gov.`
    : "";
  return {
    available: true,
    eligible: anyFailed ? false : unknownCount === 0 ? true : null,
    summary: (anyFailed
      ? "Based on the information provided, you may not meet one or more FAFSA eligibility requirements. Please review the items below and consult StudentAid.gov for official guidance."
      : unknownCount === requiredCount
        ? `These are the basic requirements for federal student aid in ${handbook}. Check each one against your own situation; StudentAid.gov explains the special cases, such as noncitizen status or a parent without a Social Security number.`
        : unknownCount > 0
          ? `${unknownCount} eligibility item(s) have not been confirmed yet. Complete all items for a full eligibility assessment.`
          : "Based on the information provided, you appear to meet the basic FAFSA eligibility requirements. This is an informal assessment only — submit your FAFSA at StudentAid.gov for an official determination.") + yearNote,
    // The same note on its own, for the model's copy of the rules.
    filingYearNote: yearNote.trim() || null,
    results,
    advisory: "This is NOT an official eligibility determination. Only the U.S. Department of Education can make official FAFSA eligibility decisions. Submit your FAFSA at https://studentaid.gov.",
    academicYear: ruleset.academicYear,
    effectiveAt: ruleset.effectiveAt,
    expiresAt: ruleset.expiresAt,
    source: ruleset.sourceUrl,
    sourceTitle: ruleset.sourceTitle,
    removedRequirements: [
      {
        id: "selective_service",
        note: "Selective Service registration is not a Title IV federal student aid eligibility requirement.",
        source: ruleset.sourceUrl,
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════
// DEADLINE CALCULATIONS
// ═══════════════════════════════════════════════════════════

export function calculateDeadlineStatus(deadlineDate, applicationType = "regular_decision") {
  if (!deadlineDate) {
    return { status: "unknown", daysRemaining: null, message: "No deadline date available." };
  }

  const now = new Date();
  const deadline = new Date(deadlineDate);
  if (isNaN(deadline.getTime())) {
    return { status: "invalid", daysRemaining: null, message: "Invalid deadline date format." };
  }

  const msRemaining = deadline.getTime() - now.getTime();
  const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));

  let status, urgency;
  if (daysRemaining < 0) {
    status = "passed";
    urgency = "none";
  } else if (daysRemaining <= 7) {
    status = "imminent";
    urgency = "critical";
  } else if (daysRemaining <= 30) {
    status = "approaching";
    urgency = "high";
  } else if (daysRemaining <= 90) {
    status = "upcoming";
    urgency = "medium";
  } else {
    status = "future";
    urgency = "low";
  }

  return {
    status,
    urgency,
    daysRemaining,
    deadlineDate: deadline.toISOString().slice(0, 10),
    applicationType,
    message:
      status === "passed"
        ? `This deadline has passed (${Math.abs(daysRemaining)} day(s) ago).`
        : `${daysRemaining} day(s) remaining until the ${applicationType.replace(/_/g, " ")} deadline.`,
  };
}

// ═══════════════════════════════════════════════════════════
// DOCUMENT COMPLETENESS CHECKS
// ═══════════════════════════════════════════════════════════

const APPLICATION_REQUIREMENTS = {
  common_app: {
    required: [
      { id: "personal_essay", label: "Common App Personal Essay (250-650 words)" },
      { id: "activities_list", label: "Activities List (up to 10 activities)" },
      { id: "demographics", label: "Demographics and personal information" },
      { id: "education_section", label: "Education section (GPA, courses, honors)" },
      { id: "testing", label: "Testing section (SAT/ACT, or test-optional acknowledgment)" },
    ],
    optional: [
      { id: "additional_info", label: "Additional Information section (context, explanations)" },
      { id: "fee_waiver", label: "Fee waiver (if applicable)" },
    ],
  },
  fafsa: {
    required: [
      { id: "fsa_id", label: "FSA ID (for student and each contributor)" },
      { id: "ssn", label: "Social Security Number" },
      { id: "tax_info", label: "Federal tax return information (or non-filing statement)" },
      { id: "school_selection", label: "Selected colleges to receive FAFSA results" },
    ],
    optional: [
      { id: "dependency_override", label: "Dependency status documentation (if unusual circumstances)" },
    ],
  },
  css_profile: {
    required: [
      { id: "parent_financials", label: "Detailed parent/guardian financial information" },
      { id: "business_farm", label: "Business/farm information (if applicable)" },
      { id: "noncustodial_parent", label: "Noncustodial parent information (if parents are separated)" },
    ],
    optional: [],
  },
};

export function runDocumentCompletenessCheck(applicationType, submittedItems = []) {
  const requirements = APPLICATION_REQUIREMENTS[applicationType];
  if (!requirements) {
    return { error: `Unknown application type: ${applicationType}. Valid types: ${Object.keys(APPLICATION_REQUIREMENTS).join(", ")}` };
  }

  const submittedSet = new Set(submittedItems.map((i) => (typeof i === "string" ? i : i.id)));

  const requiredResults = requirements.required.map((req) => ({
    ...req,
    status: submittedSet.has(req.id) ? "complete" : "missing",
  }));

  const optionalResults = requirements.optional.map((opt) => ({
    ...opt,
    status: submittedSet.has(opt.id) ? "complete" : "not_submitted",
  }));

  const missingRequired = requiredResults.filter((r) => r.status === "missing");

  return {
    applicationType,
    complete: missingRequired.length === 0,
    requiredItems: requiredResults,
    optionalItems: optionalResults,
    missingCount: missingRequired.length,
    missingItems: missingRequired.map((r) => r.label),
    summary: missingRequired.length === 0
      ? `All required items for ${applicationType.replace(/_/g, " ")} appear to be complete.`
      : `${missingRequired.length} required item(s) still needed for ${applicationType.replace(/_/g, " ")}: ${missingRequired.map((r) => r.label).join("; ")}.`,
  };
}

// ═══════════════════════════════════════════════════════════
// PERCENTILE COMPUTATION (deterministic interpolation)
// ═══════════════════════════════════════════════════════════

export function computePercentile(distribution, value, field = "score") {
  if (!distribution || distribution.length === 0 || value == null) return null;

  for (let i = 0; i < distribution.length; i++) {
    const row = distribution[i];
    const rowVal = row[field];
    if (rowVal == null) continue;

    if (value <= rowVal) {
      if (i === 0) return row.percentile;
      const prev = distribution[i - 1];
      const prevVal = prev[field];
      if (prevVal == null) return row.percentile;
      const frac = (value - prevVal) / (rowVal - prevVal);
      return Math.round(prev.percentile + frac * (row.percentile - prev.percentile));
    }
  }

  return Math.min(99, distribution[distribution.length - 1].percentile + 2);
}

// ═══════════════════════════════════════════════════════════
// AP RIGOR INDEX (deterministic)
// ═══════════════════════════════════════════════════════════

export function computeAPRigorIndex(courses, apRigorTable) {
  if (!courses || courses.length === 0) return { index: 0, details: [] };
  const table = apRigorTable || {};

  const apCourses = courses.filter((c) => c.type === "ap" || c.level === "AP");
  const details = apCourses.map((c) => {
    const rigor = table[c.name] || table[c.exam] || null;
    const tierWeight = rigor ? 6 - rigor.tier : 1; // tier1=5, tier2=4, ..., tier5=1
    return {
      course: c.name || c.exam,
      tier: rigor?.tier || 5,
      tierLabel: rigor?.label || "Unknown",
      weight: tierWeight,
    };
  });

  const index = details.reduce((sum, d) => sum + d.weight, 0);

  return {
    index,
    courseCount: apCourses.length,
    details,
    interpretation:
      index >= 20 ? "Extremely rigorous course load"
        : index >= 15 ? "Very rigorous course load"
          : index >= 10 ? "Rigorous course load"
            : index >= 5 ? "Moderately rigorous"
              : "Limited AP rigor — consider adding challenging courses",
  };
}

// ═══════════════════════════════════════════════════════════
// NET PRICE ESTIMATE (deterministic formula)
// ═══════════════════════════════════════════════════════════

export function estimateNetPrice(collegeData, familyIncome, isInState = false) {
  if (!collegeData) return { error: "College data not available." };

  const sticker = isInState ? collegeData.tuition_in : collegeData.tuition_out;
  if (!sticker) return { error: "Tuition data not available for this college." };

  // Use the college's reported average net price if available
  if (collegeData.avg_net_price) {
    return {
      stickerPrice: sticker,
      estimatedNetPrice: collegeData.avg_net_price,
      estimatedAid: sticker - collegeData.avg_net_price,
      method: "college_reported_average",
      note: "This is the college-reported average net price across all income levels. Your actual net price may differ. Use the college's official Net Price Calculator for a personalized estimate.",
      source: "College Scorecard (U.S. Dept. of Education)",
    };
  }

  // Rough estimate based on income bracket + Pell eligibility
  const pellEligible = familyIncome && familyIncome < 60000;
  const estimatedGrant = pellEligible ? Math.min(7395, sticker * 0.4) : sticker * 0.15;
  const estimatedNet = Math.max(0, sticker - estimatedGrant);

  return {
    stickerPrice: sticker,
    estimatedNetPrice: Math.round(estimatedNet),
    estimatedAid: Math.round(estimatedGrant),
    method: "rough_estimate",
    note: "This is a rough estimate only. Use the college's official Net Price Calculator (required on every college website) for an accurate estimate.",
    pellEligible,
  };
}

// ═══════════════════════════════════════════════════════════
// COMPLIANCE GATE EVALUATION
// ═══════════════════════════════════════════════════════════

export function evaluateComplianceGate(topicType, evidenceObjects = [], options = {}) {
  // For regulated topics: must have at least one verified evidence object from trusted source
  if (topicType === "regulated" || topicType === "high_stakes") {
    const verified = evidenceObjects.filter(
      (e) => e.confidence === "verified" &&
        e.trust_level === "official" &&
        (e.source_url || e.source_domain) &&
        (!e.expires_at || Date.parse(e.expires_at) > Date.now())
    );

    if (verified.length === 0 && !options.allowUnverified) {
      return {
        allowed: false,
        reason: "No verified evidence from trusted sources available for this regulated topic.",
        action: "return_no_verified_answer",
        evidenceCount: evidenceObjects.length,
        verifiedCount: 0,
      };
    }

    return {
      allowed: true,
      reason: `${verified.length} verified evidence item(s) available from trusted sources.`,
      action: "proceed",
      evidenceCount: evidenceObjects.length,
      verifiedCount: verified.length,
    };
  }

  // For coaching: evidence is recommended but not required
  return {
    allowed: true,
    reason: "Coaching topic — evidence grounding recommended but not gated.",
    action: "proceed",
    evidenceCount: evidenceObjects.length,
  };
}

// ═══════════════════════════════════════════════════════════
// CRISIS RESPONSE (deterministic — no model call)
// ═══════════════════════════════════════════════════════════

// The resource lists, the reply copy and the topic footer are identical in
// frontend/src/chat/crisis-lexicon.js, which renders the same reply when the
// client's own lexicon fires first; backend/tests/crisis-lexicon-parity.test.js
// compares them. Korea consolidated 1393 and its other counseling lines into
// 109 in January 2024, so 1393 and 1577-0199 are gone. The Korean list
// comes first in Korean, then the US lines, because a Korean-speaking
// student may be in either country.
const US_CRISIS_RESOURCES = Object.freeze([
  Object.freeze({ name: "Emergency services", contact: "911", description: "If you are in immediate danger", type: "emergency" }),
  Object.freeze({ name: "988 Suicide & Crisis Lifeline", contact: "988", description: "Call or text, 24/7", type: "crisis" }),
  Object.freeze({ name: "Crisis Text Line", contact: "Text HOME to 741741", description: "Free, 24/7", type: "crisis" }),
  Object.freeze({ name: "Childhelp National Child Abuse Hotline", contact: "1-800-422-4453", description: "24/7", type: "abuse" }),
]);
const KO_CRISIS_RESOURCES = Object.freeze([
  Object.freeze({ name: "자살예방상담전화", contact: "109", description: "24시간 상담", type: "crisis" }),
  Object.freeze({ name: "청소년상담전화", contact: "1388", description: "24시간 청소년 상담", type: "youth" }),
  Object.freeze({ name: "응급 신고", contact: "119", description: "지금 위험하거나 다쳤을 때", type: "emergency" }),
  Object.freeze({ name: "경찰", contact: "112", description: "폭력이나 위협이 있을 때", type: "emergency" }),
  Object.freeze({ name: "Emergency services (미국)", contact: "911", description: "미국에서 즉시 위험할 때", type: "emergency" }),
  Object.freeze({ name: "988 Suicide & Crisis Lifeline (미국)", contact: "988", description: "전화 또는 문자, 24시간", type: "crisis" }),
  Object.freeze({ name: "Crisis Text Line (미국)", contact: "Text HOME to 741741", description: "무료 문자 상담, 24시간", type: "crisis" }),
  Object.freeze({ name: "Childhelp 아동학대 핫라인 (미국)", contact: "1-800-422-4453", description: "24시간", type: "abuse" }),
]);

const CRISIS_COPY = Object.freeze({
  "en-US": Object.freeze({
    message: "It sounds like you may be going through something really hard. You don't have to handle it alone, and people who can help are available right now.",
    adult: "Please also reach out to a trusted adult: a parent, school counselor, teacher, or coach. Asking for help is a sign of strength.",
    disclaimer: "I'm an AI assistant and can't provide crisis counseling. Please contact one of these trained services.",
    resources: US_CRISIS_RESOURCES,
  }),
  ko: Object.freeze({
    message: "지금 많이 힘든 시간을 보내고 있는 것 같아요. 혼자 감당하지 않아도 돼요. 지금 바로 도움을 받을 수 있는 곳이 있어요.",
    adult: "부모님, 학교 상담 선생님, 선생님이나 코치처럼 믿을 수 있는 어른에게도 꼭 이야기해 주세요. 도움을 청하는 것은 용기 있는 일이에요.",
    disclaimer: "저는 AI 도우미라서 위기 상담을 제공할 수 없어요. 위의 전문 기관에 연락해 주세요.",
    resources: KO_CRISIS_RESOURCES,
  }),
});

function crisisCopy(locale) {
  return locale === "ko" ? CRISIS_COPY.ko : CRISIS_COPY["en-US"];
}

export function buildCrisisResponse(locale = "en-US") {
  const copy = crisisCopy(locale);
  return {
    topicType: "crisis",
    modelUsed: "none",
    verified_facts: [],
    model_inferences: [],
    coaching_suggestions: [],
    crisis_response: {
      message: copy.message,
      resources: copy.resources.map((resource) => ({ ...resource })),
      disclaimer: copy.disclaimer,
    },
    ai_disclosure: {
      session_disclosure: "This is a deterministic safety response, not an AI-generated message.",
      model_disclosure: "No AI model was used for this response.",
    },
  };
}

function crisisResourceLine(resource) {
  const details = [resource.contact, resource.description].map((v) => String(v || "").trim()).filter(Boolean).join(" — ");
  return `- **${String(resource.name || "").trim()}:** ${details}`;
}

// The crisis reply with every resource written into the text itself.
export function renderCrisisText(locale = "en-US") {
  const copy = crisisCopy(locale);
  return [
    copy.message,
    copy.resources.map(crisisResourceLine).join("\n"),
    copy.adult,
    `_${copy.disclaimer}_`,
  ].join("\n\n");
}

// The one deterministic crisis reply /api/chat and /api/council/convene
// send. The chat route used to send the hotlines only in `actions`, as
// {name, contact} objects, with no topic_type: the client's formatter showed
// actions only on regulated turns (and would have printed "[object Object]"),
// so a student the server caught saw "Please reach out to one of these
// resources:" and nothing after it, and the turn ran on through the
// specialists and the supervisor as an ordinary answer. The answer text now
// carries the full list, and crisisSafe plus topic_type "crisis" let every
// client path recognize the reply before it parses or merges anything.
export function buildCrisisChatReply(locale = "en-US") {
  const loc = locale === "ko" ? "ko" : "en-US";
  const built = buildCrisisResponse(loc);
  const text = renderCrisisText(loc);
  return {
    answer: text,
    topic_type: "crisis",
    crisisSafe: true,
    locale: loc,
    claims: [],
    limitations: [built.crisis_response.disclaimer],
    actions: built.crisis_response.resources,
    usage: { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
    content: [{ type: "text", text }],
    ai_disclosure: built.ai_disclosure,
    _meta: { deterministic: true, topicType: "CRISIS", modelTier: "NONE" },
  };
}

// Appended to an answer whose question names suicide, self-harm or overdose
// as a topic ("our suicide prevention club needs a fundraiser idea"). The
// question is answered, and the safety net is never silently dropped. The
// wording stays clear of the crisis lexicon, because the client sends drafts
// that carry it back through /api/chat.
const CRISIS_TOPIC_FOOTERS = Object.freeze({
  "en-US": "\n\n_If this topic is close to home for you, support is available any time: call or text 988, or text HOME to 741741. If you are in immediate danger, call 911._",
  ko: "\n\n_이 주제가 개인적으로 와닿는다면 언제든 도움을 받을 수 있어요: 109(24시간 상담)나 청소년상담전화 1388에 연락하고, 위급하면 119나 112에 전화하세요. 미국에 있다면 988에 전화나 문자를 하거나 741741로 HOME을 보내세요._",
});

export function crisisResourceFooter(locale = "en-US") {
  return locale === "ko" ? CRISIS_TOPIC_FOOTERS.ko : CRISIS_TOPIC_FOOTERS["en-US"];
}
