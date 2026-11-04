// ═══════════════════════════════════════════════════════════
// TESTS: Answer Composer
// ═══════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeAnswer, composeDeterministicAnswer, questionConcernsSubIntent } from "../chat/answer-composer.js";
import { runFAFSAEligibilityCheck, selectFafsaRuleset } from "../chat/rules-engine.js";

describe("composeDeterministicAnswer", () => {
  it("composes FAFSA eligibility answer", () => {
    const result = composeDeterministicAnswer({
      classification: { topicType: "REGULATED", subIntent: "fafsa_eligibility" },
      result: {
        eligible: true,
        rules: [
          { id: "citizenship", status: "pass", message: "U.S. citizen", source: "https://studentaid.gov" },
        ],
        failedRules: [],
        unknownRules: [],
      },
      locale: "en-US",
    });

    assert.ok(result.verified_facts);
    assert.ok(result.verified_facts.some((fact) => fact.statement === "U.S. citizen"));
    assert.ok(result.claims.some((claim) => claim.lane === "verified_fact"));
    assert.ok(result.ai_disclosure);
    assert.ok(result.ai_disclosure.advisory_disclosure);
  });

  it("includes Korean disclosure for ko locale", () => {
    const result = composeDeterministicAnswer({
      classification: { topicType: "REGULATED", subIntent: "fafsa_eligibility" },
      result: { eligible: true, rules: [], failedRules: [], unknownRules: [] },
      locale: "ko",
    });
    assert.ok(result.ai_disclosure);
  });

  it("composes deadline status answer", () => {
    const result = composeDeterministicAnswer({
      classification: { topicType: "HIGH_STAKES", subIntent: "deadline_status" },
      result: { status: "upcoming", daysRemaining: 30, deadline: "2026-05-01" },
      locale: "en-US",
    });
    assert.ok(result.verified_facts);
  });
});

describe("composeAnswer", () => {
  it("composes regulated answer with verified facts only", () => {
    const result = composeAnswer({
      classification: { topicType: "REGULATED", subIntent: "fafsa" },
      evidence: [
        { fact_key: "fafsa_deadline", fact_value: "June 30, 2027", source_url: "https://studentaid.gov", confidence: "verified", trust_level: "official" },
      ],
      modelOutput: null,
      locale: "en-US",
    });

    assert.ok(result.verified_facts.length > 0);
    assert.ok(result.ai_disclosure);
    assert.ok(result.explanation);
  });

  it("includes no-verified-answer for regulated topics without evidence", () => {
    const result = composeAnswer({
      classification: { topicType: "REGULATED", subIntent: "fafsa" },
      evidence: [],
      modelOutput: null,
      locale: "en-US",
    });

    assert.ok(result.no_verified_answer || result.verified_facts.length === 0);
  });

  it("composes coaching answer with three lanes", () => {
    const result = composeAnswer({
      classification: { topicType: "COACHING", subIntent: "essay" },
      evidence: [
        { claim: "Your essay could focus on personal growth", grounding: "Based on your activities", trust_level: "inferred" },
      ],
      modelOutput: { text: "Consider the Common App prompt about challenges", model: "claude-3-haiku" },
      locale: "en-US",
    });

    assert.ok(result.model_inferences || result.coaching_suggestions);
    assert.ok(result.ai_disclosure);
  });

  it("always includes explanation object", () => {
    const result = composeAnswer({
      classification: { topicType: "COACHING", subIntent: "ec_strategy" },
      evidence: [],
      modelOutput: null,
      locale: "en-US",
    });

    assert.ok(result.explanation);
    assert.ok(result.explanation.routing || result.explanation.model_tier !== undefined);
  });

  it("never promotes a model paragraph to a verified claim", () => {
    const result = composeAnswer({
      classification: { topicType: "regulated", subIntent: "fafsa" },
      evidence: [{
        id: "fafsa-source",
        fact_key: "fafsa_eligibility",
        fact_value: "Students must meet federal eligibility requirements.",
        source_url: "https://studentaid.gov",
        source_domain: "studentaid.gov",
        confidence: "verified",
        trust_level: "official",
        expires_at: "2099-01-01T00:00:00.000Z",
      }],
      modelOutput: { text: "You definitely qualify for aid.", model: "test-model" },
    });
    assert.equal(
      result.claims.find((claim) => claim.statement === "You definitely qualify for aid.").lane,
      "coaching_suggestion",
    );
    assert.equal(result.verified_facts.some((fact) => fact.statement.includes("definitely qualify")), false);
  });

  it("does not label expired evidence as verified", () => {
    const result = composeAnswer({
      classification: { topicType: "regulated", subIntent: "fafsa" },
      evidence: [{
        fact_key: "fafsa_eligibility",
        fact_value: "Expired rule",
        source_url: "https://studentaid.gov",
        source_domain: "studentaid.gov",
        confidence: "verified",
        trust_level: "official",
        expires_at: "2000-01-01T00:00:00.000Z",
      }],
    });
    assert.equal(result.verified_facts.length, 0);
    assert.equal(result.no_verified_answer, true);
  });

  it("adds the official-source follow-up only when the question is about that source's domain", () => {
    const base = {
      classification: { topicType: "regulated", subIntent: "financial_aid_policy" },
      evidence: [],
      modelOutput: { text: "Biomedical engineering programs value physics and calculus; here is a plan.", model: "test-model" },
    };
    // A coaching question the classifier filed under aid: no StudentAid.gov footer.
    const offTopic = composeAnswer({ ...base, questionText: "I want to study biomedical engineering. What should I do this year?" });
    assert.deepEqual(offTopic.actions, []);
    // The same classification on a question that is about aid keeps it.
    const onTopic = composeAnswer({ ...base, questionText: "Is Hopkins need-blind, and what financial aid policy applies to me?" });
    assert.equal(onTopic.actions.length, 1);
    assert.equal(onTopic.actions[0].label, "StudentAid.gov");
    // Older callers that do not pass the question, and deterministic answers, are unchanged.
    assert.equal(composeAnswer(base).actions.length, 1);
    const deterministic = composeAnswer({ ...base, modelOutput: null, questionText: "biomedical engineering plan" });
    assert.equal(deterministic.actions.length, 1);
  });

  // gate-11: legal_compliance had no topic pattern, so every answer the
  // classifier filed there ended with "The relevant official source".
  it("knows when a question is about law or compliance", () => {
    assert.equal(questionConcernsSubIntent("legal_compliance", "I interned at a law firm"), false);
    assert.equal(questionConcernsSubIntent("legal_compliance", "Is my school in compliance with Title IX?"), true);
    assert.equal(questionConcernsSubIntent("legal_compliance", "What are my legal rights if the school loses my transcript?"), true);
  });
});

describe("the FAFSA checklist in the composed answer", () => {
  const classification = { topicType: "regulated", subIntent: "eligibility" };
  // A fixed clock inside the 2026-27 ruleset's window, so the test does not
  // turn red on the day that ruleset lapses.
  const now = new Date("2026-11-03T12:00:00.000Z");

  // The rule text is official and verified only while its ruleset is
  // current; the expiry check is the guardrail and stays.
  it("lists each rule of the current ruleset as a verified fact with its source", () => {
    const ruleset = selectFafsaRuleset(now);
    assert.ok(ruleset);
    const composed = composeDeterministicAnswer({ classification, result: runFAFSAEligibilityCheck({}, { now }), now });
    assert.ok(composed.verified_facts.length >= 5);
    assert.ok(composed.verified_facts.every((fact) => fact.source?.url && fact.source.academicYear === ruleset.academicYear));
    assert.equal(composed.no_verified_answer, false);
  });

  it("never stamps a rule as verified once its ruleset has expired", () => {
    const result = runFAFSAEligibilityCheck({}, { now });
    const afterExpiry = new Date(Date.parse(result.expiresAt) + 24 * 60 * 60 * 1000);
    const composed = composeDeterministicAnswer({ classification, result, now: afterExpiry });
    assert.equal(composed.verified_facts.length, 0);
  });

  // "Citizenship: unknown" was filed as a fact "calculated from information
  // supplied by the student" when the student had supplied nothing.
  it("files only what the student supplied in the student lane", () => {
    const blank = composeDeterministicAnswer({ classification, result: runFAFSAEligibilityCheck({}, { now }), now });
    assert.equal(blank.claims.filter((claim) => claim.lane === "student_provided_fact").length, 0);
    const partial = composeDeterministicAnswer({ classification, result: runFAFSAEligibilityCheck({ citizenship: true }, { now }), now });
    const student = partial.claims.filter((claim) => claim.lane === "student_provided_fact").map((claim) => claim.statement);
    assert.equal(student.length, 1);
    assert.match(student[0], /Citizenship.*: pass/);
  });
});
