import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStudentModel,
  scoreAcademicReadiness,
  scoreInstitutionalPriorityFit,
  scoreMajorCompetitiveness,
  scoreInstitutionalSelectivityAdjustment,
  scoreTestPercentile,
  buildPositioningForTarget,
  classifyPositioningLabel,
  compareTestsToSchool,
  compareGpaToSchool,
  compareRankToSchool,
  compareApExams,
  actToSat,
  satToAct,
} from "../positioning-engine.js";

function makeStudent() {
  return buildStudentModel({
    gpa_unweighted: 3.92,
    gpa_weighted: 4.48,
    major_interest: "Computer Science",
    courses_json: JSON.stringify([
      { name: "AP Calculus BC", type: "ap", grade: "A", year: "11" },
      { name: "AP Computer Science A", type: "ap", grade: "A", year: "11" },
      { name: "AP Physics C", type: "ap", grade: "A-", year: "12" },
      { name: "Multivariable Calculus", type: "dual_enrollment", grade: "A", year: "12" },
    ]),
    test_scores_json: JSON.stringify([{ test: "sat", totalScore: 1530 }]),
    activities_json: JSON.stringify([{ name: "AI Research", description: "published project" }]),
  }, [
    { tier_label: "tier_1_distinctive", major_spike: 0.92, prestige: 0.74, leadership: 0.7, achievement: 0.76, narrative_fit: 0.84 },
    { tier_label: "tier_2_strong", major_spike: 0.7, prestige: 0.6, leadership: 0.55, achievement: 0.62, narrative_fit: 0.73 },
  ], { narrativeText: "I care about computational systems and real-world ML." });
}

test("scoreAcademicReadiness is strong for an in-range applicant", () => {
  const student = makeStudent();
  const result = scoreAcademicReadiness(student, {
    avgGpaAdmitted: 3.88,
    sat25: 1460,
    sat75: 1560,
  }, {
    parsed: {
      c7: { academicGpa: 1, rigor: 1, standardizedTests: 0.7, classRank: 0.35 },
      testPolicy: "test_considered_or_required",
    },
  });
  assert.ok(result.score >= 60, `expected solid academic score, got ${result.score}`);
  assert.ok(result.componentScores.majorPrepScore >= 55);
});

test("scoreAcademicReadiness dynamic weights respect OCR-normalized C7 values", () => {
  const student = makeStudent();
  const college = { avgGpaAdmitted: 3.88, sat25: 1460, sat75: 1560 };
  const deemphasizedTests = scoreAcademicReadiness(student, college, {
    parsed: {
      c7: { academicGpa: 1, rigor: 1, standardizedTests: 0, classRank: 0.35 },
      testPolicy: "test_considered_or_required",
    },
  });
  const emphasizedTests = scoreAcademicReadiness(student, college, {
    parsed: {
      c7: { academicGpa: 1, rigor: 1, standardizedTests: 1, classRank: 0.35 },
      testPolicy: "test_considered_or_required",
    },
  });

  assert.ok(emphasizedTests.dynamicWeights.test > deemphasizedTests.dynamicWeights.test);
  assert.equal(deemphasizedTests.dynamicWeights.test < 0.15, true);
});

test("scoreInstitutionalPriorityFit exposes C7 signals used from normalized OCR weights", () => {
  const student = makeStudent();
  const result = scoreInstitutionalPriorityFit(student, {
    parsed: {
      c7: {
        essay: 1,
        extracurriculars: 1,
        character: 1,
        recommendation: 1,
      },
    },
  });
  assert.equal(result.c7SignalsUsed.essay, 1);
  assert.equal(result.c7SignalsUsed.extracurriculars, 1);
  assert.equal(result.c7SignalsUsed.character, 1);
  assert.equal(result.c7SignalsUsed.recommendation, 1);
});

test("scoreMajorCompetitiveness penalizes capped majors", () => {
  const student = makeStudent();
  const baseline = scoreMajorCompetitiveness(student, { topMajors: ["Computer Science", "Engineering"] }, {});
  const capped = scoreMajorCompetitiveness(student, { topMajors: ["Computer Science", "Engineering"] }, {
    majorPolicy: { policyType: "capped", internalTransferDifficulty: "high", capacityExpansionOffset: 0 },
  });
  assert.ok(capped.score < baseline.score);
  assert.notEqual(capped.capacityRiskFlag, "normal");
});

test("buildPositioningForTarget returns evidence-backed target output", () => {
  const student = makeStudent();
  const result = buildPositioningForTarget(student, {
    unitId: "166683",
    name: "Example Tech",
    acceptanceRate: 9.8,
    avgGpaAdmitted: 3.91,
    sat25: 1480,
    sat75: 1560,
    topMajors: ["Computer Science", "Engineering"],
    source: "baseline_colleges",
  }, {
    schoolName: "Example Tech",
    source: "College Transitions CDS repository",
    sourceUrl: "https://example.edu/cds.pdf",
    fetchStatus: "ok",
    repositoryMatch: { schoolName: "Example Tech", latestAvailableYear: "2024-25" },
    parsed: {
      admitRatePercent: 9.8,
      gpaAverage: 3.91,
      testPolicy: "test_considered_or_required",
      c7: { academicGpa: 1, rigor: 1, standardizedTests: 0.7, essay: 0.7, extracurriculars: 0.35, recommendation: 0.35, character: 0.35 },
    },
  }, {
    majorPolicy: { policyType: "direct_admit", internalTransferDifficulty: "high", evidenceStrength: "official" },
  });

  assert.ok(["Highly competitive", "Competitive", "Reach", "High reach"].includes(result.overallPositioningLabel));
  assert.ok(typeof result.admissibility.academicReadinessScore === "number");
  assert.ok(typeof result.competitiveness.majorCompetitivenessScore === "number");
  assert.ok(typeof result.fit.institutionalPriorityFitScore === "number");
  assert.deepEqual(result.fit.c7SignalsUsed, {
    essay: 0.7,
    extracurriculars: 0.35,
    character: 0.35,
    recommendation: 0.35,
  });
  assert.ok(typeof result.confidence.evidenceConfidenceScore === "number");
  assert.ok(result.featureBreakdown.appliedAcademicDynamicWeights);
  assert.ok(typeof result.featureBreakdown.appliedAcademicDynamicWeights.gpa === "number");
  assert.ok(Array.isArray(result.mainRedFlags));
});

test("classifyPositioningLabel uses the four requested bands", () => {
  assert.equal(classifyPositioningLabel(85), "Highly competitive");
  assert.equal(classifyPositioningLabel(70), "Competitive");
  assert.equal(classifyPositioningLabel(52), "Reach");
  assert.equal(classifyPositioningLabel(30), "High reach");
});

test("unknown admit rate is NOT treated as maximally selective", () => {
  const student = makeStudent();
  // collegeContext with no acceptanceRate must give a neutral selectivity
  // adjustment (1.0), never a 1.15 boost from Number(null) === 0.
  const r = buildPositioningForTarget(student, { name: "Mystery U", topMajors: [] }, {
    schoolName: "Mystery U", fetchStatus: "not_found", parsed: null,
  }, { major: "Computer Science" });
  assert.equal(r.competitiveness.institutionalSelectivityAdjustment, 1);
  assert.equal(r.competitiveness.institutionalSelectivityIndex, null);
  // With no selectivity data, displayed competitiveness == raw major-pool signal.
  assert.equal(r.competitiveness.majorCompetitivenessScore, r.competitiveness.majorPoolCompetitivenessScore);
});

test("displayed competitiveness reflects institutional selectivity", () => {
  const student = makeStudent();
  const base = { name: "X", topMajors: [] };
  const cds = { schoolName: "X", fetchStatus: "ok", parsed: { c7: {} } };
  const selective = buildPositioningForTarget(student, { ...base, acceptanceRate: 4.2 }, cds, { major: "Computer Science" });
  const open = buildPositioningForTarget(student, { ...base, acceptanceRate: 65 }, cds, { major: "Computer Science" });
  // Same major pool, but the 4%-admit school must read as far more competitive
  // (lower attainability score) than the 65%-admit school.
  assert.ok(
    selective.competitiveness.majorCompetitivenessScore < open.competitiveness.majorCompetitivenessScore,
    `expected selective < open, got ${selective.competitiveness.majorCompetitivenessScore} vs ${open.competitiveness.majorCompetitivenessScore}`
  );
});

test("unvalidated CDS records get a confidence penalty and never read High", () => {
  const student = makeStudent();
  const ctx = { name: "X", acceptanceRate: 9, sat25: 1480, sat75: 1560, avgGpaAdmitted: 3.9, topMajors: [] };
  const richParsed = {
    schoolName: "X", fetchStatus: "ok", sourceUrl: "https://x.edu/cds.pdf",
    repositoryMatch: { latestAvailableYear: "2024-25" },
    parsed: { c7: { academicGpa: 1, rigor: 1 }, admitRatePercent: 9 },
  };
  const validated = buildPositioningForTarget(student, ctx, { ...richParsed, validated: true }, { major: "Computer Science", majorPolicy: { policyType: "capped" } });
  const unvalidated = buildPositioningForTarget(student, ctx, { ...richParsed, validated: false }, { major: "Computer Science", majorPolicy: { policyType: "capped" } });

  assert.ok(
    unvalidated.confidence.evidenceConfidenceScore < validated.confidence.evidenceConfidenceScore,
    `unvalidated (${unvalidated.confidence.evidenceConfidenceScore}) should score lower than validated (${validated.confidence.evidenceConfidenceScore})`
  );
  assert.notEqual(unvalidated.confidence.evidenceConfidence, "High");
  assert.equal(unvalidated.confidence.evidenceValidated, false);
  assert.equal(validated.confidence.evidenceValidated, true);
});

// ─── Critical-calibration guards (admissibility must not over-estimate) ───

test("selectivity is a dampener, never a boost, and scales with selectivity", () => {
  const adj4 = scoreInstitutionalSelectivityAdjustment({ acceptanceRate: 4 });
  const adj60 = scoreInstitutionalSelectivityAdjustment({ acceptanceRate: 60 });
  const adjUnknown = scoreInstitutionalSelectivityAdjustment({});
  // Never inflate above 1.0 (the old 0.8 + idx*0.35 reached 1.15 for Ivies).
  assert.ok(adj4.adjustment <= 1, `4%-admit adjustment ${adj4.adjustment} must be <= 1`);
  assert.ok(adj60.adjustment <= 1);
  // More selective → stronger dampening (lower multiplier).
  assert.ok(adj4.adjustment < adj60.adjustment, `${adj4.adjustment} should be < ${adj60.adjustment}`);
  assert.equal(adjUnknown.adjustment, 1);
});

test("selectivity devaluation is inversely proportional to acceptance rate (capped at 35%)", () => {
  const at = (rate) => scoreInstitutionalSelectivityAdjustment({ acceptanceRate: rate }).adjustment;
  // Devaluation tracks the odds against admission (1−rate)/rate, scaled 0.02,
  // capped at 0.35: ≈−35% at 4% admit, ≈−11% at 15%, ≈−2% at 50%, ~0 at high.
  assert.equal(at(4), 0.65);
  assert.ok(Math.abs(at(15) - 0.89) < 0.02, `15% admit → ${at(15)}`);
  assert.ok(Math.abs(at(50) - 0.98) < 0.02, `50% admit → ${at(50)}`);
  assert.ok(at(80) > at(50) && at(80) <= 1, `80% admit → ${at(80)}`);
  // Strictly monotonic across the un-capped range: lower acceptance ⇒ harsher.
  assert.ok(at(4) < at(15) && at(15) < at(50) && at(50) < at(80));
  // Cap holds — even a 2%-admit lottery never exceeds 35% devaluation.
  assert.equal(at(2), 0.65);
});

test("the same student is LESS admissible at a more selective school", () => {
  const student = makeStudent();
  const ranges = { sat25: 1460, sat75: 1560, avgGpaAdmitted: 3.9, topMajors: [] };
  const cds = { schoolName: "X", fetchStatus: "ok", parsed: { c7: {} } };
  const selective = buildPositioningForTarget(student, { name: "Selective", acceptanceRate: 4, ...ranges }, cds, { major: "Computer Science" });
  const open = buildPositioningForTarget(student, { name: "Open", acceptanceRate: 55, ...ranges }, cds, { major: "Computer Science" });
  assert.ok(
    selective.finalPositioningScore < open.finalPositioningScore,
    `selective (${selective.finalPositioningScore}) should be < open (${open.finalPositioningScore})`
  );
});

test("a below-range student at a hyper-selective school is a high reach", () => {
  const weak = buildStudentModel({
    gpa_unweighted: 3.4,
    major_interest: "Computer Science",
    courses_json: JSON.stringify([{ name: "AP Computer Science A", type: "ap", grade: "B", year: "11" }]),
    test_scores_json: JSON.stringify([{ test: "sat", totalScore: 1280 }]),
    activities_json: "[]",
  }, [], null);
  const r = buildPositioningForTarget(weak, {
    name: "Lottery U", acceptanceRate: 6, sat25: 1500, sat75: 1570, avgGpaAdmitted: 3.96, topMajors: [],
  }, { schoolName: "Lottery U", fetchStatus: "ok", parsed: { c7: {}, admitRatePercent: 6 } }, { major: "Computer Science" });
  assert.equal(r.overallPositioningLabel, "High reach", `got ${r.overallPositioningLabel} @ ${r.finalPositioningScore}`);
});

test("test-optional with no scores stays conservative (no positive inference)", () => {
  const student = makeStudent();
  const noScores = { ...student, sat: null, act: null };
  const optional = scoreTestPercentile(noScores, { sat25: 1460, sat75: 1560 }, { parsed: { testPolicy: "test_optional_or_deemphasized" } });
  assert.ok(optional <= 45, `test-optional/no-scores should be <= 45, got ${optional}`);
});

test("low evidence confidence widens the displayed score bands", () => {
  const student = makeStudent();
  const ctx = { name: "X", acceptanceRate: 9, sat25: 1480, sat75: 1560, topMajors: [] };
  // Thin evidence: no source, fetch failed, no parsed CDS → Very Low confidence.
  const thin = buildPositioningForTarget(student, ctx, { schoolName: "X", fetchStatus: "not_found", parsed: null, sourceUrl: null }, { major: "Computer Science" });
  // Rich evidence: direct source, fetched, full c7, recent → high confidence.
  const rich = buildPositioningForTarget(student, ctx, {
    schoolName: "X", fetchStatus: "ok", sourceUrl: "https://x.edu/cds.pdf",
    repositoryMatch: { latestAvailableYear: "2024-25" },
    parsed: { c7: { academicGpa: 1, rigor: 1 }, admitRatePercent: 9 },
  }, { major: "Computer Science", majorPolicy: { policyType: "capped" } });

  const thinW = thin.scoreRanges.admissibility.high - thin.scoreRanges.admissibility.low;
  const richW = rich.scoreRanges.admissibility.high - rich.scoreRanges.admissibility.low;
  assert.ok(thinW > richW, `low-confidence band (${thinW}) should be wider than high-confidence (${richW})`);
  // Band brackets the point estimate.
  assert.ok(thin.scoreRanges.admissibility.low <= thin.admissibility.academicReadinessScore);
  assert.ok(thin.scoreRanges.admissibility.high >= thin.admissibility.academicReadinessScore);
});

// ─── The student's record against the wider Common Data Set read ─────

function studentWith(overrides = {}) {
  return buildStudentModel({
    gpa_unweighted: 3.85,
    major_interest: "Computer Science",
    courses: [
      { name: "AP Calculus BC", type: "ap", grade: "A", year: "11" },
      { name: "AP Computer Science A", type: "ap", grade: "A", year: "11" },
    ],
    testScores: [{ test: "sat", totalScore: 1500, sections: { readingWriting: 750, math: 750 } }],
    activities: [],
    ...overrides,
  }, [], null);
}

// A Stanford-like record: composite and section bands, the score-range
// tables, C10 class rank shares and the C11 GPA distribution.
const WIDE_CDS = {
  schoolName: "Wide U", fetchStatus: "ok", sourceUrl: "https://wide.edu/cds.pdf", repositoryMatch: { latestAvailableYear: "2024-25" },
  parsed: {
    c7: { gpa: "very_important", rigor: "very_important", test_scores: "considered", class_rank: "very_important" },
    admitRatePercent: 4, gpaAverage: 3.94, gpaBand: { low: 3.75, high: 4 },
    satComposite: { low: 1510, high: 1570 }, actComposite: { low: 34, high: 35 },
    testPolicy: "test_considered_or_required",
    satSections: { ebrw: { p25: 740, p75: 780 }, math: { p25: 770, p75: 800 } },
    actSections: { english: { p25: 35, p75: 36 }, math: { p25: 33, p75: 36 }, reading: { p25: 34, p75: 36 }, science: { p25: 33, p75: 36 } },
    scoreDistribution: {
      satComposite: [{ low: 1400, high: 1600, pct: 97.3 }, { low: 1200, high: 1399, pct: 2.5 }, { low: 1000, high: 1199, pct: 0.2 }],
      actComposite: [{ low: 30, high: 36, pct: 99.1 }, { low: 24, high: 29, pct: 0.6 }, { low: 18, high: 23, pct: 0.3 }],
    },
    gpaDistribution: [{ low: 4, high: 4, pct: 73.3 }, { low: 3.75, high: 3.99, pct: 16.5 }, { low: 3.5, high: 3.74, pct: 6.7 }, { low: 3.25, high: 3.49, pct: 3 }, { low: 3, high: 3.24, pct: 0.5 }],
    classRank: { topTenthPct: 97.8, topQuarterPct: 100, topHalfPct: 100, submittedPct: 18.8 },
    submitting: { satPct: 50.3, actPct: 19 },
  },
};
const WIDE_COLLEGE = { name: "Wide U", acceptanceRate: 4, sat25: 1510, sat75: 1570, act25: 34, act75: 35, avgGpaAdmitted: 3.94, topMajors: [] };

test("section scores refine the test read and a weak Math section flags a quantitative major", () => {
  const balanced = compareTestsToSchool(studentWith(), WIDE_COLLEGE, WIDE_CDS);
  const lopsided = compareTestsToSchool(studentWith({ testScores: [{ test: "sat", totalScore: 1500, sections: { readingWriting: 800, math: 700 } }] }), WIDE_COLLEGE, WIDE_CDS);
  assert.equal(balanced.best.test, "sat");
  assert.equal(balanced.best.position, "below"); // 1500 sits under the 1510 floor
  assert.equal(balanced.best.sections.length, 2);
  assert.equal(lopsided.best.sections.find((s) => s.key === "math").position, "below");
  assert.equal(lopsided.best.sections.find((s) => s.key === "readingWriting").position, "above");
  assert.ok(lopsided.score < balanced.score, `a 700 Math (${lopsided.score}) should read below a 750/750 split (${balanced.score})`);
  // The distribution places the total: 97.3% of enrolled submitters sat in
  // the 1400–1600 band with it.
  assert.deepEqual(balanced.distribution, { band: "1400–1600", shareInBand: 97.3, shareAbove: 0, shareAtOrBelow: 100 });
  assert.deepEqual(balanced.submitting, { satPct: 50.3, actPct: 19 });

  const read = buildPositioningForTarget(studentWith({ testScores: [{ test: "sat", totalScore: 1530, sections: { readingWriting: 800, math: 730 } }] }), WIDE_COLLEGE, WIDE_CDS, { major: "Computer Science" });
  assert.ok(read.mainRedFlags.some((f) => /SAT Math \(730\) sits below this school's 25th percentile \(770\)/.test(f)), JSON.stringify(read.mainRedFlags));
  assert.equal(read.profileComparison.tests.used.weakSection, true);
  assert.equal(read.profileComparison.tests.used.position, "within");
  const humanities = buildPositioningForTarget(studentWith({ major_interest: "English", testScores: [{ test: "sat", totalScore: 1530, sections: { readingWriting: 800, math: 730 } }] }), WIDE_COLLEGE, WIDE_CDS, { major: "English" });
  assert.ok(!humanities.mainRedFlags.some((f) => /SAT Math/.test(f)), "the math flag is for quantitative majors only");
});

test("the stronger test is read, through concordance when the school reports only the other", () => {
  const both = compareTestsToSchool(studentWith({ testScores: [{ test: "sat", totalScore: 1300 }, { test: "act", totalScore: 34, sections: { english: 35, math: 33, reading: 34, science: 34 } }] }), WIDE_COLLEGE, WIDE_CDS);
  assert.equal(both.best.test, "act");
  assert.equal(both.best.position, "within");
  assert.equal(both.best.sections.length, 4);
  assert.equal(both.candidates.find((c) => c.test === "sat").position, "below");
  assert.equal(both.distribution.band, "30–36");

  // Only SAT bands at the school: a 34 ACT is read as its 1500 equivalent.
  const satOnly = compareTestsToSchool(studentWith({ testScores: [{ test: "act", totalScore: 34 }] }), { name: "S", sat25: 1460, sat75: 1560 }, { parsed: { testPolicy: "test_considered_or_required" } });
  assert.equal(satOnly.best.convertedFrom, "act");
  assert.equal(satOnly.best.equivalent, 1500);
  assert.equal(satOnly.best.position, "within");
  assert.equal(satOnly.distribution, null, "a converted score is not placed in the other test's table");
  assert.equal(actToSat(36), 1590);
  assert.equal(satToAct(1460), 33);
});

test("a below-range score at a test-optional school is withheld and weighs nothing", () => {
  const optional = { ...WIDE_CDS, parsed: { ...WIDE_CDS.parsed, testPolicy: "test_optional_or_deemphasized" } };
  const weak = studentWith({ testScores: [{ test: "sat", totalScore: 1250 }] });
  const withheld = compareTestsToSchool(weak, WIDE_COLLEGE, optional);
  assert.equal(withheld.advice, "withhold");
  assert.equal(withheld.score, 42, "no worse than a non-submitter");
  const readiness = scoreAcademicReadiness(weak, WIDE_COLLEGE, optional);
  assert.equal(readiness.dynamicWeights.test, 0);
  assert.equal(readiness.reads.tests.advice, "withhold");

  const required = compareTestsToSchool(weak, WIDE_COLLEGE, WIDE_CDS);
  assert.equal(required.advice, "submit");
  assert.ok(required.score < 42, `a required 1250 against 1510–1570 must read low, got ${required.score}`);
  assert.ok(scoreAcademicReadiness(weak, WIDE_COLLEGE, WIDE_CDS).dynamicWeights.test > 0.1);

  const strong = compareTestsToSchool(studentWith({ testScores: [{ test: "sat", totalScore: 1560 }] }), WIDE_COLLEGE, optional);
  assert.equal(strong.advice, "submit");
  assert.equal(compareTestsToSchool(studentWith({ testScores: [] }), WIDE_COLLEGE, optional).advice, "none");
  assert.equal(buildPositioningForTarget(weak, WIDE_COLLEGE, optional, { major: "Computer Science" }).featureBreakdown.testSubmissionAdvice, "withhold");
});

test("GPA reads against the C11 distribution and class rank against C10", () => {
  const gpa = compareGpaToSchool(studentWith({ gpa_unweighted: 3.8 }), WIDE_COLLEGE, WIDE_CDS);
  assert.equal(gpa.basis, "average+distribution");
  assert.equal(gpa.position, "within");
  assert.deepEqual(gpa.placement, { band: "3.75–3.99", shareInBand: 16.5, shareAbove: 73.3, shareAtOrBelow: 26.7 });
  const perfect = compareGpaToSchool(studentWith({ gpa_unweighted: 4 }), WIDE_COLLEGE, WIDE_CDS);
  assert.equal(perfect.placement.band, "4");
  assert.equal(perfect.placement.shareAbove, 0);
  assert.ok(perfect.score > gpa.score);
  // The same 3.8 reads better where the distribution says most of the
  // class sat below it.
  const openDistribution = { parsed: { ...WIDE_CDS.parsed, gpaAverage: null, gpaDistribution: [{ low: 4, high: 4, pct: 10 }, { low: 3.75, high: 3.99, pct: 20 }, { low: 3.5, high: 3.74, pct: 40 }, { low: 3.25, high: 3.49, pct: 30 }] } };
  const easier = compareGpaToSchool(studentWith({ gpa_unweighted: 3.8 }), { name: "Open" }, openDistribution);
  assert.equal(easier.basis, "distribution");
  assert.ok(easier.score > gpa.score, `${easier.score} should beat ${gpa.score}`);
  // Only an average: the old formula, unchanged.
  assert.equal(compareGpaToSchool(studentWith({ gpa_unweighted: 3.8 }), { avgGpaAdmitted: 3.9 }, { parsed: {} }).basis, "average");
  assert.equal(compareGpaToSchool(studentWith({ gpa_unweighted: null }), WIDE_COLLEGE, WIDE_CDS).score, 30);

  const topTenth = compareRankToSchool(studentWith({ classRank: { rank: 12, size: 400 } }), WIDE_CDS);
  assert.equal(topTenth.bucket, "top10");
  assert.equal(topTenth.shareAbove, 0);
  assert.equal(topTenth.score, 92);
  const topQuarter = compareRankToSchool(studentWith({ classRank: { topPercent: 20 } }), WIDE_CDS);
  assert.equal(topQuarter.bucket, "top25");
  assert.equal(topQuarter.shareAbove, 97.8);
  assert.ok(topQuarter.score < 25, `almost everyone enrolled ranked above a top-20% student: ${topQuarter.score}`);
  assert.equal(compareRankToSchool(studentWith(), WIDE_CDS).score, 50, "no rank on record stays neutral");
  assert.equal(compareRankToSchool(studentWith({ classRank: { topPercent: 20 } }), { parsed: {} }).basis, "percentile");
});

test("AP exam results enter the readiness blend only once the student has some", () => {
  const withExams = studentWith({ apScores: [{ exam: "Computer Science A", score: 5, year: 2025 }, { exam: "Calculus BC", score: 5, year: 2026 }, { exam: "Statistics", score: 4, year: 2026 }, { exam: "Physics 1", score: 2, year: 2025 }] });
  assert.equal(withExams.apExams.count, 4);
  assert.equal(withExams.apExams.strong, 3);
  assert.equal(withExams.apExams.weak, 1);
  assert.deepEqual(withExams.apExams.relevant.map((a) => a.name), ["Computer Science A"]);
  const ap = compareApExams(withExams);
  assert.ok(ap.score >= 85, `three 4s and 5s with a 5 in the field should read high, got ${ap.score}`);
  const readiness = scoreAcademicReadiness(withExams, WIDE_COLLEGE, WIDE_CDS);
  assert.ok(readiness.dynamicWeights.apExams > 0.04);
  const none = scoreAcademicReadiness(studentWith(), WIDE_COLLEGE, WIDE_CDS);
  assert.equal(none.dynamicWeights.apExams, 0);
  assert.equal(none.reads.apExams.score, null);
  // A 2 in the field is a flag; no exams is not.
  const weakField = buildPositioningForTarget(studentWith({ apScores: [{ exam: "Computer Science A", score: 2, year: 2025 }] }), WIDE_COLLEGE, WIDE_CDS, { major: "Computer Science" });
  assert.ok(weakField.mainRedFlags.some((f) => /AP exam scores in the intended field average below 3/.test(f)));
  assert.ok(!buildPositioningForTarget(studentWith(), WIDE_COLLEGE, WIDE_CDS, { major: "Computer Science" }).mainRedFlags.some((f) => /AP exam scores/.test(f)));
});

test("the positioning result carries the profile comparison the card renders", () => {
  const student = studentWith({ classRank: { rank: 12, size: 400 }, apScores: [{ exam: "Calculus BC", score: 5, year: 2026 }] });
  const read = buildPositioningForTarget(student, WIDE_COLLEGE, WIDE_CDS, { major: "Computer Science" });
  const pc = read.profileComparison;
  assert.equal(pc.tests.used.test, "sat");
  assert.equal(pc.tests.used.score, 1500);
  assert.deepEqual(pc.tests.used.band, { low: 1510, high: 1570 });
  assert.equal(pc.tests.sections.length, 2);
  assert.equal(pc.tests.advice, "submit");
  assert.equal(pc.gpa.average, 3.94);
  assert.equal(pc.gpa.placement.band, "3.75–3.99");
  assert.equal(pc.classRank.bucket, "top10");
  assert.equal(pc.classRank.school.topTenthPct, 97.8);
  assert.equal(pc.apExams.count, 1);
  assert.equal(read.featureBreakdown.classRankScore, 92);
  assert.ok(read.featureBreakdown.apExamScore > 80);
  // A bare record still yields the block, with unknowns rather than errors.
  const bare = buildPositioningForTarget(buildStudentModel({ major_interest: "Biology" }, [], null), { name: "Bare" }, { parsed: null }, { major: "Biology" });
  assert.equal(bare.profileComparison.tests.advice, "none");
  assert.equal(bare.profileComparison.gpa.position, "unknown");
  assert.equal(bare.profileComparison.classRank.bucket, null);
  assert.equal(bare.profileComparison.apExams.score, null);
});

test("a weighted admitted average (Harvard's 4.21) is compared with the weighted GPA, never the unweighted one", () => {
  const harvard = { name: "Harvard", acceptanceRate: 3.6, avgGpaAdmitted: 4.21, sat25: 1500, sat75: 1580, topMajors: [] };
  const cds = { parsed: { c7: {}, gpaAverage: 4.21, gpaDistribution: [{ low: 4, high: 4, pct: 72.4 }, { low: 3.75, high: 3.99, pct: 22.2 }, { low: 3.5, high: 3.74, pct: 4.1 }, { low: 3.25, high: 3.49, pct: 1.3 }] } };
  const weighted = compareGpaToSchool(buildStudentModel({ gpa_unweighted: 4, gpa_weighted: 4.48, major_interest: "Biology" }, [], null), harvard, cds);
  assert.equal(weighted.averageScale, "weighted");
  assert.equal(weighted.comparedGpa, 4.48);
  assert.equal(weighted.position, "above");
  assert.ok(weighted.score >= 80, `a 4.0/4.48 at a 4.21 weighted average must read in range, got ${weighted.score}`);
  // Without a weighted GPA the target is the top of the 4.0 scale, so a
  // perfect unweighted record reads at the average rather than far below.
  const unweightedOnly = compareGpaToSchool(buildStudentModel({ gpa_unweighted: 4, major_interest: "Biology" }, [], null), harvard, cds);
  assert.equal(unweightedOnly.comparedGpa, 4);
  assert.ok(unweightedOnly.score >= 60, `got ${unweightedOnly.score}`);
  assert.ok(unweightedOnly.score < weighted.score);
  // The rigor expectation stays on the 4.0 scale.
  const readiness = scoreAcademicReadiness(buildStudentModel({ gpa_unweighted: 4, gpa_weighted: 4.48, major_interest: "Biology", courses: [{ name: "AP Biology", type: "ap", grade: "A", year: "11" }] }, [], null), harvard, cds);
  assert.ok(readiness.componentScores.rigorScore > 10);
  // An ordinary average is unweighted and compares with the unweighted GPA.
  const plain = compareGpaToSchool(buildStudentModel({ gpa_unweighted: 3.8, gpa_weighted: 4.3, major_interest: "Biology" }, [], null), { avgGpaAdmitted: 3.9 }, { parsed: {} });
  assert.equal(plain.averageScale, "unweighted");
  assert.equal(plain.comparedGpa, 3.8);
});
