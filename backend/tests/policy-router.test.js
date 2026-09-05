// ═══════════════════════════════════════════════════════════
// TESTS: Policy Router
// ═══════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTopic,
  enforceGates,
  isLookupQuestion,
  selectModelTier,
  canHandleDeterministically,
  routeRequest,
  TOPIC_TYPES,
  MODEL_TIERS,
} from "../policy-router.js";

describe("classifyTopic", () => {
  it("classifies FAFSA queries as REGULATED", () => {
    const result = classifyTopic("How do I fill out my FAFSA?");
    assert.equal(result.topicType, TOPIC_TYPES.REGULATED);
    assert.equal(result.subIntent, "fafsa");
  });

  it("classifies FERPA queries as REGULATED", () => {
    const result = classifyTopic("What are my FERPA rights?");
    assert.equal(result.topicType, TOPIC_TYPES.REGULATED);
    assert.equal(result.subIntent, "ferpa");
  });

  it("classifies deadline queries as HIGH_STAKES", () => {
    const result = classifyTopic("When is the MIT early action deadline?");
    assert.equal(result.topicType, TOPIC_TYPES.HIGH_STAKES);
  });

  it("classifies essay questions as COACHING", () => {
    const result = classifyTopic("Can you help me brainstorm essay topics?");
    assert.equal(result.topicType, TOPIC_TYPES.COACHING);
  });

  it("classifies crisis language as CRISIS", () => {
    const result = classifyTopic("I want to end my life");
    assert.equal(result.topicType, TOPIC_TYPES.CRISIS);
  });

  it("defaults unmatched questions to COACHING (general)", () => {
    // No crisis/regulated/high-stakes/coaching keyword → falls through to the
    // evidence-grounded coaching default (subIntent "general").
    const result = classifyTopic("What time does the office open?");
    assert.equal(result.topicType, TOPIC_TYPES.COACHING);
    assert.equal(result.subIntent, "general");
  });

  it("returns confidence score", () => {
    const result = classifyTopic("FAFSA eligibility requirements");
    assert.ok(typeof result.confidence === "number");
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  });
});

describe("enforceGates", () => {
  it("allows a REGULATED topic with no verified evidence as labeled general guidance", () => {
    const result = enforceGates(TOPIC_TYPES.REGULATED, "fafsa", []);
    assert.equal(result.allowed, true);
    assert.equal(result.fallback, null);
    assert.ok(result.generalGuidance);
    assert.equal(result.generalGuidance.unverified, true);
    assert.ok(result.generalGuidance.suggestedSource?.url?.includes("studentaid.gov"));
    assert.ok(result.gates.some((g) => g.gate === "no_source_no_answer" && g.action === "allow_unverified_general_guidance"));
    assert.ok(result.gates.some((g) => g.gate === "advisory_only_disclosure" && g.passed === true));
  });

  it("still blocks a HIGH_STAKES topic with no verified evidence (no-source-no-answer)", () => {
    const result = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", []);
    assert.equal(result.allowed, false);
    assert.ok(result.fallback);
    assert.ok(result.gates.some((g) => g.gate === "no_source_no_answer" && g.passed === false));
  });

  it("allows COACHING topics with no fallback", () => {
    const result = enforceGates(TOPIC_TYPES.COACHING, "essay", []);
    assert.equal(result.allowed, true);
    assert.equal(result.fallback, null);
    assert.ok(result.gates.some((g) => g.gate === "coaching_label" && g.passed === true));
  });

  it("allows a REGULATED topic once verified evidence exists", () => {
    const result = enforceGates(TOPIC_TYPES.REGULATED, "fafsa", [{
      fact_key: "fafsa_eligibility",
      confidence: "verified",
      trust_level: "official",
      source_url: "https://studentaid.gov/apply-for-aid/fafsa",
      source_domain: "studentaid.gov",
      expires_at: "2099-01-01T00:00:00.000Z",
    }]);
    assert.equal(result.allowed, true);
    assert.ok(result.gates.some((g) => g.gate === "source_verification" && g.passed === true));
  });

  it("rejects extracted, expired, and irrelevant evidence as verification", () => {
    const common = {
      fact_key: "fafsa_eligibility",
      source_url: "https://studentaid.gov",
      source_domain: "studentaid.gov",
      trust_level: "official",
    };
    // Non-verified evidence must never pass source verification. For REGULATED
    // topics that now means general-guidance mode (allowed, labeled
    // unverified) rather than a hard block.
    const extracted = enforceGates(TOPIC_TYPES.REGULATED, "fafsa", [
      { ...common, confidence: "extracted" },
    ]);
    assert.ok(extracted.generalGuidance);
    assert.ok(!extracted.gates.some((g) => g.gate === "source_verification" && g.passed === true));
    const expired = enforceGates(TOPIC_TYPES.REGULATED, "fafsa", [
      { ...common, confidence: "verified", expires_at: "2000-01-01T00:00:00.000Z" },
    ]);
    assert.ok(expired.generalGuidance);
    assert.ok(!expired.gates.some((g) => g.gate === "source_verification" && g.passed === true));
    assert.equal(enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", [
      { ...common, confidence: "verified", expires_at: "2099-01-01T00:00:00.000Z" },
    ]).allowed, false);
  });
});

describe("selectModelTier", () => {
  it("returns NONE for deterministic regulated topics", () => {
    const tier = selectModelTier(TOPIC_TYPES.REGULATED, "fafsa_eligibility", "simple");
    assert.equal(tier, MODEL_TIERS.NONE);
  });

  it("returns the cheapest tier for general coaching", () => {
    const tier = selectModelTier(TOPIC_TYPES.COACHING, "general", "simple");
    assert.equal(tier, MODEL_TIERS.HAIKU);
  });

  it("convenes Council only after an explicit action", () => {
    assert.equal(selectModelTier(TOPIC_TYPES.COACHING, "essay", "complex"), MODEL_TIERS.SONNET);
    assert.equal(
      selectModelTier(TOPIC_TYPES.COACHING, "essay", "complex", null, { explicitCouncil: true }),
      MODEL_TIERS.COUNCIL,
    );
  });

  it("does not escalate cost without a separate budget approval", () => {
    const tier = selectModelTier(TOPIC_TYPES.REGULATED, "fafsa", "complex", { tier: MODEL_TIERS.SONNET, confidence: 0.2 });
    assert.equal(tier, MODEL_TIERS.SONNET);
    assert.equal(selectModelTier(
      TOPIC_TYPES.REGULATED,
      "fafsa",
      "complex",
      { tier: MODEL_TIERS.SONNET, confidence: 0.2 },
      { allowPaidEscalation: true, budgetApproved: true },
    ), MODEL_TIERS.OPUS);
  });
});

describe("canHandleDeterministically", () => {
  it("returns true for FAFSA eligibility", () => {
    assert.ok(canHandleDeterministically(TOPIC_TYPES.REGULATED, "fafsa"));
    assert.ok(canHandleDeterministically(TOPIC_TYPES.REGULATED, "eligibility"));
  });

  it("returns true for deadline status", () => {
    assert.ok(canHandleDeterministically(TOPIC_TYPES.HIGH_STAKES, "deadlines"));
  });

  it("returns false for essay coaching", () => {
    assert.equal(canHandleDeterministically(TOPIC_TYPES.COACHING, "essay"), false);
  });
});

describe("routeRequest", () => {
  it("returns a complete routing decision", () => {
    // Pass verified evidence so the regulated gate allows the full decision
    // shape (classification + gateResult + modelTier + isDeterministic).
    const result = routeRequest("Am I eligible for FAFSA?", {}, [{
      fact_key: "fafsa_eligibility",
      fact_value: "Eligibility depends on federal requirements.",
      confidence: "verified",
      trust_level: "official",
      source_url: "https://studentaid.gov",
      source_domain: "studentaid.gov",
      expires_at: "2099-01-01T00:00:00.000Z",
    }]);
    assert.ok(result.classification.topicType);
    assert.ok(typeof result.isDeterministic === "boolean");
    assert.ok(result.gateResult);
    assert.ok(result.modelTier);
  });

  it("routes crisis to deterministic with no model", () => {
    const result = routeRequest("I want to hurt myself");
    assert.equal(result.classification.topicType, TOPIC_TYPES.CRISIS);
    assert.equal(result.modelTier, MODEL_TIERS.NONE);
  });

  it("routes a general FAFSA question to labeled synthesis instead of refusing", () => {
    const result = routeRequest("How does the FAFSA work?");
    assert.equal(result.classification.topicType, TOPIC_TYPES.REGULATED);
    assert.equal(result.isDeterministic, false);
    assert.equal(result.action, "model_synthesis");
    assert.equal(result.modelTier, MODEL_TIERS.SONNET);
    assert.ok(result.generalGuidance);
    assert.equal(result.generalGuidance.unverified, true);
  });

  it("keeps FAFSA eligibility questions on the deterministic rules engine", () => {
    const result = routeRequest("Am I eligible for FAFSA?");
    assert.equal(result.classification.topicType, TOPIC_TYPES.REGULATED);
    assert.equal(result.isDeterministic, true);
    assert.equal(result.action, "rules_engine");
  });

  it("does NOT treat a non-aid eligibility question as regulated at all", () => {
    // "eligible" without federal-aid context is an admissions or
    // scholarship question — coaching, never the FAFSA checker or the
    // regulated lane.
    const result = routeRequest("Am I eligible for Princeton with a 3.8 GPA?");
    assert.equal(result.classification.topicType, TOPIC_TYPES.COACHING);
    assert.notEqual(result.classification.subIntent, "eligibility");
    assert.ok(routeRequest("Am I eligible for a Pell Grant as a permanent resident?").classification.subIntent === "eligibility");
  });

  it("does not treat ordinary counseling words as regulated or high-stakes", () => {
    for (const [question, notType] of [
      ["I'm interested in legal studies — which APs help?", TOPIC_TYPES.REGULATED],
      ["My school records show a B in chemistry; how bad is that?", TOPIC_TYPES.REGULATED],
      ["Should I apply early decision or early action?", TOPIC_TYPES.HIGH_STAKES],
      ["How much time should I spend on essays each week?", TOPIC_TYPES.HIGH_STAKES],
      ["Should I mention my scholarship in the activities list?", TOPIC_TYPES.HIGH_STAKES],
    ]) {
      assert.notEqual(classifyTopic(question).topicType, notType, question);
    }
  });

  it("still recognizes the genuinely regulated and high-stakes forms", () => {
    assert.equal(classifyTopic("What are my rights to see my education records?").subIntent, "ferpa");
    assert.equal(classifyTopic("Is my school in compliance with Title IX?").topicType, TOPIC_TYPES.REGULATED);
    assert.equal(classifyTopic("When does the application close for Michigan?").subIntent, "deadlines");
    assert.equal(classifyTopic("When is the MIT early action deadline?").subIntent, "deadlines");
    assert.equal(classifyTopic("How much does tuition cost at UVA?").subIntent, "financial_amounts");
    assert.equal(classifyTopic("Is the Coca-Cola scholarship worth $20,000?").subIntent, "financial_amounts");
    assert.equal(classifyTopic("What is Stanford's acceptance rate?").subIntent, "official_stats");
  });

  it("refuses only a pure lookup about a named school; strategy questions get general guidance", () => {
    const lookup = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", [], { query: "When is Brown's early decision deadline?", schoolNamed: true });
    assert.equal(lookup.allowed, false);
    const strategy = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", [], { query: "Should I apply early decision to Brown given the deadline?", schoolNamed: true });
    assert.equal(strategy.allowed, true);
    assert.ok(strategy.generalGuidance);
    const noSchool = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", [], { query: "What are the deadlines this month?", schoolNamed: false });
    assert.equal(noSchool.allowed, true);
    const stats = enforceGates(TOPIC_TYPES.HIGH_STAKES, "official_stats", [], { query: "How much does the acceptance rate matter when I build my list?", schoolNamed: true });
    assert.equal(stats.allowed, true);
    const statLookup = enforceGates(TOPIC_TYPES.HIGH_STAKES, "official_stats", [], { query: "What is Yale's acceptance rate?", schoolNamed: true });
    assert.equal(statLookup.allowed, false);
  });

  it("tells a lookup from a guidance question", () => {
    for (const q of ["When is MIT's early action deadline?", "What is Stanford's acceptance rate?", "Brown ED deadline?", "Yale acceptance rate 2026"]) {
      assert.equal(isLookupQuestion(q, "deadlines"), true, q);
    }
    for (const q of ["Should I apply early decision to Brown?", "How do acceptance rates work?", "What does early action mean for my chances?", "Is a 4% acceptance rate realistic for me?", "I missed the deadline, what do I do?", "What's the typical ED deadline?"]) {
      assert.equal(isLookupQuestion(q, "deadlines"), false, q);
    }
    assert.equal(isLookupQuestion("When is MIT's deadline?", "financial_amounts"), false);
  });

  it("allows general cost/aid-amount questions as labeled guidance while deadlines stay gated", () => {
    const cost = enforceGates(TOPIC_TYPES.HIGH_STAKES, "financial_amounts", []);
    assert.equal(cost.allowed, true);
    assert.ok(cost.generalGuidance);
    const deadlines = enforceGates(TOPIC_TYPES.HIGH_STAKES, "deadlines", []);
    assert.equal(deadlines.allowed, false);
    const stats = enforceGates(TOPIC_TYPES.HIGH_STAKES, "official_stats", []);
    assert.equal(stats.allowed, false);
  });
});
