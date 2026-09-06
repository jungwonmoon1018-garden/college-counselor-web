import test from "node:test";
import assert from "node:assert/strict";
import { extractExtras, parseCdsMonthDay } from "../cds-pdf-parser.js";
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
  assert.deepEqual(extras.satSections, { ebrw: { p25: 740, p75: 780 }, math: { p25: 770, p75: 800 } });
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
  assert.deepEqual(extras.satSections, { ebrw: { p25: 680, p75: 750 }, math: { p25: 680, p75: 780 } });
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
