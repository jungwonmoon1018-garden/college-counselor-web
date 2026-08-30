// ═══════════════════════════════════════════════════════════
// TESTS: College research (official-source values + deadlines)
// ═══════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  slugifyCollege,
  currentAdmissionsCycle,
  htmlToText,
  sameSite,
  harvestLinks,
  verifyQuote,
  sanitizeDeadlineDates,
  pickScorecardHit,
} from "../college-research.js";
import { classifyTopic, TOPIC_TYPES, MODEL_TIERS } from "../policy-router.js";

describe("slugifyCollege / currentAdmissionsCycle", () => {
  it("slugs names stably", () => {
    assert.equal(slugifyCollege("Princeton University"), "princeton-university");
    assert.equal(slugifyCollege("UC Berkeley!"), "uc-berkeley");
  });
  it("labels fall dates with the cycle that closes the following spring", () => {
    assert.equal(currentAdmissionsCycle(new Date("2026-09-15T00:00:00Z")), "2026-27");
    assert.equal(currentAdmissionsCycle(new Date("2027-02-15T00:00:00Z")), "2026-27");
    assert.equal(currentAdmissionsCycle(new Date("2027-08-15T00:00:00Z")), "2027-28");
  });
});

describe("htmlToText", () => {
  it("strips scripts, styles, and tags but keeps text", () => {
    const text = htmlToText("<html><script>evil()</script><style>x{}</style><h1>Our Mission</h1><p>Service to &amp; leadership.</p></html>");
    assert.ok(text.includes("Our Mission"));
    assert.ok(text.includes("Service to & leadership."));
    assert.ok(!text.includes("evil"));
  });
});

describe("sameSite / harvestLinks", () => {
  it("treats subdomains of the same site as same-site", () => {
    assert.equal(sameSite("https://admission.princeton.edu/x", "https://www.princeton.edu/"), true);
    assert.equal(sameSite("https://evil.example.com/", "https://www.princeton.edu/"), false);
  });

  it("harvests only same-site links matching the keywords", () => {
    const html = `
      <a href="/admission/deadlines">Dates &amp; Deadlines</a>
      <a href="https://admission.school.edu/apply">Apply</a>
      <a href="https://evil.example.com/deadlines">off-site deadlines</a>
      <a href="/athletics">Athletics</a>
      <a href="mailto:x@school.edu">mail</a>
    `;
    const links = harvestLinks(html, "https://www.school.edu/", /deadline|apply|admission/i);
    assert.deepEqual(links, [
      "https://www.school.edu/admission/deadlines",
      "https://admission.school.edu/apply",
    ]);
  });
});

describe("verifyQuote", () => {
  const pages = [{ url: "https://www.school.edu/mission", text: "We prize intellectual curiosity — and “service to humanity” above all." }];
  it("accepts verbatim quotes despite smart-quote/whitespace differences", () => {
    assert.equal(verifyQuote('service to humanity', pages), "https://www.school.edu/mission");
    assert.equal(verifyQuote("intellectual   curiosity - and “service", pages), "https://www.school.edu/mission");
  });
  it("rejects paraphrases and junk", () => {
    assert.equal(verifyQuote("we value serving people", pages), null);
    assert.equal(verifyQuote("", pages), null);
  });
});

describe("sanitizeDeadlineDates", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  it("keeps plausible ISO dates and nulls everything else", () => {
    const out = sanitizeDeadlineDates({
      ea: "2026-11-01",
      ed: "not a date",
      rd: "2027-01-01T00:00:00Z",
      financialAid: "2031-01-01",   // outside the 2-year window
      commitBy: null,
      decisionRelease: "2027-03-28",
    }, now);
    assert.equal(out.ea, "2026-11-01");
    assert.equal(out.ed, null);
    assert.equal(out.rd, "2027-01-01");
    assert.equal(out.financialAid, null);
    assert.equal(out.commitBy, null);
    assert.equal(out.decisionRelease, "2027-03-28");
  });
});

describe("pickScorecardHit", () => {
  const results = [
    { name: "Princeton Theological Seminary", website: "www.ptsem.edu" },
    { name: "Princeton University", website: "www.princeton.edu" },
    { name: "No Website U", website: "" },
  ];
  it("prefers the result whose name starts with what the student typed", () => {
    assert.equal(pickScorecardHit(results, "Princeton U").name, "Princeton University");
    assert.equal(pickScorecardHit(results, "princeton university").name, "Princeton University");
  });
  it("falls back to the first result with a website, and null on none", () => {
    assert.equal(pickScorecardHit(results, "Somewhere Else").name, "Princeton Theological Seminary");
    assert.equal(pickScorecardHit([{ name: "X", website: "" }], "X"), null);
    assert.equal(pickScorecardHit([], "X"), null);
  });
});

describe("EC recommendation routing", () => {
  it("classifies 'What ECs do you recommend based on my courses list?' as EC-strategy coaching on the medium tier", () => {
    const result = classifyTopic("What ECs do you recommend based on my courses list?");
    assert.equal(result.topicType, TOPIC_TYPES.COACHING);
    assert.equal(result.subIntent, "ec_strategy");
    assert.equal(result.modelTier, MODEL_TIERS.SONNET);
  });
});
