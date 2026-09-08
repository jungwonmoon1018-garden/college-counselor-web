import test from "node:test";
import assert from "node:assert/strict";
import { extractExtras, parseCdsMonthDay, gpaBandFromDistribution } from "../cds-pdf-parser.js";
import { cdsDeadlinesForCycle } from "../cds-store.js";

// Positional items in the shape pdfjs produces: one line per y, words
// spaced along x. Two document generations are mimicked: labels with their
// numbers on the next line (older form) and on the same line (newer form).
function itemsFromLines(lines) {
  const items = [];
  lines.forEach((line, row) => {
    let x = 20;
    for (const word of line.split(/\s+/).filter(Boolean)) {
      items.push({ page: 1, x, y: 800 - row * 12, str: word, width: word.length * 5 });
      x += word.length * 5 + 6;
    }
  });
  return items;
}

test("parseCdsMonthDay reads numeric and spelled-out dates and rejects blanks", () => {
  assert.deepEqual(parseCdsMonthDay("01/03"), { mmdd: "01-03", raw: "01/03" });
  assert.deepEqual(parseCdsMonthDay("January 5, for all"), { mmdd: "01-05", raw: "January 5, for all" });
  assert.deepEqual(parseCdsMonthDay("Nov. 1"), { mmdd: "11-01", raw: "Nov. 1" });
  assert.equal(parseCdsMonthDay(""), null);
  assert.equal(parseCdsMonthDay("Mid-December"), null);
});

test("extractExtras reads the older layout (numbers on the line after the label)", () => {
  const extras = extractExtras(itemsFromLines([
    "C9 Percent and number of first-time, first-year students enrolled in Fall 2024 who submitted national standardized (SAT/ACT)",
    "Submitting SAT Scores 61% 1,046",
    "Submitting ACT Scores 24% 410",
    "SAT Evidence-Based Reading",
    "740 760 780",
    "SAT Math 770 780 800",
    "ACT Composite 34 35 35",
    "Percent of first-time, first-year students with scores in each range:",
    "SAT Evidence-Based Reading and Writing SAT Math",
    "700-800 96% 97%",
    "C10 Percent of all degree-seeking, first-time, first-year students who had high school class rank",
    "Percent in top tenth of high school graduating class 89%",
    "Percent in top quarter of high school graduating class 98%",
    "C13 Application Fee",
    "Amount of application fee: $75.00",
    "C14 Application closing date",
    "Application closing date (fall): 01/03",
    "Priority date:",
    "C21 Early Decision",
    "First or only early decision plan closing date November 1",
    "First or only early decision plan notification date Mid-December",
    "Other early decision plan closing date",
    "Other early decision plan notification date",
    "Number of early decision applications received by your institution 6,251",
    "Number of applicants admitted under early decision plan 898",
    "C22 Early action",
    "Early action closing date",
    "Early action notification date",
    "The average financial aid package of those in line D . Exclude any",
    "J resources that were awarded to replace EFC (PLUS loans, $ 68,926 $ 70,881 $ 47,000",
    "Priority date for filing required financial aid forms 02/01",
    "Deadline for filing required financial aid forms",
    "I2 Student to Faculty Ratio",
    "Fall 2024 Student to Faculty ratio 6 to 1 (based on 7,199 students",
  ]));
  assert.deepEqual(extras.satSections, { ebrw: { p25: 740, p50: 760, p75: 780 }, math: { p25: 770, p50: 780, p75: 800 } });
  assert.deepEqual(extras.submitting, { satPct: 61, actPct: 24 });
  assert.deepEqual(extras.classRank, { topTenthPct: 89, topQuarterPct: 98 });
  assert.equal(extras.applicationFeeUsd, 75);
  assert.deepEqual(extras.earlyDecision, { applications: 6251, admitted: 898, admitRate: 0.1437 });
  assert.equal(extras.dates.regularClosing.mmdd, "01-03");
  assert.equal(extras.dates.edClosing.mmdd, "11-01");
  assert.equal(extras.dates.edNotification, "Mid-December");
  assert.equal(extras.dates.edIIClosing, undefined, "a blank ED II slot must not read the next label");
  assert.equal(extras.dates.eaClosing, undefined);
  assert.equal(extras.dates.aidPriority.mmdd, "02-01");
  assert.equal(extras.dates.aidDeadline, undefined);
  assert.deepEqual(extras.aid, { averagePackageFirstYearUsd: 68926 });
  assert.equal(extras.studentFacultyRatio, "6 to 1");
});

test("extractExtras reads the newer layout (label and numbers on one line, scale notes, ED II)", () => {
  const extras = extractExtras(itemsFromLines([
    "Submitting SAT Scores 36% 1257",
    "SAT Evidence-Based Reading and Writing (200 - 800) 680 720 750",
    "SAT Math (200 - 800) 680 740 780",
    "C14. Application closing date",
    "Application closing date (fall) January 5, for all",
    "First or only early decision plan closing date November 1",
    "First or only early decision plan notification date December 15",
    "Other early decision plan closing date January 5",
    "Other early decision plan notification date February 15",
    "Number of early decision applications received by your",
    "6,907",
    "Number of applicants admitted under early decision plan 2,165",
    "Early action closing date",
    "Deadline for filing required financial aid forms January 5 (November 1 for ED)",
    "Fall 2025 Student to Faculty r 10 to 1",
  ]));
  assert.deepEqual(extras.satSections, { ebrw: { p25: 680, p50: 720, p75: 750 }, math: { p25: 680, p50: 740, p75: 780 } });
  assert.equal(extras.dates.regularClosing.mmdd, "01-05");
  assert.equal(extras.dates.edIIClosing.mmdd, "01-05");
  assert.equal(extras.dates.aidDeadline.mmdd, "01-05");
  assert.deepEqual(extras.earlyDecision, { applications: 6907, admitted: 2165, admitRate: 0.3135 });
  assert.equal(extras.studentFacultyRatio, "10 to 1");
});

test("cdsDeadlinesForCycle rolls reported month-days onto the current cycle", () => {
  const record = {
    school: "Boston University", yearLabel: "2025-26", sourceUrl: "https://www.bu.edu/cds.pdf",
    extras: { dates: { regularClosing: { mmdd: "01-05" }, edClosing: { mmdd: "11-01" }, edIIClosing: { mmdd: "01-05" }, aidDeadline: { mmdd: "01-05" } } },
  };
  const fall = cdsDeadlinesForCycle(record, new Date("2026-09-07T00:00:00Z"));
  assert.deepEqual(fall.deadlines, { ea: null, ed: "2026-11-01", edII: "2027-01-05", rd: "2027-01-05", financialAid: "2027-01-05", commitBy: null, decisionRelease: null });
  assert.equal(fall.cycle, "2026-27");
  assert.equal(fall.label, "Boston University Common Data Set 2025-26");
  // January is still inside the active cycle; February rolls to the next.
  assert.equal(cdsDeadlinesForCycle(record, new Date("2027-01-10T00:00:00Z")).deadlines.rd, "2027-01-05");
  assert.equal(cdsDeadlinesForCycle(record, new Date("2027-02-10T00:00:00Z")).deadlines.rd, "2028-01-05");
  assert.equal(cdsDeadlinesForCycle({ extras: {} }), null);
});

// Items with explicit x positions, one row per array: the score-range
// tables are read column by column, so a row whose composite cell is blank
// ("24-29 2% 7% 1% 3%" in Columbia's ACT table) must land its four values
// on English, Math, Reading and Science.
function itemsFromRows(rows) {
  const items = [];
  rows.forEach((row, index) => {
    for (const [str, x] of row) items.push({ page: 1, x, y: 800 - index * 12, str, width: str.length * 5 });
  });
  return items;
}

test("extractExtras reads ACT section bands, score-range tables, class-rank and GPA shares with their decimals", () => {
  const extras = extractExtras(itemsFromRows([
    [["Submitting SAT Scores", 20], ["50.3%", 200], ["857", 260]],
    [["Submitting ACT Scores", 20], ["19.0%", 200], ["324", 260]],
    [["Assessment", 20], ["25th Percentile", 200], ["50th Percentile", 300], ["75th Percentile", 400]],
    [["SAT Composite", 20], ["1,510", 200], ["1,540", 300], ["1,570", 400]],
    [["SAT Evidence-Based", 20]],
    [["740", 200], ["760", 300], ["780", 400]],
    [["Reading and Writing", 20]],
    [["SAT Math", 20], ["770", 200], ["790", 300], ["800", 400]],
    [["ACT Composite", 20], ["34", 200], ["35", 300], ["35", 400]],
    [["ACT Math", 20], ["33", 200], ["35", 300], ["36", 400]],
    [["ACT English", 20], ["35", 200], ["35", 300], ["36", 400]],
    [["ACT Writing", 20]],
    [["ACT Science", 20], ["33", 200], ["35", 300], ["36", 400]],
    [["ACT Reading", 20], ["34", 200], ["36", 300], ["36", 400]],
    [["Percent of first-time, first-year students with scores in each range:", 20]],
    [["SAT Evidence-Based", 200]],
    [["Score Range", 20], ["SAT Math", 300]],
    [["Reading and Writing", 200]],
    [["700-800", 20], ["95.8%", 210], ["97.2%", 310]],
    [["600-699", 20], ["4.1%", 210], ["2.5%", 310]],
    [["500-599", 20], ["0.1%", 210], ["0.4%", 310]],
    [["400-499", 20], ["0.0%", 210], ["0.0%", 310]],
    [["Score Range", 20], ["SAT Composite", 200]],
    [["1400-1600", 20], ["97.3%", 210]],
    [["1200-1399", 20], ["2.5%", 210]],
    [["1000-1199", 20], ["0.2%", 210]],
    [["Score Range", 20], ["ACT Composite", 120], ["ACT English", 200], ["ACT Math", 280], ["ACT Reading", 360], ["ACT Science", 440]],
    [["30-36", 20], ["100%", 130], ["98%", 210], ["93%", 290], ["99%", 370], ["97%", 450]],
    [["24-29", 20], ["2%", 210], ["7%", 290], ["1%", 370], ["3%", 450]],
    [["18-23", 20]],
    [["C10 Percent of all degree-seeking, first-time, first-year students who had high school class rank", 20]],
    [["Percent in top tenth of high school graduating class", 20], ["97.8%", 400]],
    [["Percent in top quarter of high school graduating class", 20], ["100.0%", 400]],
    [["Percent in top half of high school graduating class", 20], ["100.0%", 400]],
    [["Percent of total first-time, first-year students who submitted high", 20]],
    [["school class rank:", 20], ["18.8%", 400]],
    [["C11 Percentage of all enrolled, degree-seeking, first-time, first-year students who had high school", 20]],
    [["grade-point averages within each of the following ranges (using 4.0 scale).", 20]],
    [["Percent who had GPA of 4.0", 20], ["73.3%", 400]],
    [["Percent who had GPA between 3.75", 20], ["16.5%", 400]],
    [["Percent who had GPA between 3.50 and 3.74", 20], ["6.7%", 400]],
    [["Percent who had GPA between 3.25 and 3.49", 20], ["3.0%", 400]],
    [["Percent who had GPA between 3.00 and 3.24", 20], ["0.1%", 300], ["0.5%", 350], ["0.3%", 400]],
    [["Percent who had GPA between 2.50 and 2.99", 20], ["0.3%", 400]],
    [["Percent who had GPA between 2.0 and 2.49", 20]],
    [["Percent who had GPA between 1.0 and 1.99", 20]],
    [["Percent who had GPA below 1.0", 20]],
    [["Totals should = 100%", 20], ["0.0%", 300], ["0.0%", 350], ["100.0%", 400]],
    [["C12 Average high school GPA of all degree-seeking, first-time, first-year", 20]],
    [["3.94", 300]],
    [["students who submitted GPA:", 20]],
    [["Percent of total first-time, first-year students who submitted high", 20]],
    [["68.1%", 300]],
    [["school GPA:", 20]],
  ]));
  assert.deepEqual(extras.submitting, { satPct: 50.3, actPct: 19 });
  assert.deepEqual(extras.satSections, { ebrw: { p25: 740, p50: 760, p75: 780 }, math: { p25: 770, p50: 790, p75: 800 } });
  // A blank ACT Writing row never reads the next row's numbers.
  assert.deepEqual(extras.actSections, {
    english: { p25: 35, p50: 35, p75: 36 }, math: { p25: 33, p50: 35, p75: 36 },
    reading: { p25: 34, p50: 36, p75: 36 }, science: { p25: 33, p50: 35, p75: 36 },
  });
  assert.deepEqual(extras.scoreDistribution.satComposite, [{ low: 1400, high: 1600, pct: 97.3 }, { low: 1200, high: 1399, pct: 2.5 }, { low: 1000, high: 1199, pct: 0.2 }]);
  assert.deepEqual(extras.scoreDistribution.satSections.ebrw, [{ low: 700, high: 800, pct: 95.8 }, { low: 600, high: 699, pct: 4.1 }, { low: 500, high: 599, pct: 0.1 }, { low: 400, high: 499, pct: 0 }]);
  assert.deepEqual(extras.scoreDistribution.satSections.math.map((r) => r.pct), [97.2, 2.5, 0.4, 0]);
  assert.deepEqual(extras.scoreDistribution.actComposite, [{ low: 30, high: 36, pct: 100 }]);
  assert.deepEqual(extras.scoreDistribution.actSections.english, [{ low: 30, high: 36, pct: 98 }, { low: 24, high: 29, pct: 2 }]);
  assert.deepEqual(extras.scoreDistribution.actSections.math.map((r) => r.pct), [93, 7]);
  assert.deepEqual(extras.scoreDistribution.actSections.science.map((r) => r.pct), [97, 3]);
  assert.deepEqual(extras.classRank, { topTenthPct: 97.8, topQuarterPct: 100, topHalfPct: 100, submittedPct: 18.8 });
  // C11 keeps the all-enrolled column (the last one) when three are filled,
  // reads a label cut short by the layout, and counts blank rows as 0.
  assert.deepEqual(extras.gpaDistribution, [
    { low: 4, high: 4, pct: 73.3 }, { low: 3.75, high: 3.99, pct: 16.5 }, { low: 3.5, high: 3.74, pct: 6.7 }, { low: 3.25, high: 3.49, pct: 3 },
    { low: 3, high: 3.24, pct: 0.3 }, { low: 2.5, high: 2.99, pct: 0.3 }, { low: 2, high: 2.49, pct: 0 }, { low: 1, high: 1.99, pct: 0 }, { low: 0, high: 0.99, pct: 0 },
  ]);
  assert.deepEqual(extras.gpa, { average: 3.94, submittedPct: 68.1 });
  assert.deepEqual(gpaBandFromDistribution(extras.gpaDistribution), { p25: 3.75, p75: 4, source: "C11_cumulative" });
});

test("a blank GPA table and a blank C12 slot read as no data, not zeros", () => {
  const extras = extractExtras(itemsFromLines([
    "C11. Percentage of all enrolled, degree-seeking, first-time, first-year students who had high school grade-point",
    "Percent who had GPA of 4.0",
    "Percent who had GPA between 3.75 and 3.99",
    "Percent who had GPA between 3.50 and 3.74",
    "Percent who had GPA below 1.0",
    "100%",
    "C12. Average high school GPA of all degree-seeking, first-time, first-year students who submitted GPA:",
    "%",
    "Average High School GPA",
    "Percent of total first-time, first-year students who submitted high school GPA:",
    "%",
  ]));
  assert.equal(extras.gpaDistribution, undefined);
  assert.equal(extras.gpa, undefined);
  assert.equal(gpaBandFromDistribution(null), null);
});
