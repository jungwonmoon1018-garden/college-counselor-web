import test from "node:test";
import assert from "node:assert/strict";
import {
  compareFitInputs,
  verdictFromChecks,
  liveInputsFor,
  parseReviewReply,
  buildReviewMessages,
  verifyCollegeFit,
  formatVerificationLine,
  normalizeTestPolicyBucket,
} from "../fit-verifier.js";

const NOW = new Date("2026-09-03T12:00:00Z");
const used = { acceptanceRate: 3.6, sat25: 1510, sat75: 1580, act25: 34, act75: 36, testPolicy: "test_optional_or_deemphasized", source: "cds_store", cdsYear: 2024 };
const pages = [
  { url: "https://admission.example.edu/apply/first-year/testing.html", text: "Standardized Testing\nACT or SAT scores are required for first-year applicants entering in fall 2027.\nWe superscore." },
];

test("test-policy buckets normalize every phrasing the readers produce", () => {
  assert.equal(normalizeTestPolicyBucket("test_optional"), "test_optional_or_deemphasized");
  assert.equal(normalizeTestPolicyBucket("test_blind"), "test_optional_or_deemphasized");
  assert.equal(normalizeTestPolicyBucket("test_required"), "test_considered_or_required");
  assert.equal(normalizeTestPolicyBucket("test_considered_or_required"), "test_considered_or_required");
  assert.equal(normalizeTestPolicyBucket(null), null);
});

test("comparisons tolerate small drift and flag real differences", () => {
  const scorecard = { acceptanceRate: 3.9, sat25: 1500, sat75: 1570, act25: 34, act75: 35 };
  const policy = { testPolicy: { value: "test_required", evidence: "ACT or SAT scores are required", sourceUrl: pages[0].url }, deadlines: { restrictive_early_action: { date: "2026-11-01", sourceUrl: "u", evidence: "e" } }, applicationFee: { amount: 100, sourceUrl: "u" } };
  const checks = compareFitInputs({ used, scorecard, policy });
  const byField = Object.fromEntries(checks.map((c) => [c.field, c]));
  assert.equal(byField.acceptance_rate.status, "consistent");   // 3.6 vs 3.9 — within a point
  assert.equal(byField.sat_range.status, "consistent");         // within 40 points
  assert.equal(byField.act_range.status, "consistent");
  assert.equal(byField.test_policy.status, "differs");          // fit assumed optional, site says required
  assert.equal(byField.test_policy.live, "tests considered or required");
  assert.equal(byField.test_policy.liveBucket, "test_considered_or_required");
  assert.equal(byField.deadline_restrictive_early_action.status, "info");
  assert.equal(byField.application_fee.live, "100 USD");
  assert.equal(verdictFromChecks(checks), "discrepancies_found");

  const far = compareFitInputs({ used, scorecard: { acceptanceRate: 49, sat25: 1330, sat75: 1490 }, policy: null, policyFailure: "no_pages" });
  const farBy = Object.fromEntries(far.map((c) => [c.field, c]));
  assert.equal(farBy.acceptance_rate.status, "differs");
  assert.equal(farBy.sat_range.status, "differs");
  assert.equal(farBy.act_range.status, "unavailable");
  assert.equal(farBy.test_policy.status, "unavailable");
  assert.equal(farBy.test_policy.officialSiteStatus, "no_pages");
  assert.equal(verdictFromChecks(compareFitInputs({ used: {}, scorecard: null, policy: null })), "unverifiable");
});

test("two readers that disagree are inconclusive; a verified model read alone counts", () => {
  const policy = { testPolicy: { value: "test_optional", evidence: "x", sourceUrl: "u" }, deadlines: {} };
  const modelPolicy = { value: "test_required", evidence: "ACT or SAT scores are required", sourceUrl: pages[0].url, quoteVerified: true };
  const disagree = compareFitInputs({ used, scorecard: null, policy, modelPolicy }).find((c) => c.field === "test_policy");
  assert.equal(disagree.status, "inconclusive");
  assert.equal(disagree.readers.length, 2);
  const modelOnly = compareFitInputs({ used, scorecard: null, policy: null, modelPolicy }).find((c) => c.field === "test_policy");
  assert.equal(modelOnly.status, "differs");
  assert.equal(modelOnly.liveSource, pages[0].url);
  const unverified = compareFitInputs({ used, scorecard: null, policy: null, modelPolicy: { ...modelPolicy, quoteVerified: false } }).find((c) => c.field === "test_policy");
  assert.equal(unverified.status, "unavailable");
});

test("live inputs keep a fresh validated CDS for the numbers but always take the official site for policy", () => {
  const scorecard = { acceptanceRate: 49, sat25: 1330, sat75: 1490 };
  const checks = compareFitInputs({ used, scorecard, policy: { testPolicy: { value: "test_required", evidence: "e", sourceUrl: "u" } } });
  const fresh = liveInputsFor({ used, scorecard, checks });
  assert.deepEqual(fresh.changed, ["test_policy"]);
  assert.equal(fresh.inputs.acceptanceRate, 3.6);
  assert.equal(fresh.inputs.testPolicy, "test_considered_or_required");
  const stale = liveInputsFor({ used: { ...used, source: "baseline_colleges", cdsYear: null }, scorecard, checks });
  assert.deepEqual(stale.changed, ["acceptance_rate", "sat_range", "test_policy"]);
  assert.equal(stale.inputs.acceptanceRate, 49);
  assert.equal(stale.inputs.sat75, 1490);
});

test("the model's second read only counts when its quote appears verbatim on a fetched page", () => {
  const good = parseReviewReply('```json\n{"testPolicy":{"value":"test_required","evidence":"ACT or SAT scores are required","sourceUrl":"https://admission.example.edu/apply/first-year/testing.html"},"notes":["Superscoring applies."],"summary":"Tests are required. Plan to submit scores."}\n```', pages);
  assert.equal(good.testPolicy.quoteVerified, true);
  assert.equal(good.testPolicy.sourceUrl, pages[0].url);
  assert.deepEqual(good.notes, ["Superscoring applies."]);
  const fabricated = parseReviewReply('{"testPolicy":{"value":"test_optional","evidence":"Scores are optional for everyone","sourceUrl":"https://admission.example.edu/x"},"notes":[],"summary":""}', pages);
  assert.equal(fabricated.testPolicy.quoteVerified, false);
  assert.equal(fabricated.testPolicy.evidence, null);
  assert.equal(parseReviewReply("I cannot do that.", pages), null);
  const { system, user } = buildReviewMessages({ school: "Example University", used, pages });
  assert.match(system, /ONLY valid JSON/);
  assert.match(user, /admit rate 3\.6%; SAT middle 50% 1510–1580/);
  assert.match(user, /PAGE — https:\/\/admission\.example\.edu/);
});

test("verifyCollegeFit orchestrates the three checks, re-scores on a policy change, and reports sources", async () => {
  const calls = [];
  const verification = await verifyCollegeFit({
    school: { name: "Example University", unitId: "999999", homepage: "https://example.edu" },
    used,
    lookupScorecard: async () => ({ acceptanceRate: 3.9, sat25: 1500, sat75: 1570, act25: 34, act75: 35 }),
    readPolicy: async () => ({ site: {}, pages, policy: { testPolicy: { value: "test_required", evidence: "ACT or SAT scores are required", sourceUrl: pages[0].url }, deadlines: {}, applicationFee: null }, failure: null }),
    callLLM: async (args) => {
      calls.push(args);
      return { content: [{ type: "text", text: '{"testPolicy":{"value":"test_required","evidence":"ACT or SAT scores are required","sourceUrl":"' + pages[0].url + '"},"notes":["Scores are required again from fall 2027."],"summary":"Stanford-style: tests are back."}' }] };
    },
    model: "medium-model",
    rescore: (live) => ({ finalPositioningScore: 41, overallPositioningLabel: live.testPolicy === "test_considered_or_required" ? "High Reach" : "Reach" }),
    original: { finalPositioningScore: 48, overallPositioningLabel: "Reach" },
    now: NOW,
  });
  assert.equal(verification.verdict, "discrepancies_found");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "medium-model");
  assert.equal(calls[0].temperature, 0);
  const policy = verification.checks.find((c) => c.field === "test_policy");
  assert.equal(policy.status, "differs");
  assert.deepEqual(policy.readers.map((r) => r.value), ["tests considered or required", "tests considered or required"]);
  assert.deepEqual(verification.recomputed, { changedInputs: ["test_policy"], finalPositioningScore: 41, overallPositioningLabel: "High Reach", labelChanged: true });
  assert.deepEqual(verification.sources.map((s) => s.kind), ["college_scorecard", "official_site"]);
  assert.equal(verification.officialSite.status, "read");
  assert.equal(verification.modelReview.notes[0], "Scores are required again from fall 2027.");
  assert.equal(verification.checkedAt, NOW.toISOString());
  assert.equal(
    formatVerificationLine(verification),
    "College Fit double-check (2026-09-03): live sources differ from the stored data — Testing policy: fit used test-optional / de-emphasized, live tests considered or required; with live inputs the read moves to High Reach",
  );

  // Nothing reachable: no model call, unverifiable, no re-score.
  const blind = await verifyCollegeFit({
    school: { name: "Nowhere U" }, used: {},
    lookupScorecard: async () => null,
    readPolicy: async () => ({ pages: [], policy: null, failure: "site_unresolved" }),
    callLLM: async () => { throw new Error("must not be called"); },
    rescore: () => { throw new Error("must not be called"); },
    now: NOW,
  });
  assert.equal(blind.verdict, "unverifiable");
  assert.equal(blind.modelReview, null);
  assert.equal(blind.recomputed, null);
  assert.equal(blind.officialSite.status, "site_unresolved");
  assert.match(formatVerificationLine(blind), /could not be checked against live sources/);
});
