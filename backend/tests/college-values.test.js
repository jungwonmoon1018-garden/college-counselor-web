// The priorities matrix under the College Fit card: what in the student's
// record speaks to each value or declared admission factor. Deterministic —
// no retrieval, no model.
import test from "node:test";
import assert from "node:assert/strict";

import { computeFit } from "../college-values.js";
import { buildValuesFromCds } from "../college-research.js";

function priority(theme) {
  return { theme, summary: `Very Important in Wide U's admission decisions, per its Common Data Set (section C7).` };
}

const VALUES = [
  "Rigor of Secondary School Record",
  "Class Rank",
  "Academic GPA",
  "Standardized Test Scores",
  "Application Essay",
  "Recommendations",
  "Extracurricular Activities",
  "Talent / Ability",
  "Character / Personal Qualities",
  "Volunteer Work",
  "Work Experience",
  "Level of Applicant's Interest",
].map(priority).concat([{ theme: "Leadership", summary: "Students who lead and take initiative." }]);

const PROFILE = {
  gpaUnweighted: 3.9,
  gpaWeighted: 4.3,
  classRank: { rank: 12, size: 400 },
  courses: [
    { name: "Calculus BC", type: "ap", grade: "A" },
    { name: "English 11", type: "regular", grade: "B+" },
  ],
  apScores: [{ exam: "Calculus BC", score: 5 }, { exam: "Computer Science A", score: 4 }],
  testScores: [
    { test: "sat", totalScore: 1520, sections: { readingWriting: 740, math: 780 } },
    { test: "act", totalScore: 33 },
  ],
  activities: [
    { name: "Robotics Club", role: "Captain", category: "robotics", description: "Led a 20-student team to the FRC regional; founded the outreach program" },
    { name: "Food Bank", role: "Volunteer", category: "community_service", description: "Volunteered weekly at the county food bank and mentored new volunteers" },
    { name: "Grocery Cashier", role: "Part-time cashier", category: "work_paid", description: "Worked ten hours a week through junior year" },
  ],
  majorInterest: "Engineering",
  goals: ["Wide U"],
};

const STRENGTH_ROWS = [
  { ec_name: "Robotics Club", dedication: 0.7, achievement: 0.6, leadership: 0.9, prestige: 0.72, major_spike: 0.8, narrative_fit: 0.6, tier_label: "tier_2_strong" },
];

// The College Fit read for the school, as buildProfileComparison shapes it.
const COMPARISON = {
  tests: {
    policy: "test_considered_or_required",
    advice: "submit",
    used: { test: "sat", score: 1520, band: { low: 1510, high: 1570 }, position: "within" },
    sections: [],
    alternatives: [{ test: "act", score: 33, band: { low: 34, high: 35 }, position: "below" }],
  },
  gpa: { gpa: 3.9, average: 3.94, averageScale: "unweighted", band: { low: 3.75, high: 4 }, position: "within" },
  classRank: { topPercent: 3, bucket: "top10", school: { topTenthPct: 97.8 }, shareAbove: 0 },
  apExams: { count: 2, average: 4.5 },
};

const rowFor = (fit, theme) => fit.perValueCoverage.find((p) => p.theme === theme);

test("academics evidence the academic priorities, placed against the school's enrolled class", () => {
  const fit = computeFit(VALUES, PROFILE, { strengthRows: STRENGTH_ROWS, comparison: COMPARISON });

  const gpa = rowFor(fit, "Academic GPA");
  assert.equal(gpa.hits, 1);
  assert.deepEqual(gpa.evidence[0], { kind: "gpa", label: "GPA 3.9 (4.3 weighted)", tone: "fair", position: "within", detail: { average: 3.94, weighted: false } });

  const rank = rowFor(fit, "Class Rank");
  assert.deepEqual(rank.evidence[0], { kind: "rank", label: "Class rank top 3% (12 of 400)", tone: "strong", position: "above", detail: { topTenthPct: 97.8 } });

  // Both tests are listed; the SAT inside the band is a match, the ACT
  // below the band is on file but not one.
  const tests = rowFor(fit, "Standardized Test Scores");
  assert.equal(tests.evidence.length, 2);
  assert.equal(tests.hits, 1);
  assert.match(tests.evidence[0].label, /^SAT 1520 \(.*740.*780\)$/);
  assert.equal(tests.evidence[0].position, "within");
  assert.deepEqual(tests.evidence[0].detail, { band: { low: 1510, high: 1570 } });
  assert.equal(tests.evidence[1].label, "ACT 33");
  assert.equal(tests.evidence[1].tone, "weak");

  // Rigor is evidenced by the AP course (an A) and the AP exam results, not
  // by the regular English course.
  const rigor = rowFor(fit, "Rigor of Secondary School Record");
  const course = rigor.evidence.find((e) => e.kind === "course");
  assert.deepEqual(course, { kind: "course", label: "Calculus BC (AP)", tone: "strong", position: null });
  const ap = rigor.evidence.find((e) => e.kind === "ap");
  assert.equal(ap.label, "AP exams: Calculus BC 5, Computer Science A 4");
  assert.equal(ap.tone, "strong");
  assert.deepEqual(ap.detail, { average: 4.5 });
  assert.ok(!rigor.evidence.some((e) => /English 11/.test(e.label)));
});

test("activities evidence the qualities their own descriptions show", () => {
  const fit = computeFit(VALUES, PROFILE, { strengthRows: STRENGTH_ROWS, comparison: COMPARISON });

  // Every activity speaks to the extracurricular priority; the tier-2
  // activity reads as strong evidence.
  const ec = rowFor(fit, "Extracurricular Activities");
  assert.equal(ec.evidence.length, 3);
  assert.equal(ec.evidence.find((e) => e.label.startsWith("Robotics")).tone, "strong");

  // Character: the food bank's service and mentoring words carry it, and a
  // captain's sustained leadership supports it (never strongly on its own).
  const character = rowFor(fit, "Character / Personal Qualities");
  const foodBank = character.evidence.find((e) => e.label === "Food Bank (Volunteer)");
  assert.ok(foodBank, JSON.stringify(character));
  assert.deepEqual(foodBank.traits, ["character"]);
  const robotics = character.evidence.find((e) => e.label === "Robotics Club (Captain)");
  assert.ok(robotics, JSON.stringify(character));
  assert.equal(robotics.tone, "fair");

  const leadership = rowFor(fit, "Leadership");
  const captain = leadership.evidence.find((e) => e.label === "Robotics Club (Captain)");
  assert.deepEqual(captain.traits, ["leadership"]);
  assert.equal(captain.tone, "strong");

  const talent = rowFor(fit, "Talent / Ability");
  assert.ok(talent.evidence.some((e) => e.label.startsWith("Robotics") && e.traits.includes("talent")), JSON.stringify(talent));

  assert.ok(rowFor(fit, "Volunteer Work").evidence.some((e) => e.label.startsWith("Food Bank")));
  assert.ok(rowFor(fit, "Work Experience").evidence.some((e) => e.label.startsWith("Grocery Cashier")));

  // The character profile behind the rows.
  assert.equal(fit.characterProfile.length, 3);
  const profile = fit.characterProfile.find((p) => p.name === "Robotics Club");
  assert.equal(profile.tier, "tier_2_strong");
  assert.equal(profile.prestige, 0.72);
  assert.ok(profile.traits.leadership_and_initiative >= 0.9);
});

test("priorities the profile cannot show are labeled, and do not count against the fit", () => {
  const fit = computeFit(VALUES, PROFILE, { strengthRows: STRENGTH_ROWS, comparison: COMPARISON });
  for (const [theme, reason] of [["Application Essay", "essay"], ["Recommendations", "recommendations"], ["Level of Applicant's Interest", "interest"]]) {
    const row = rowFor(fit, theme);
    assert.equal(row.unreadable, true, theme);
    assert.equal(row.reason, reason);
    assert.equal(row.hits, 0);
    assert.deepEqual(row.evidence, []);
  }
  assert.equal(fit.readableValues, 10);
  assert.equal(fit.overall, 100);
});

test("without a College Fit read the record still counts, and a score below the school's range is listed but is not a match", () => {
  const plain = computeFit(VALUES, PROFILE);
  const gpa = rowFor(plain, "Academic GPA").evidence[0];
  assert.equal(gpa.tone, "fair");
  assert.equal(gpa.position, null);
  assert.equal(gpa.detail, null);
  assert.equal(rowFor(plain, "Class Rank").evidence[0].tone, "strong");
  assert.ok(rowFor(plain, "Standardized Test Scores").evidence.every((e) => e.tone === "fair"));

  const below = computeFit(VALUES, PROFILE, { comparison: { ...COMPARISON, gpa: { ...COMPARISON.gpa, position: "below" } } });
  const row = rowFor(below, "Academic GPA");
  assert.equal(row.hits, 0);
  assert.equal(row.evidence.length, 1);
  assert.equal(row.evidence[0].tone, "weak");
});

test("short hints match whole words, so an ACT score never evidences 'impact'", () => {
  const fit = computeFit([{ theme: "Impact", summary: "Impact on the community around campus." }], { testScores: [{ test: "act", totalScore: 33 }], activities: [] });
  assert.deepEqual(rowFor(fit, "Impact").evidence, []);
});

test("the CDS fallback keeps up to ten declared priorities so character and talent are not cut", () => {
  const values = buildValuesFromCds({
    school: "Wide U",
    slug: "wide-u",
    c7: {
      rigor: "very_important", class_rank: "very_important", gpa: "very_important", test_scores: "considered",
      application_essay: "very_important", recommendations: "very_important", interview: "considered",
      ec: "very_important", talent_ability: "very_important", character: "very_important",
      volunteer_work: "important", work_experience: "important", level_of_interest: "important",
    },
  }).values.map((v) => v.theme);
  assert.equal(values.length, 10);
  assert.ok(values.includes("Character / Personal Qualities"));
  assert.ok(values.includes("Talent / Ability"));
});
