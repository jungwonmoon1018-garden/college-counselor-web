// ═══════════════════════════════════════════════════════════
// TESTS: Rules Engine
// ═══════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FAFSA_RULESETS,
  fafsaRulesetStatus,
  selectFafsaRuleset,
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
import { daysUntilDue } from "../shared/calendar-date.js";

describe("runFAFSAEligibilityCheck", () => {
  // Rules are keyed by rule id with boolean values; required rules must all
  // be true for eligible === true (results carry per-rule status + source).
  // Every call reads a fixed clock inside the 2026-27 ruleset's window: on
  // the real clock four of these went red on 2027-07-01, when that ruleset
  // lapsed and the check answered "no ruleset" (tests/clock-independence
  // runs this file on that date).
  const now = new Date("2026-11-03T12:00:00.000Z");

  it("passes all checks for eligible student", () => {
    const result = runFAFSAEligibilityCheck({
      citizenship: true,
      ssn: true,
      enrollment: true,
      high_school_completion: true,
      satisfactory_progress: true,
      not_in_default: true,
    }, { now });
    assert.equal(result.eligible, true);
    assert.equal(result.results.filter((r) => r.status === "fail").length, 0);
  });

  it("fails for non-citizen without eligible status", () => {
    const result = runFAFSAEligibilityCheck({
      citizenship: false,
      ssn: true,
      enrollment: true,
      high_school_completion: true,
    }, { now });
    assert.equal(result.eligible, false);
    assert.ok(result.results.some((r) => r.status === "fail"));
  });

  it("returns unknown for missing data", () => {
    const result = runFAFSAEligibilityCheck({}, { now });
    assert.ok(result.results.some((r) => r.status === "unknown"));
    assert.equal(result.eligible, null);
  });

  it("includes source URLs for every rule", () => {
    const result = runFAFSAEligibilityCheck({ citizenship: true }, { now });
    // An empty list would pass the loop below vacuously.
    assert.ok(result.results.length > 0);
    for (const rule of result.results) {
      assert.ok(rule.source, `Rule ${rule.ruleId} missing source URL`);
    }
  });

  it("does not treat Selective Service registration as an eligibility requirement", () => {
    const result = runFAFSAEligibilityCheck({ selective_service: false }, { now });
    assert.equal(result.results.some((rule) => rule.ruleId === "selective_service"), false);
    assert.ok(result.removedRequirements.some((rule) => rule.id === "selective_service"));
    assert.notEqual(result.eligible, false);
  });

  // The ruleset is chosen by date; the test reads a fixed clock, so it
  // does not turn red on the day a ruleset lapses (the admin status and the
  // boot line carry that warning instead).
  it("versions every FAFSA rule with the ruleset that covers the date", () => {
    const ruleset = selectFafsaRuleset(now);
    const result = runFAFSAEligibilityCheck({}, { now });
    assert.equal(result.academicYear, ruleset.academicYear);
    assert.ok(Date.parse(result.effectiveAt) < Date.parse(result.expiresAt));
    assert.ok(Date.parse(result.expiresAt) > now.getTime());
    for (const rule of result.results) {
      assert.equal(rule.academicYear, result.academicYear);
      assert.equal(rule.expiresAt, result.expiresAt);
      assert.equal(rule.sourceDomain, "fsapartners.ed.gov");
    }
  });
});

// time-4 / debt-4: one hard-coded 2026-27 record lost every verified rule on
// 2027-07-01 with no warning. Rulesets are keyed by award year and chosen
// by date; when none covers the date the question goes to the model as
// labeled general guidance, never to an empty verified lane.
describe("FAFSA rulesets", () => {
  const day = 24 * 60 * 60 * 1000;
  const sample = Object.freeze([
    { id: "a", academicYear: "2030-2031", effectiveAt: "2030-07-01T00:00:00.000Z", expiresAt: "2031-06-30T23:59:59.999Z", sourceUrl: "https://fsapartners.ed.gov/a", sourceTitle: "A", sourceDomain: "fsapartners.ed.gov" },
    { id: "b", academicYear: "2031-2032", effectiveAt: "2031-07-01T00:00:00.000Z", expiresAt: "2032-06-30T23:59:59.999Z", sourceUrl: "https://fsapartners.ed.gov/b", sourceTitle: "B", sourceDomain: "fsapartners.ed.gov" },
  ]);

  it("keeps every ruleset dated and sourced", () => {
    assert.ok(FAFSA_RULESETS.length >= 1);
    for (const ruleset of FAFSA_RULESETS) {
      assert.match(ruleset.academicYear, /^\d{4}-\d{4}$/);
      assert.ok(Date.parse(ruleset.effectiveAt) < Date.parse(ruleset.expiresAt), ruleset.id);
      assert.match(ruleset.sourceUrl, /^https:\/\/(?:fsapartners\.ed\.gov|studentaid\.gov)\//);
      assert.ok(ruleset.sourceTitle);
    }
  });

  it("prefers the award year whose FAFSA opened most recently, then the one in effect", () => {
    // Before the newer form opens (October 1), the ruleset in effect.
    assert.equal(selectFafsaRuleset(new Date("2030-09-15T00:00:00Z"), sample).id, "a");
    // From October 1 the newer form is open: seniors file it.
    assert.equal(selectFafsaRuleset(new Date("2030-10-02T00:00:00Z"), sample).id, "b");
    assert.equal(selectFafsaRuleset(new Date("2031-08-01T00:00:00Z"), sample).id, "b");
    assert.equal(selectFafsaRuleset(new Date("2032-07-01T00:00:00Z"), sample), null);
    assert.equal(selectFafsaRuleset(new Date("2029-01-01T00:00:00Z"), sample), null);
  });

  it("hands an uncovered date to the general-guidance path instead of an empty checklist", () => {
    const result = runFAFSAEligibilityCheck({}, { now: new Date("2032-07-02T00:00:00Z"), rulesets: sample });
    assert.equal(result.available, false);
    assert.deepEqual(result.results, []);
    assert.match(result.message, /^No deterministic rule is available/);
  });

  it("says which handbook the checklist comes from when the open form is a newer year", () => {
    const now = new Date("2030-11-03T00:00:00Z");
    const result = runFAFSAEligibilityCheck({}, { now, rulesets: [sample[0]] });
    assert.equal(result.available, true);
    assert.match(result.summary, /2030-2031/);
    assert.match(result.summary, /2031-2032 FAFSA/);
    assert.equal(result.eligible, null);
  });

  it("reports days left and warns from 60 days before the newest ruleset expires", () => {
    const expiry = Date.parse(sample[1].expiresAt);
    const early = fafsaRulesetStatus(new Date(expiry - 120 * day), sample);
    assert.equal(early.warning, null);
    assert.deepEqual(early.rulesets.map((r) => Object.keys(r).sort()), [["academicYear", "daysLeft", "expiresAt", "id"], ["academicYear", "daysLeft", "expiresAt", "id"]]);
    assert.equal(early.rulesets[1].daysLeft, 120);
    const late = fafsaRulesetStatus(new Date(expiry - 59 * day), sample);
    assert.equal(late.rulesets[1].daysLeft, 59);
    assert.match(late.warning, /2031-2032.*59 day/);
    const lapsed = fafsaRulesetStatus(new Date(expiry + day), sample);
    assert.equal(lapsed.current, null);
    assert.match(lapsed.warning, /No FAFSA eligibility ruleset covers/);
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

  // The chat's count agrees with the tracker's: 0 on the due date, negative
  // only once the date has ended Anywhere on Earth (UTC-12). Math.ceil of
  // milliseconds from UTC midnight called a Jan 1 deadline passed at 00:30
  // UTC on Jan 2, which is still Jan 1 in New York.
  it("counts calendar days the way the deadline tracker does", () => {
    const on = (iso) => ({ now: new Date(iso) });
    const dueToday = calculateDeadlineStatus("2027-01-01", "regular_decision", on("2027-01-02T00:30:00Z"));
    assert.equal(dueToday.daysRemaining, 0);
    assert.equal(dueToday.status, "imminent");
    assert.equal(dueToday.deadlineDate, "2027-01-01");
    assert.equal(dueToday.message, "The regular decision deadline is today.");
    assert.equal(calculateDeadlineStatus("2027-01-01", "regular_decision", on("2027-01-02T11:59:00Z")).daysRemaining, 0);
    const passed = calculateDeadlineStatus("2027-01-01", "regular_decision", on("2027-01-02T12:00:00Z"));
    assert.equal(passed.daysRemaining, -1);
    assert.equal(passed.status, "passed");
    // The student's own date, when the client names it, is counted from.
    assert.equal(calculateDeadlineStatus("2027-01-01", "early_action", { now: new Date("2027-01-02T00:30:00Z"), today: "2027-01-02" }).status, "passed");
    // An older client's UTC-midnight instant is the date it was typed as.
    assert.equal(calculateDeadlineStatus("2027-01-01T00:00:00.000Z", "regular_decision", on("2027-01-02T00:30:00Z")).daysRemaining, 0);
    // A written-out date names the day too.
    assert.equal(calculateDeadlineStatus("November 1, 2026", "early_decision", on("2026-10-29T12:00:00Z")).deadlineDate, "2026-11-01");
    assert.equal(calculateDeadlineStatus("not a date").status, "invalid");

    for (const nowIso of ["2026-11-03T00:00:00Z", "2026-11-03T11:59:00Z", "2026-11-03T12:00:00Z", "2026-11-03T23:30:00Z"]) {
      const nowMs = Date.parse(nowIso);
      for (const due of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-12-01", "2026-11-05T04:59:00.000Z"]) {
        assert.equal(calculateDeadlineStatus(due, "regular_decision", { now: new Date(nowMs) }).daysRemaining, daysUntilDue(due, { nowMs }), `${due} at ${nowIso}`);
      }
    }
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
