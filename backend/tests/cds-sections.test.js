// The remaining CDS sections (B, C2, C22, D2, F1, G1, H2, I3) in the two
// layouts the documents use: numbers on the label's line (Indiana, the
// workbooks, as ratios or percentages) and numbers wrapped to the next
// line (Harvard, Stanford).
import test from "node:test";
import assert from "node:assert/strict";

import { extractSections } from "../cds/cds-sections.js";

test("numbers on the label's line, percentages and dollar amounts (Indiana 2024-25)", () => {
  const s = extractSections([
    "Total all undergraduates 36,833",
    "Calculate the percentage of the Fall 2023 entering cohort who remained enrolled on the official census date. 91.30%",
    "H - Six-year graduation rate for 2018",
    "69.89% 76.18% 84.05% 80.21%",
    "Number of qualified applicants offered a place on waiting list 7,524",
    "Number accepting a place on the waiting list 3,059",
    "Number of wait-listed students admitted 3,041",
    "Number of early action applications received by your institution 41,200",
    "Number of applicants admitted under early action plan 30,100",
    "D2 Provide the number of students who applied, were admitted, and enrolled as degree-seeking transfer",
    "students in Fall 2024.",
    "Transfer Admission Applicants Admitted Applicants Enrolled Applicants",
    "Men 2,010 1,404 702",
    "Women 2,120 1,517 760",
    "Total 4,130 2,921 1,462",
    "Percent who are from out of state (exclude international/nonresidents",
    "43.19% 41.90%",
    "from the numerator and denominator)",
    "Percent who live in college-owned, -operated, or -affiliated housing 98.02% 29.78%",
    "List the typical tuition, required fees, and food and housing for a full-time undergraduate student for",
    "the FULL 2025-2026 academic year (30 semester or 45 quarter hours)",
    "PRIVATE INSTITUTIONS",
    "Tuition:",
    "PUBLIC INSTITUTIONS",
    "Tuition: In-district: $10,622 $10,622",
    "Tuition: In-state (out-of-district): $10,622 $10,622",
    "Tuition: Out-of-state: $40,369 $40,369",
    "Tuition: Non-resident:",
    "FOR ALL INSTITUTIONS",
    "Required Fees: $1,522 $1,522",
    "Food and Housing (on-campus): $13,984 $13,984",
    "I On average, the percentage of need that was met of students who were awarded any need-based aid. 63.20% 61.50%",
    "Class Sections: A class section is an organized course offered for credit, identified by discipline",
    "CLASS SECTIONS",
    "462 1,077 1,212 381 481 512 312 4,437",
  ]);
  assert.deepEqual(s.enrollment, { undergraduates: 36833 });
  assert.deepEqual(s.retention, { firstYearPct: 91.3 });
  assert.deepEqual(s.graduation, { sixYearPct: 80.2, cohort: 2018 });
  assert.deepEqual(s.waitlist, { offered: 7524, accepted: 3059, admitted: 3041 });
  assert.deepEqual(s.earlyAction, { applications: 41200, admitted: 30100, admitRate: 0.7306 });
  assert.deepEqual(s.transfer, { applied: 4130, admitted: 2921, enrolled: 1462 });
  assert.deepEqual(s.studentLife, { outOfStatePct: 43.2, onCampusPct: 98 });
  assert.deepEqual(s.costs, { tuitionInStateUsd: 10622, tuitionOutOfStateUsd: 40369, requiredFeesUsd: 1522, foodAndHousingUsd: 13984, academicYear: "2025-2026" });
  assert.deepEqual(s.aid, { needMetPct: 63.2 });
  assert.equal(s.classSize.under20Pct, 34.7);
  assert.equal(s.classSize.sections.total, 4437);
});

test("numbers wrapped to the next line, ratios, a blank wait-list slot and a private tuition (Harvard and Stanford 2025-26, a workbook)", () => {
  const s = extractSections([
    "Total all undergraduates ( 7,346 )",
    "Calculate the percentage of the Fall 2025 entering cohort who remained enrolled on the o ff icial census date.",
    "97.46%",
    "Six-year graduation rate for 2019 cohort (G",
    "H 0.960992908 1 0.972653363 0.97080292",
    "Number of qualified applicants offered a place on waiting list:",
    "Number accepting a place on the waiting list:",
    "Number of wait-listed students admitted: 75",
    "Percent who are from out of state",
    "(exclude international/nonresidents from 56% 56%",
    "the numerator and denominator)",
    "Percent who live in college-owned,",
    "100% 93%",
    "-operated, or -a ff iliated housing",
    "List the typical tuition, required fees, and food and housing for a full-time undergraduate student for the",
    "FULL 2026-2027 academic year. (30 semester hours or 45 quarter hours)",
    "G1 PRIVATE INSTITUTIONS First-Year Undergraduates",
    "Tuition: $67,731 $67,731",
    "PUBLIC INSTITUTIONS First-Year Undergraduates",
    "Tuition: In-district",
    "Tuition: In-state (out-of-district):",
    "Tuition: Out-of-state:",
    "Tuition: Nonresident",
    "FOR ALL INSTITUTIONS First-Year Undergraduates",
    "Required Fees: $843 $843",
    "Food and housing (on-campus): $22,944 $22,944",
    "I On average, the percentage of need that was met of students who were awarded any need-based aid. Exclude any aid that was awarded in excess of need as well as any resources that were awarded to replace EFC (PLUS loans, unsubsidized loans, and private alternative loans) 0.71 0.68",
    "Fall 2025 Student to Faculty ratio 10 to 1 (based on 14,211 students",
    "CLASS SECTIONS 170 592 491 171 86 264 158 1932",
  ]);
  assert.deepEqual(s.enrollment, { undergraduates: 7346 });
  assert.deepEqual(s.retention, { firstYearPct: 97.5 });
  assert.deepEqual(s.graduation, { sixYearPct: 97.1, cohort: 2019 });
  // The blank offered / accepted slots read as nothing, not as the next label's count.
  assert.deepEqual(s.waitlist, { admitted: 75 });
  assert.equal(s.earlyAction, undefined);
  assert.equal(s.transfer, undefined);
  assert.deepEqual(s.studentLife, { outOfStatePct: 56, onCampusPct: 100 });
  assert.deepEqual(s.costs, { tuitionUsd: 67731, requiredFeesUsd: 843, foodAndHousingUsd: 22944, academicYear: "2026-2027" });
  assert.deepEqual(s.aid, { needMetPct: 71 });
  assert.equal(s.classSize.under20Pct, 39.4);
});

test("coded item ids beside the cost labels are not amounts, and a stray graduation cell is not a rate", () => {
  const s = extractSections([
    "Six-year graduation rate for 2019 cohort (G",
    "H 0% 0.1%",
    "G1 PRIVATE INSTITUTIONS First-Year Undergraduates",
    "Tuition: G.117",
    "PUBLIC INSTITUTIONS First-Year Undergraduates",
    "Tuition: In-state (out-of-district): G.201",
    "Tuition: Out-of-state: G.202 31050",
    "Required Fees: $202 $202",
    "Food and housing (on-campus): G.205 18874",
  ]);
  assert.equal(s.graduation, undefined);
  assert.deepEqual(s.costs, { tuitionOutOfStateUsd: 31050, requiredFeesUsd: 202, foodAndHousingUsd: 18874 });
});

test("the layouts the first pass missed: stacked class table, headcount columns, a wrapped retention question, need met below its label", () => {
  const s = extractSections([
    "Total undergraduate",
    "18,555 518 18,570 444 0 0 2 4",
    "students",
    "For the cohort of all full-time bachelor's (or equivalent) degree-seeking",
    "undergraduate students who entered your institution as first-year",
    "students in Fall 2023 (or the preceding summer term), what percentage 91.1%",
    "was enrolled at your institution as of the date your institution calculates",
    "its official enrollment in Fall 2024?",
    "Number of students in line d whose need was fully met",
    "H (exclude PLUS loans, unsubsidized loans, and private 936 3950",
    "alternative loans )",
    "On average, the percentage of need that was met of",
    "students who were awarded any need-based aid.",
    "Exclude any aid that was awarded in excess of need as",
    "I 100.0% 100.0%",
    "well as any resources that were awarded to replace EFC",
    "Number of Class Sections with Undergraduates Enrolled",
    "Undergraduate Class Size (provide numbers)",
    "2-9 10-19 20-29 30-39 40-49 50-99 100+ Total",
    "CLASS",
    "482 303 84 42 28 78 49 1066",
    "SECTIONS",
    "2-9 10-19 20-29 30-39 40-49 50-99 100+ Total",
    "CLASS SUB-",
    "89 67 52 30 23 66 45 372",
    "SECTIONS",
  ]);
  assert.deepEqual(s.enrollment, { undergraduates: 38093 });
  assert.deepEqual(s.retention, { firstYearPct: 91.1 });
  assert.deepEqual(s.aid, { needMetPct: 100 });
  assert.equal(s.classSize.sections.total, 1066);
  assert.equal(s.classSize.under20Pct, 73.6);
});

test("a term label before the class-size counts, a row that fails the sum check, a stray need-met cell and a tiny headcount row are not data", () => {
  const s = extractSections([
    "Total all undergraduates 15 2,383",
    "I On average, the percentage of need that was met of students 0.01 1.0%",
    "2-9 10-19 20-29 30-39 40-49 50-99 100+ Total",
    "CLASS",
    "Fall 2024 134 557 428 264 30 35 3 1,451",
  ]);
  assert.deepEqual(s.enrollment, { undergraduates: 2383 });
  assert.equal(s.aid, undefined);
  assert.deepEqual(s.classSize.sections, { "2-9": 134, "10-19": 557, "20-29": 428, "30-39": 264, "40-49": 30, "50-99": 35, "100+": 3, total: 1451 });
  assert.equal(s.classSize.under20Pct, 47.6);
  const bad = extractSections([
    "2-9 10-19 20-29 30-39 40-49 50-99 100+ Total",
    "12 34 56 78 90 12 34 999 5",
    "CLASS SECTIONS 1 2 3 4 5 6 7 8 9 10",
  ]);
  assert.equal(bad.classSize, undefined);
});

test("a document without these sections contributes nothing", () => {
  assert.deepEqual(extractSections(["Common Data Set 2025-2026", "C1 First-time, first-year students"]), {});
});
