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
  expandCollegeAlias,
  buildValuesFromCds,
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
  it("returns null instead of guessing when nothing matches", () => {
    // The Scorecard name filter is a tokenized keyword search — a blind
    // first-result fallback used to bind unrelated schools.
    assert.equal(pickScorecardHit(results, "Somewhere Else"), null);
    assert.equal(pickScorecardHit([{ name: "X", website: "" }], "X"), null);
    assert.equal(pickScorecardHit([], "X"), null);
  });
  it("finds the exact school even when tokenized noise ranks first (NYU regression)", () => {
    // Real Scorecard ordering for the query "New York University".
    const noisy = [
      { name: "State University of New York at New Paltz", website: "www.newpaltz.edu" },
      { name: "Dominican University New York", website: "www.duny.edu" },
      { name: "St. John's University-New York", website: "www.stjohns.edu" },
      { name: "University at Buffalo", website: "www.buffalo.edu" },
      { name: "Columbia University in the City of New York", website: "www.columbia.edu" },
      { name: "Stony Brook University", website: "www.stonybrook.edu" },
      { name: "New York University", website: "www.nyu.edu" },
    ];
    assert.equal(pickScorecardHit(noisy, "New York University").name, "New York University");
    // Without the real school in the list, no near-miss is acceptable.
    assert.equal(pickScorecardHit(noisy.slice(0, 5), "New York University"), null);
  });
});

describe("expandCollegeAlias", () => {
  it("maps common abbreviations to official Scorecard names", () => {
    assert.equal(expandCollegeAlias("NYU"), "New York University");
    assert.equal(expandCollegeAlias("washu"), "Washington University in St Louis");
    assert.equal(expandCollegeAlias("UC Berkeley"), "University of California-Berkeley");
  });
  it("passes unknown names through untouched", () => {
    assert.equal(expandCollegeAlias("Oberlin College"), "Oberlin College");
  });
});

describe("buildValuesFromCds (blocked-site fallback)", () => {
  it("turns C7 admission factors into labeled value themes, Very Important first", () => {
    const result = buildValuesFromCds({
      school: "Example University",
      slug: "example-university",
      yearLabel: "2025-26",
      sourceUrl: "https://www.example.edu/cds.pdf",
      c7: {
        rigor: "very_important",
        application_essay: "very_important",
        ec: "important",
        test_scores: "considered",
        interview: "not_considered",
      },
    });
    assert.ok(result);
    assert.equal(result.fallback, "cds_admission_factors");
    assert.deepEqual(result.values.map((v) => v.theme), [
      "Rigor of Secondary School Record",
      "Application Essay",
      "Extracurricular Activities",
    ]);
    assert.match(result.values[0].summary, /Very Important/);
    assert.match(result.values[2].summary, /Important/);
    assert.equal(result.sourceUrl, "https://www.example.edu/cds.pdf");
    assert.ok(result.note.includes("Common Data Set"));
  });

  it("returns null when the record has no usable C7 grid", () => {
    assert.equal(buildValuesFromCds({ school: "X", c7: {} }), null);
    assert.equal(buildValuesFromCds({ school: "X", c7: { rigor: "considered" } }), null);
    assert.equal(buildValuesFromCds(null), null);
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
