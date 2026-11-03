// ═══════════════════════════════════════════════════════════
// TESTS: Rules Engine
// ═══════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runFAFSAEligibilityCheck,
  calculateDeadlineStatus,
  runDocumentCompletenessCheck,
  computePercentile,
  computeAPRigorIndex,
  estimateNetPrice,
  evaluateComplianceGate,
  buildCrisisResponse,
  buildCrisisChatReply,
  renderCrisisText,
  crisisResourceFooter,
} from "../chat/rules-engine.js";

describe("runFAFSAEligibilityCheck", () => {
  // Rules are keyed by rule id with boolean values; required rules must all
  // be true for eligible === true (results carry per-rule status + source).
  it("passes all checks for eligible student", () => {
    const result = runFAFSAEligibilityCheck({
      citizenship: true,
      ssn: true,
      enrollment: true,
      high_school_completion: true,
      satisfactory_progress: true,
      not_in_default: true,
    });
    assert.equal(result.eligible, true);
    assert.equal(result.results.filter((r) => r.status === "fail").length, 0);
  });

  it("fails for non-citizen without eligible status", () => {
    const result = runFAFSAEligibilityCheck({
      citizenship: false,
      ssn: true,
      enrollment: true,
      high_school_completion: true,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.results.some((r) => r.status === "fail"));
  });

  it("returns unknown for missing data", () => {
    const result = runFAFSAEligibilityCheck({});
    assert.ok(result.results.some((r) => r.status === "unknown"));
    assert.equal(result.eligible, null);
  });

  it("includes source URLs for every rule", () => {
    const result = runFAFSAEligibilityCheck({ citizenship: true });
    for (const rule of result.results) {
      assert.ok(rule.source, `Rule ${rule.ruleId} missing source URL`);
    }
  });

  it("does not treat Selective Service registration as an eligibility requirement", () => {
    const result = runFAFSAEligibilityCheck({ selective_service: false });
    assert.equal(result.results.some((rule) => rule.ruleId === "selective_service"), false);
    assert.ok(result.removedRequirements.some((rule) => rule.id === "selective_service"));
    assert.notEqual(result.eligible, false);
  });

  it("versions every FAFSA rule with an academic year and lifecycle", () => {
    const result = runFAFSAEligibilityCheck({});
    assert.equal(result.academicYear, "2026-2027");
    assert.ok(Date.parse(result.effectiveAt) < Date.parse(result.expiresAt));
    for (const rule of result.results) {
      assert.equal(rule.academicYear, result.academicYear);
      assert.equal(rule.expiresAt, result.expiresAt);
      assert.equal(rule.sourceDomain, "fsapartners.ed.gov");
    }
  });
});

describe("calculateDeadlineStatus", () => {
  it("returns passed for past dates", () => {
    const result = calculateDeadlineStatus("2020-01-01");
    assert.equal(result.status, "passed");
  });

  it("returns a future status for far-out dates", () => {
    const futureDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = calculateDeadlineStatus(futureDate);
    assert.ok(["approaching", "upcoming", "future"].includes(result.status));
  });

  it("returns imminent for dates within 7 days", () => {
    const soonDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = calculateDeadlineStatus(soonDate);
    assert.equal(result.status, "imminent");
  });

  it("includes days remaining", () => {
    const futureDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = calculateDeadlineStatus(futureDate);
    assert.ok(typeof result.daysRemaining === "number");
    assert.ok(result.daysRemaining > 0);
  });
});

describe("runDocumentCompletenessCheck", () => {
  it("identifies missing required documents for common_app", () => {
    const result = runDocumentCompletenessCheck("common_app", ["personal_essay"]);
    assert.equal(result.complete, false);
    assert.ok(result.missingCount > 0);
  });

  it("returns complete when all required docs submitted", () => {
    const result = runDocumentCompletenessCheck("common_app", [
      "personal_essay", "activities_list", "demographics", "education_section", "testing",
    ]);
    assert.equal(result.complete, true);
    assert.equal(result.missingCount, 0);
  });

  it("identifies missing FAFSA documents", () => {
    const result = runDocumentCompletenessCheck("fafsa", ["fsa_id"]);
    assert.ok(result.missingCount > 0);
  });
});

describe("computePercentile", () => {
  const distribution = [
    { percentile: 10, score: 800 },
    { percentile: 25, score: 950 },
    { percentile: 50, score: 1060 },
    { percentile: 75, score: 1200 },
    { percentile: 90, score: 1350 },
    { percentile: 99, score: 1550 },
  ];

  it("returns correct percentile for exact match", () => {
    const result = computePercentile(distribution, 1060, "score");
    assert.equal(result, 50);
  });

  it("interpolates between brackets", () => {
    const result = computePercentile(distribution, 1130, "score");
    assert.ok(result > 50 && result < 75);
  });

  it("returns null for empty distribution", () => {
    assert.equal(computePercentile([], 1000, "score"), null);
  });

  it("handles value below lowest bracket", () => {
    const result = computePercentile(distribution, 600, "score");
    assert.ok(result <= 10);
  });

  it("handles value above highest bracket", () => {
    const result = computePercentile(distribution, 1600, "score");
    assert.ok(result >= 99);
  });
});

describe("computeAPRigorIndex", () => {
  it("returns 0 for no AP courses", () => {
    const result = computeAPRigorIndex([], null);
    assert.equal(result.index, 0);
  });

  it("computes index for AP courses", () => {
    const courses = [
      { name: "AP Calculus BC", type: "ap" },
      { name: "AP Physics C", type: "ap" },
      { name: "AP English Literature", type: "ap" },
    ];
    const result = computeAPRigorIndex(courses, null);
    assert.ok(result.index > 0);
  });
});

describe("buildCrisisResponse", () => {
  it("returns English crisis resources by default", () => {
    const result = buildCrisisResponse("en-US");
    assert.ok(result.crisis_response.resources.length > 0);
    assert.ok(result.crisis_response.resources.some((r) => r.contact === "988"));
  });

  // Korea folded 1393 and its other counseling lines into 109 in January
  // 2024. Korean comes first, then the US lines for a student abroad.
  it("returns Korean crisis resources for ko locale, Korean lines first", () => {
    const contacts = buildCrisisResponse("ko").crisis_response.resources.map((r) => r.contact);
    assert.deepEqual(contacts.slice(0, 4), ["109", "1388", "119", "112"]);
    for (const us of ["911", "988", "Text HOME to 741741", "1-800-422-4453"]) assert.ok(contacts.includes(us), us);
    assert.ok(!contacts.includes("1393"));
    assert.ok(!contacts.includes("1577-0199"));
  });

  it("lists 911, 988, 741741 and Childhelp in English", () => {
    const contacts = buildCrisisResponse("en-US").crisis_response.resources.map((r) => r.contact);
    assert.deepEqual(contacts, ["911", "988", "Text HOME to 741741", "1-800-422-4453"]);
  });
});

// The chat reply used to carry the hotlines only in `actions`, which the
// client dropped: the student saw one sentence ending in a colon.
describe("buildCrisisChatReply", () => {
  it("writes every resource into the answer text and marks the reply as crisis", () => {
    for (const locale of ["en-US", "ko"]) {
      const reply = buildCrisisChatReply(locale);
      assert.equal(reply.topic_type, "crisis");
      assert.equal(reply.crisisSafe, true);
      assert.equal(reply._meta.topicType, "CRISIS");
      assert.equal(reply._meta.deterministic, true);
      assert.equal(reply.answer, renderCrisisText(locale));
      assert.equal(reply.content[0].text, reply.answer);
      for (const resource of reply.actions) {
        assert.ok(reply.answer.includes(resource.contact), `${locale} answer lists ${resource.contact}`);
      }
      assert.ok(!/\[object Object\]/.test(reply.answer));
      assert.ok(!/:\s*$/.test(reply.answer), "the reply never ends on a dangling colon");
      assert.deepEqual(reply.usage, { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 });
    }
    assert.match(buildCrisisChatReply("ko").answer, /109[\s\S]*1388[\s\S]*119[\s\S]*112[\s\S]*988/);
  });

  it("falls back to English for any other locale", () => {
    assert.equal(buildCrisisChatReply("es").answer, renderCrisisText("en-US"));
  });

  it("has a topic footer with 988 and 741741 in both locales", () => {
    assert.match(crisisResourceFooter("en-US"), /988[\s\S]*741741/);
    assert.match(crisisResourceFooter("ko"), /109[\s\S]*1388[\s\S]*988[\s\S]*741741/);
  });
});

describe("estimateNetPrice", () => {
  it("estimates net price for a college", () => {
    const result = estimateNetPrice(
      { tuition_in: 15000, tuition_out: 35000, avg_net_price: 18000 },
      60000,
      true
    );
    assert.ok(typeof result.estimatedNetPrice === "number");
  });
});

describe("evaluateComplianceGate", () => {
  it("passes gate when verified evidence exists for regulated topic", () => {
    const result = evaluateComplianceGate("regulated", [
      { source_domain: "studentaid.gov", confidence: "verified", trust_level: "official" },
    ]);
    assert.equal(result.allowed, true);
    assert.ok(result.verifiedCount > 0);
  });

  it("fails gate when no evidence for regulated topic", () => {
    const result = evaluateComplianceGate("regulated", []);
    assert.equal(result.allowed, false);
  });
});
