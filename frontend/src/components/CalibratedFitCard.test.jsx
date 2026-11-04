import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CalibratedFitCard, { labelKeyOf, valuesErrorText, verificationErrorText } from "./CalibratedFitCard.jsx";
import { STRINGS } from "../i18n.js";

// The positioning payload's profileComparison block: what the College Fit
// read compared the student's own record with (tests by section, the GPA
// against the C11 distribution, the class rank against C10, AP exams).
const positioning = {
  overallPositioningLabel: "Reach",
  admissibility: { academicReadinessScore: 62, summary: "academically stretched" },
  competitiveness: { majorCompetitivenessScore: 30 },
  fit: { institutionalPriorityFitScore: 55 },
  confidence: { evidenceConfidence: "High", evidenceConfidenceScore: 80 },
  scoreRanges: {},
  mainRedFlags: ["SAT Math (700) sits below this school's 25th percentile (770), which a quantitative major will notice."],
  profileComparison: {
    tests: {
      policy: "test_optional_or_deemphasized",
      advice: "borderline",
      used: { test: "sat", score: 1500, convertedFrom: null, equivalent: null, band: { low: 1510, high: 1570 }, position: "below", weakSection: false },
      sections: [
        { key: "readingWriting", label: "Reading & Writing", value: 800, band: { low: 740, high: 780 }, position: "above" },
        { key: "math", label: "Math", value: 700, band: { low: 770, high: 800 }, position: "below" },
      ],
      alternatives: [],
      distribution: { band: "1400–1600", shareInBand: 97.3, shareAbove: 0, shareAtOrBelow: 100 },
      submitting: { satPct: 50.3 },
      score: 50,
    },
    gpa: { gpa: 3.8, average: 3.94, band: { low: 3.75, high: 4 }, position: "within", placement: { band: "3.75–3.99", shareInBand: 16.5, shareAbove: 73.3, shareAtOrBelow: 26.7 }, basis: "average+distribution", score: 44 },
    classRank: { topPercent: 3, bucket: "top10", school: { topTenthPct: 97.8 }, shareAbove: 0, basis: "cds_c10", score: 92 },
    apExams: { count: 2, average: 4.5, strong: 2, weak: 0, relevant: [{ name: "Computer Science A", score: 5 }], relevantAverage: 5, score: 93 },
  },
};

describe("CalibratedFitCard", () => {
  afterEach(() => cleanup());

  it("renders how the student's record compares with the enrolled class", () => {
    render(<CalibratedFitCard collegeValues={{ displayName: "Stanford University", values: [] }} positioning={positioning} loading={false} />);
    const block = screen.getByTestId("profile-comparison");
    expect(block).toHaveTextContent("How your record compares");
    expect(block).toHaveTextContent("Tests: SAT 1500 · 1510–1570 · below the 25th percentile");
    expect(block).toHaveTextContent("Reading & Writing: 800 · 740–780 · at or above the 75th percentile");
    expect(block).toHaveTextContent("Math: 700 · 770–800 · below the 25th percentile");
    expect(block).toHaveTextContent("97.3% of enrolled submitters scored 1400–1600");
    expect(block).toHaveTextContent("Test-optional here: this score is inside the band but not strong");
    expect(block).toHaveTextContent("GPA: 3.8 · average 3.94, middle 50% 3.75–4 · inside the middle 50%");
    expect(block).toHaveTextContent("73.3% of the enrolled class had a GPA above your 3.75–3.99 band");
    expect(block).toHaveTextContent("Class rank: top 3% · 97.8% of the enrolled class ranked in the top tenth");
    expect(block).toHaveTextContent("AP exams: 2 exams · average 4.5 · in your field: Computer Science A 5");
    expect(screen.getByText(/SAT Math \(700\) sits below/)).toBeInTheDocument();
  });

  it("says so when no score is on file, and the block stays out when there is nothing to compare", () => {
    render(<CalibratedFitCard
      collegeValues={{ displayName: "X", values: [] }}
      positioning={{
        ...positioning,
        mainRedFlags: [],
        profileComparison: {
          tests: { policy: "test_considered_or_required", advice: "none", used: null, sections: [], alternatives: [] },
          gpa: { gpa: null, position: "unknown" },
          classRank: { topPercent: null },
          apExams: { count: 0 },
        },
      }}
      loading={false}
    />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Tests: no score on file (tests are required or considered here)");
    cleanup();
    render(<CalibratedFitCard collegeValues={{ displayName: "Y", values: [] }} positioning={{ ...positioning, mainRedFlags: [], profileComparison: null }} loading={false} />);
    expect(screen.queryByTestId("profile-comparison")).not.toBeInTheDocument();
  });

  // The read starts from the admit rate outside Early Decision when the CDS
  // counts give one; the card says which rate, in both languages.
  it("shows which admit rate the read started from", () => {
    const withAdmit = (admitRate) => ({ ...positioning, profileComparison: { ...positioning.profileComparison, admitRate } });
    render(<CalibratedFitCard collegeValues={{ displayName: "Columbia University", values: [] }} positioning={withAdmit({ used: 0.0282, basis: "outside_early_decision", overall: 0.0386, earlyDecision: 0.1323 })} loading={false} />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Admit rate: 2.8% outside Early Decision · 3.9% overall · Early Decision 13.2%");
    cleanup();
    render(<CalibratedFitCard collegeValues={{ displayName: "Stanford University", values: [] }} positioning={withAdmit({ used: 0.036, basis: "overall", overall: 0.036, earlyDecision: null })} loading={false} />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Admit rate: 3.6% of all applicants");
    cleanup();
    render(<CalibratedFitCard collegeValues={{ displayName: "Columbia University", values: [] }} positioning={withAdmit({ used: 0.0282, basis: "outside_early_decision", overall: 0.0386, earlyDecision: 0.1323 })} loading={false} locale="ko" />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("합격률: 얼리 디시전 외 지원자 2.8% · 전체 3.9% · 얼리 디시전 13.2%");
  });
});

// The priorities matrix under the card: what in the record speaks to each
// declared admission factor, with scores placed against the school and
// activities carrying the qualities their descriptions show.
describe("CalibratedFitCard priorities matrix", () => {
  afterEach(() => cleanup());

  it("lists the record behind each priority and labels what the profile cannot show", () => {
    const collegeValues = {
      displayName: "Stanford University",
      fallback: "cds_admission_factors",
      values: [
        { theme: "Academic GPA", summary: "Very Important in Stanford University's admission decisions." },
        { theme: "Standardized Test Scores", summary: "Considered." },
        { theme: "Character / Personal Qualities", summary: "Very Important." },
        { theme: "Application Essay", summary: "Very Important." },
        { theme: "Level of Applicant's Interest", summary: "Important." },
      ],
      fit: {
        overall: 100,
        perValueCoverage: [
          { theme: "Academic GPA", hits: 1, evidence: [{ kind: "gpa", label: "GPA 3.9", tone: "fair", position: "within", detail: { average: 3.94, weighted: false } }] },
          { theme: "Standardized Test Scores", hits: 0, evidence: [{ kind: "test", label: "SAT 1400", tone: "weak", position: "below", detail: { band: { low: 1510, high: 1570 } }, advice: "withhold" }] },
          { theme: "Character / Personal Qualities", hits: 2, evidence: [
            { kind: "activity", label: "Food Bank (Volunteer)", tone: "strong", position: null, traits: ["character"] },
            { kind: "activity", label: "Robotics Club (Captain)", tone: "fair", position: null, traits: ["leadership"] },
          ] },
          { theme: "Application Essay", hits: 0, evidence: [], unreadable: true, reason: "essay" },
          { theme: "Level of Applicant's Interest", hits: 0, evidence: [], unreadable: true, reason: "interest" },
        ],
      },
    };
    render(<CalibratedFitCard collegeValues={collegeValues} positioning={null} loading={false} />);
    const matrix = screen.getByTestId("fit-matrix");
    expect(matrix).toHaveTextContent("Admission priorities (CDS)");
    expect(matrix).toHaveTextContent("Academic GPA ✓ 1 match");
    expect(matrix).toHaveTextContent("GPA 3.9 · inside the middle 50% · average 3.94");
    expect(matrix).toHaveTextContent("Standardized Test Scores on file, but below range here");
    expect(matrix).toHaveTextContent("SAT 1400 · below the 25th percentile · middle 50% 1510–1570 · consider withholding");
    expect(matrix).toHaveTextContent("Character / Personal Qualities ✓ 2 matches");
    expect(matrix).toHaveTextContent("Food Bank (Volunteer) · character");
    expect(matrix).toHaveTextContent("Robotics Club (Captain) · leadership");
    expect(matrix).toHaveTextContent("Application Essay not read from your profile");
    expect(matrix).toHaveTextContent("demonstrated interest");
  });
});

// The course load behind the rigor read, and the language the card speaks:
// the app's locale, never the one the server guessed from the browser.
describe("CalibratedFitCard course rigor and locale", () => {
  afterEach(() => cleanup());

  it("shows the course load behind the rigor read, in the comparison block and the matrix", () => {
    const rigor = { apTaken: 6, apCourses: 5, apExamsWithoutCourse: 1, apScored: 4, ib: 0, dualEnrollment: 2, aLevel: 0, honors: 1, units: 8.6, expectation: 7, position: "above", score: 100 };
    const collegeValues = {
      displayName: "S",
      values: [{ theme: "Rigor of Secondary School Record", summary: "Very Important." }],
      fit: { overall: 100, perValueCoverage: [
        { theme: "Rigor of Secondary School Record", hits: 1, evidence: [
          { kind: "rigor", label: "Course rigor: 2 AP (2 with exam scores)", tone: "weak", position: "below", detail: { units: 2.3, apTaken: 2, apScored: 2, expectation: 7 } },
        ] },
      ] },
    };
    render(<CalibratedFitCard collegeValues={collegeValues} positioning={{ ...positioning, profileComparison: { ...positioning.profileComparison, rigor } }} loading={false} />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Course rigor: 6 AP (4 with exam scores), 2 dual enrollment, 1 honors · about 7 college-level courses expected here · at or above that load");
    expect(screen.getByTestId("fit-matrix")).toHaveTextContent("Course rigor: 2 AP (2 with exam scores) · about 7 college-level courses expected here · below it");
  });

  it("says when the read was re-taken after the profile changed, and lists honors in the load", () => {
    const rigor = { apTaken: 0, apCourses: 0, apExamsWithoutCourse: 0, apScored: 0, ib: 0, dualEnrollment: 0, aLevel: 0, honors: 3, units: 1.5, expectation: 4, position: "below", score: 37.5 };
    render(<CalibratedFitCard collegeValues={{ displayName: "S", values: [], refreshedAt: "2026-09-11T07:30:00Z" }} positioning={{ ...positioning, profileComparison: { ...positioning.profileComparison, rigor } }} loading={false} />);
    expect(screen.getByTestId("fit-refreshed")).toHaveTextContent("Re-read after your profile changed");
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Course rigor: 3 honors · about 4 college-level courses expected here · below it");
  });

  it("renders in the app's locale, not the one the server guessed from the browser", () => {
    const body = { displayName: "S", values: [], locale: "ko" };
    render(<CalibratedFitCard collegeValues={body} positioning={positioning} loading={false} locale="en-US" />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("How your record compares");
    expect(screen.getByTestId("profile-comparison")).not.toHaveTextContent("내 기록과의 비교");
    cleanup();
    // Without the prop the body's locale still applies.
    render(<CalibratedFitCard collegeValues={body} positioning={positioning} loading={false} />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("내 기록과의 비교");
  });
});

// The read the engine gives no label (fit-4), the school numbers it does not
// hold (fit-5, fit-6), and a card that never prints a number it was not
// given.
const NEVER = /undefined|NaN|null%/;

// A grade-9 record with nothing entered, at a school with no admit rate on
// file: the engine's payload (positioning-engine.js, positioning_v3).
const thinRead = {
  schoolName: "Elm College",
  overallPositioningLabel: "Not enough data yet",
  labelKey: "insufficient_student_data",
  finalPositioningScore: null,
  studentDataNeeded: ["gpa", "sat_or_act"],
  readinessScore: 31.2,
  admitRateUsed: null,
  admitRateBasis: "unknown",
  admitRate: { used: null, basis: "unknown", overall: null, earlyDecision: null, assumedForLikelihood: 0.5 },
  admissibility: { academicReadinessScore: 30, summary: "not enough academic data yet" },
  competitiveness: { majorCompetitivenessScore: 41 },
  fit: { institutionalPriorityFitScore: 50 },
  confidence: { evidenceConfidence: "Very Low", evidenceConfidenceScore: 22 },
  scoreRanges: { admissibility: { low: 10, high: 50 } },
  mainRedFlags: ["No SAT/ACT on file."],
  recommendedPositioningStrategy: "Add a GPA or an SAT/ACT score first; with neither on file there is nothing yet to place against this school's admitted class.",
  profileComparison: {
    tests: { policy: "unknown", blind: false, stated: null, advice: "none", used: null, sections: [], alternatives: [] },
    gpa: { gpa: null, weightedGpa: null, average: null, comparedGpa: null, position: "unknown", basis: "none", note: null, score: 30 },
    classRank: { topPercent: null },
    apExams: { count: 0 },
    admitRate: { used: null, basis: "unknown", overall: null, earlyDecision: null, assumedForLikelihood: 0.5 },
  },
  dataProvenance: { kind: "none", validated: false, sourceUrl: null },
};

describe("CalibratedFitCard with too little to place", () => {
  afterEach(() => cleanup());

  it("shows a neutral badge that says what to add, and no placement", () => {
    const { container } = render(<CalibratedFitCard collegeValues={{ displayName: "Elm College", values: [] }} positioning={thinRead} loading={false} locale="en-US" />);
    expect(screen.getByTestId("fit-insufficient")).toHaveTextContent("Not enough data yet: add your GPA or a test score");
    const text = container.textContent;
    for (const placed of ["Reach", "Competitive", "academically stretched", "not enough academic data yet", "What's holding it back", "Suggested positioning", "No SAT/ACT on file."]) {
      expect(text).not.toContain(placed);
    }
    expect(screen.queryByText("Admissibility")).not.toBeInTheDocument();
    expect(text).not.toMatch(NEVER);
    // The comparison block still says what the school reports and lacks.
    const block = screen.getByTestId("profile-comparison");
    expect(block).toHaveTextContent("Admit rate: not available");
    expect(block).not.toHaveTextContent("assumed 50%");
    expect(block).toHaveTextContent("Tests: no score on file (test policy not confirmed)");
    expect(block).not.toHaveTextContent("required");
    // Nothing was held for this school, and the source line says so rather
    // than claiming the IPEDS baseline.
    expect(text).toContain("Source: no school data on file");
    expect(text).not.toContain("IPEDS baseline");
  });

  it("says the same in Korean", () => {
    const { container } = render(<CalibratedFitCard collegeValues={{ displayName: "Elm College", values: [] }} positioning={thinRead} loading={false} locale="ko" />);
    expect(screen.getByTestId("fit-insufficient")).toHaveTextContent("아직 데이터가 부족합니다: GPA나 시험 점수를 추가해 주세요");
    const block = screen.getByTestId("profile-comparison");
    expect(block).toHaveTextContent("합격률: 확인 불가");
    expect(block).toHaveTextContent("기록된 점수 없음 (시험 정책 미확인)");
    expect(container.textContent).not.toMatch(NEVER);
  });

  it("a labelled read with no admit rate says the rate is not available and what was assumed", () => {
    const read = {
      ...positioning,
      labelKey: "reach",
      admitRate: { used: null, basis: "unknown", overall: null, earlyDecision: null, assumedForLikelihood: 0.5 },
      profileComparison: { ...positioning.profileComparison, admitRate: { used: null, basis: "unknown", overall: null, earlyDecision: null, assumedForLikelihood: 0.5 } },
      dataProvenance: { kind: "college_scorecard", validated: false, sourceUrl: "https://collegescorecard.ed.gov/" },
    };
    const { container } = render(<CalibratedFitCard collegeValues={{ displayName: "Occidental College", values: [] }} positioning={read} loading={false} />);
    const block = screen.getByTestId("profile-comparison");
    expect(block).toHaveTextContent("Admit rate: not available");
    expect(block).toHaveTextContent("Until a rate is on file, the read starts from an assumed 50%.");
    expect(block).not.toHaveTextContent(/Admit rate: \d/);
    // A Scorecard-sourced read used to print no source line at all.
    expect(screen.getByRole("link", { name: /College Scorecard/ })).toHaveAttribute("href", "https://collegescorecard.ed.gov/");
    expect(container.textContent).not.toMatch(NEVER);
  });

  it("names the test policy only when it was read, and says a test-blind school reads no score", () => {
    const withTests = (tests) => ({ ...positioning, mainRedFlags: [], profileComparison: { ...positioning.profileComparison, tests } });
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={withTests({ ...positioning.profileComparison.tests, policy: "unknown", advice: "submit" })} loading={false} />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Test policy not confirmed for this school");
    cleanup();
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={withTests({ policy: null, advice: "none", used: null, sections: [], alternatives: [] })} loading={false} />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Tests: no score on file (test policy not confirmed)");
    cleanup();
    render(<CalibratedFitCard collegeValues={{ displayName: "University of California, Los Angeles", values: [] }} positioning={withTests({ policy: "test_optional_or_deemphasized", blind: true, advice: "none", used: null, sections: [], alternatives: [] })} loading={false} />);
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Tests: no score on file (scores are not considered here)");
    cleanup();
    render(<CalibratedFitCard collegeValues={{ displayName: "University of California, Los Angeles", values: [] }} positioning={withTests({ ...positioning.profileComparison.tests, policy: "test_optional_or_deemphasized", blind: true, advice: "not_considered", distribution: null })} loading={false} />);
    const block = screen.getByTestId("profile-comparison");
    expect(block).toHaveTextContent("Test-blind here: scores are not considered, so this one does not count.");
    expect(block).not.toHaveTextContent("Test-optional here");
  });

  it("shows a weighted-only GPA as what was compared, and asks for the scale of one above 4.0", () => {
    const withGpa = (gpa) => ({ ...positioning, profileComparison: { ...positioning.profileComparison, gpa } });
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={withGpa({ gpa: null, weightedGpa: 4.6, average: 3.6, averageScale: "unweighted", comparedGpa: 4, band: null, position: "above", placement: null, basis: "weighted_only", note: null, score: 88 })} loading={false} />);
    let block = screen.getByTestId("profile-comparison");
    expect(block).toHaveTextContent("GPA: weighted 4.6, compared as 4 on a 4.0 scale · average 3.6 · at or above the 75th percentile");
    expect(block).toHaveTextContent("Only a weighted GPA is on file.");
    cleanup();
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={withGpa({ gpa: 4.52, weightedGpa: null, average: 3.7, averageScale: "unweighted", comparedGpa: null, band: null, position: "unknown", placement: null, basis: "scale_unknown", note: "gpa_scale_unknown", score: 56 })} loading={false} locale="ko" />);
    block = screen.getByTestId("profile-comparison");
    expect(block).toHaveTextContent("GPA: 4.52 · 평균 3.7");
    expect(block).toHaveTextContent("학교의 GPA 척도를 상담사에게 알려 주세요.");
  });

  it("draws a dash for a score the payload does not carry, and no percent for a missing values fit", () => {
    const { container } = render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={{ ...positioning, competitiveness: {}, fit: { institutionalPriorityFitScore: undefined } }} loading={false} />);
    expect(container.textContent).not.toMatch(NEVER);
    expect(screen.getAllByText("—")).toHaveLength(2);
    cleanup();
    const fallback = render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [], fit: {} }} positioning={null} loading={false} />);
    expect(fallback.container.textContent).toContain("Limited data for this school");
    expect(fallback.container.textContent).not.toMatch(NEVER);
    expect(fallback.container.textContent).not.toContain("%");
  });
});

// fit-7: the values read failed (402 budget, 403 consent, 404 unreadable
// site) while the fit read was computed. The card used to vanish behind the
// raw English error while the chat quoted the label.
describe("CalibratedFitCard when the values read failed", () => {
  afterEach(() => cleanup());

  const read = { ...positioning, schoolName: "The University of Texas at Austin" };

  it("shows the computed read with the values part marked unavailable", () => {
    const onVerify = vi.fn();
    const onAddTarget = vi.fn();
    render(<CalibratedFitCard
      collegeValues={{ error: "The monthly AI budget doesn't allow this lookup right now.", code: "budget_exceeded", status: 402 }}
      positioning={read}
      loading={false}
      schoolName="UT Austin"
      onVerify={onVerify}
      onAddTarget={onAddTarget}
    />);
    const card = screen.getByTestId("fit-card");
    expect(card).toHaveTextContent("The University of Texas at Austin");
    expect(card).toHaveTextContent("Reach");
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Tests: SAT 1500");
    const unavailable = screen.getByTestId("fit-matrix-unavailable");
    expect(unavailable).toHaveTextContent("Core values · unavailable");
    expect(unavailable).toHaveTextContent("This month's AI budget is used up");
    expect(unavailable).not.toHaveTextContent("The monthly AI budget doesn't allow");
    expect(screen.queryByTestId("fit-matrix")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "🔎 Double-check with the web" }));
    expect(onVerify).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "➕ target" }));
    expect(onAddTarget).toHaveBeenCalled();
  });

  it("names each failure in the student's language", () => {
    const cases = [
      [{ code: "consent_required", status: 403 }, "en-US", "needs your AI consent"],
      [{ code: "values_not_found", status: 404 }, "en-US", "official pages couldn't be read"],
      [{ code: "school_site_not_found", status: 404 }, "en-US", "Try its exact official name"],
      [{ code: "research_failed", status: 502 }, "en-US", "The lookup didn't finish this time"],
      [{ code: "budget_exceeded", status: 402 }, "ko", "이번 달 AI 사용 한도를 모두 사용해"],
    ];
    for (const [error, locale, expected] of cases) {
      expect(valuesErrorText({ error: "x", ...error }, locale)).toContain(expected);
    }
    render(<CalibratedFitCard collegeValues={{ error: "x", code: "budget_exceeded", status: 402 }} positioning={read} loading={false} locale="ko" />);
    expect(screen.getByTestId("fit-matrix-unavailable")).toHaveTextContent("핵심 가치 · 표시할 수 없음");
  });

  it("offers no ➕ target when the target list is full", () => {
    render(<CalibratedFitCard collegeValues={{ displayName: "Stanford University", values: [] }} positioning={positioning} loading={false} onAddTarget={() => {}} targetListFull />);
    expect(screen.queryByRole("button", { name: "➕ target" })).not.toBeInTheDocument();
    expect(screen.getByTestId("fit-target-full")).toHaveTextContent("list full (8)");
  });
});

// In Korean mode the card printed the headline band, the summary, the
// flags, the strategy, the confidence, the source line and the whole
// double-check in English beside Korean bars (fit-10). The engine now
// sends stable codes beside its English, and the card translates them.
const codedRead = {
  ...positioning,
  overallPositioningLabel: "Reach",
  labelKey: "reach",
  admissibility: { academicReadinessScore: 62, summary: "academically stretched", summaryKey: "stretched" },
  confidence: { evidenceConfidence: "Very Low", evidenceConfidenceKey: "very_low", evidenceConfidenceScore: 30 },
  mainRedFlags: [
    "SAT Math (700) sits below this school's 25th percentile (770), which a quantitative major will notice.",
    "Weak major-relevant coursework for an ambitious intended major.",
  ],
  mainRedFlagCodes: [
    { code: "math_below_band", params: { test: "SAT", value: 700, low: 770 } },
    { code: "weak_major_coursework" },
  ],
  recommendedPositioningStrategy: "Treat this as a selective reach. Fix the most visible preparation gaps and make the major story sharper and more school-specific.",
  strategyKey: "reach_gaps",
  dataNotes: [],
  dataNoteKeys: [],
  dataProvenance: {
    kind: "cds_store", validated: true, yearLabel: "2025-26", sourceUrl: "https://example.edu/cds.pdf",
    fieldSources: { acceptance_rate: "cds_store", sat_range: "college_scorecard" },
    testPolicy: { bucket: null, source: "unknown" },
  },
};

const ENGLISH_WORDS = /High reach|Highly competitive|\bReach\b|academically stretched|Very Low|Weak major-relevant|Treat this as|IPEDS baseline|CDS · validated|Source:|not available|label unchanged|Official site|Admit rate|SAT middle 50%|Testing policy|unavailable this time/;

const verification = {
  verdict: "discrepancies_found",
  checkedAt: "2026-11-01T10:00:00Z",
  cached: true,
  checks: [
    { field: "acceptance_rate", label: "Admit rate", used: null, live: "49%", liveSource: "College Scorecard (live IPEDS)", liveSourceKind: "college_scorecard", status: "filled" },
    { field: "sat_range", label: "SAT middle 50%", used: "1330–1490", live: "1330–1490", liveSource: "College Scorecard (live IPEDS)", liveSourceKind: "college_scorecard", status: "consistent" },
    { field: "act_range", label: "ACT middle 50%", used: null, live: null, status: "unavailable" },
    {
      field: "test_policy", label: "Testing policy", used: "test-optional / de-emphasized", usedBucket: "test_optional_or_deemphasized",
      live: "official-site parser: tests considered or required vs model (quote verified): test-optional / de-emphasized", liveBucket: null,
      readers: [
        { reader: "official-site parser", readerKey: "official_site_parser", bucket: "test_considered_or_required", value: "tests considered or required" },
        { reader: "model (quote verified)", readerKey: "model_quote_verified", bucket: "test_optional_or_deemphasized", value: "test-optional / de-emphasized" },
      ],
      status: "inconclusive",
    },
    { field: "deadline_early_decision", label: "Early Decision deadline", plan: "early_decision", live: "2026-11-01", liveSource: "https://example.edu/apply", status: "info" },
  ],
  officialSite: { status: "robots_disallowed" },
  modelReview: { status: "failed", error: "x" },
  recomputed: { changedInputs: ["acceptance_rate"], overallPositioningLabel: "Competitive", labelKey: "competitive", labelChanged: true },
  original: { overallPositioningLabel: "Reach", labelKey: "reach" },
};

describe("CalibratedFitCard in Korean", () => {
  afterEach(() => cleanup());

  it("says the label, summary, flags, strategy, confidence and sources in Korean", () => {
    const { container } = render(<CalibratedFitCard collegeValues={{ displayName: "Example University", values: [] }} positioning={codedRead} loading={false} locale="ko" />);
    expect(screen.getByTestId("fit-label")).toHaveTextContent("도전");
    expect(screen.getByTestId("fit-summary")).toHaveTextContent("학업 수준이 합격생 범위에 못 미침");
    expect(screen.getByTestId("fit-redflags")).toHaveTextContent("SAT 수학 점수(700)가 이 학교의 25퍼센타일(770)보다 낮습니다.");
    expect(screen.getByTestId("fit-redflags")).toHaveTextContent("관련 과목 수강이 약합니다");
    expect(screen.getByTestId("fit-strategy")).toHaveTextContent("선발이 까다로운 도전 학교로 생각하세요.");
    expect(screen.getByTestId("fit-confidence")).toHaveTextContent("매우 낮음");
    const source = screen.getByTestId("fit-source");
    expect(source).toHaveTextContent("출처: ↗ CDS · 검증됨 · 2025-26");
    expect(source).toHaveTextContent("College Scorecard에서 보충: SAT 범위");
    expect(source).toHaveTextContent("시험 정책: 어느 출처에서도 확인되지 않음");
    expect(container.textContent).not.toMatch(ENGLISH_WORDS);
    expect(container.textContent).not.toMatch(NEVER);
  });

  it("the same read in English reads as the engine wrote it, and the band keeps its color", () => {
    const { container } = render(<CalibratedFitCard collegeValues={{ displayName: "Example University", values: [] }} positioning={codedRead} loading={false} locale="en-US" />);
    const label = screen.getByTestId("fit-label");
    expect(label).toHaveTextContent("Reach");
    expect(label.style.color).toBe("rgb(246, 173, 85)");
    expect(screen.getByTestId("fit-strategy")).toHaveTextContent(codedRead.recommendedPositioningStrategy);
    expect(screen.getByTestId("fit-redflags")).toHaveTextContent(codedRead.mainRedFlags[0]);
    expect(screen.getByTestId("fit-confidence")).toHaveTextContent("Very low");
    expect(container.textContent).not.toMatch(NEVER);
  });

  it("a payload cached before the codes still reads, translated where its English is known", () => {
    const old = { ...positioning, overallPositioningLabel: "High reach", confidence: { evidenceConfidence: "Medium" }, recommendedPositioningStrategy: "Treat this as a high reach." };
    expect(labelKeyOf(old)).toBe("high_reach");
    const { container } = render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={old} loading={false} locale="ko" />);
    expect(screen.getByTestId("fit-label")).toHaveTextContent("상향 도전");
    expect(screen.getByTestId("fit-label").style.color).toBe("rgb(245, 101, 101)");
    expect(screen.getByTestId("fit-summary")).toHaveTextContent("학업 수준이 합격생 범위에 못 미침");
    expect(screen.getByTestId("fit-confidence")).toHaveTextContent("보통");
    // No code: the flag and strategy stay as the engine wrote them rather
    // than going blank.
    expect(screen.getByTestId("fit-redflags")).toHaveTextContent("SAT Math (700)");
    expect(screen.getByTestId("fit-strategy")).toHaveTextContent("Treat this as a high reach.");
    expect(container.textContent).not.toMatch(NEVER);
    // An unknown code shows the English sentence, never the raw key.
    cleanup();
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={{ ...codedRead, mainRedFlagCodes: [{ code: "something_new" }, { code: "weak_major_coursework" }] }} loading={false} locale="ko" />);
    expect(screen.getByTestId("fit-redflags")).toHaveTextContent("SAT Math (700) sits below");
    expect(screen.getByTestId("fit-redflags")).not.toHaveTextContent("fit.flag_");
  });

  it("the double-check panel reads in Korean: checks, a filled value, readers, the re-read label and the site status", () => {
    const { container } = render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={codedRead} loading={false} locale="ko" onVerify={() => {}} verification={verification} />);
    const panel = screen.getByTestId("fit-verification");
    expect(panel).toHaveTextContent("실시간 출처가 저장된 데이터와 다름");
    expect(panel).toHaveTextContent("저장된 결과");
    expect(panel).toHaveTextContent("합격률: 결과에는 값이 없었음 · 실시간 49% (College Scorecard 실시간)");
    expect(panel).toHaveTextContent("SAT 중간 50%: 적합도 계산값 1330–1490");
    expect(panel).toHaveTextContent("ACT 중간 50%: 확인 불가");
    expect(panel).toHaveTextContent("시험 정책: 적합도 계산값 테스트 옵셔널 / 비중 낮음 · 실시간 공식 사이트 판독: 시험 점수 고려 또는 필수 · AI 판독 (인용 확인됨): 테스트 옵셔널 / 비중 낮음");
    expect(panel).toHaveTextContent("얼리 디시전 마감일: 2026-11-01");
    expect(screen.getByTestId("fit-recomputed")).toHaveTextContent("실시간 입력값 기준: 합격 가능성 보통 (이전: 도전)");
    expect(panel).toHaveTextContent("공식 페이지 2차 판독: 이번에는 사용할 수 없음");
    expect(panel).toHaveTextContent("공식 사이트: 사이트가 자동 판독을 허용하지 않음");
    expect(container.textContent).not.toMatch(ENGLISH_WORDS);
    expect(container.textContent).not.toMatch(NEVER);
  });

  it("a recomputed read whose label did not move says so, and an unknown site status is not printed raw", () => {
    const steady = { ...verification, recomputed: { ...verification.recomputed, labelChanged: false }, officialSite: { status: "fetch failed: ECONNRESET" } };
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={codedRead} loading={false} locale="en-US" onVerify={() => {}} verification={steady} />);
    expect(screen.getByTestId("fit-recomputed")).toHaveTextContent("With live inputs: Competitive (label unchanged)");
    expect(screen.getByTestId("fit-verification")).toHaveTextContent("Official site: couldn't be read this time");
    expect(screen.getByTestId("fit-verification")).not.toHaveTextContent("ECONNRESET");
  });

  it("a double-check that failed says what went wrong and whether to retry, in the card's language", () => {
    expect(verificationErrorText({ status: 401 }, "en-US")).toMatch(/session ended/i);
    expect(verificationErrorText({ status: 402 }, "ko")).toContain("다음 달까지");
    expect(verificationErrorText({ status: 429, code: "rate_limited" }, "en-US")).toMatch(/try again/);
    expect(verificationErrorText({ status: 0, code: "network_error" }, "ko")).toContain("인터넷 연결");
    expect(verificationErrorText({ status: 500 }, "en-US")).toMatch(/Trying again may work/);
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={codedRead} loading={false} locale="ko" onVerify={() => {}} verification={{ error: "HTTP 503", status: 503 }} />);
    expect(screen.getByTestId("fit-verify-error")).toHaveTextContent("이번에는 재확인을 마치지 못했습니다.");
    expect(screen.getByTestId("fit-verify-error")).not.toHaveTextContent("HTTP 503");
  });

  it("a degraded read says a source did not answer", () => {
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={{ ...codedRead, degraded: true }} loading={false} locale="ko" />);
    expect(screen.getByTestId("fit-degraded")).toHaveTextContent("일부 데이터 출처가 응답하지 않아");
  });

  it("a note no row covers is shown once, in the card's language", () => {
    const read = { ...codedRead, dataNotes: ["No admit rate is on file for this school; the likelihood assumes 50% until one is.", "Something new."], dataNoteKeys: ["admit_rate_assumed", "future_note"] };
    render(<CalibratedFitCard collegeValues={{ displayName: "X", values: [] }} positioning={read} loading={false} locale="ko" />);
    const notes = screen.getByTestId("fit-notes");
    // The admit rate here is known (codedRead has no profileComparison
    // admitRate), so the assumed-rate note has no row and is shown.
    expect(notes).toHaveTextContent("50%로 가정해 계산합니다");
    expect(notes).toHaveTextContent("Something new.");
  });
});

// Every fit.* string the card can ask for exists in both languages, so a
// Korean card never falls back to English for a key only English has.
describe("fit strings", () => {
  it("every fit.* key exists in English and Korean", () => {
    const en = Object.keys(STRINGS["en-US"]).filter((k) => k.startsWith("fit."));
    const ko = new Set(Object.keys(STRINGS.ko).filter((k) => k.startsWith("fit.")));
    const missing = en.filter((k) => !ko.has(k));
    expect(missing).toEqual([]);
    const extra = [...ko].filter((k) => !STRINGS["en-US"][k]);
    expect(extra).toEqual([]);
  });
});
