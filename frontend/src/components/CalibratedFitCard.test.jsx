import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CalibratedFitCard from "./CalibratedFitCard.jsx";

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
