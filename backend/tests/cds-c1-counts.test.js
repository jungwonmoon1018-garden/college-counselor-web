// C1 applicant / admit / enrollee counts from the positional text items,
// in the wording of the 2023-24 template and of the 2025-26 one, and in
// the three layouts the 2025-26 documents arrive in.
import test from "node:test";
import assert from "node:assert/strict";

import { extractC1Counts } from "../cds-pdf-parser.js";

// One text item per row label and one per number, on the same y line.
function rows(list) {
  const items = [];
  let y = 700;
  for (const [label, value] of list) {
    items.push({ page: 1, x: 40, y, str: label });
    if (value != null) items.push({ page: 1, x: 500, y, str: String(value) });
    y -= 12;
  }
  return items;
}

// Several items on one y line, left to right: a label and its columns, or
// (workbook exports) two labels with their values on the same sheet row.
function table(list) {
  const items = [];
  let y = 700;
  for (const strs of list) {
    strs.forEach((str, i) => items.push({ page: 1, x: 40 + i * 90, y, str }));
    y -= 12;
  }
  return items;
}

test("the 2023-24 wording: men / women / another gender / unknown gender", () => {
  const counts = extractC1Counts(rows([
    ["First-Time, First-Year Student Applicants", null],
    ["Total first-time, first-year men who applied", "10,000"],
    ["Total first-time, first-year women who applied", "12,000"],
    ["Total first-time, first-year students of another gender who applied", "20"],
    ["Total first-time, first-year unknown gender who applied", null],
    ["Total first-time, first-year men who were admitted", "1,000"],
    ["Total first-time, first-year women who were admitted", "1,200"],
    ["Total full-time, first-time, first-year men who enrolled", "500"],
    ["Total full-time, first-time, first-year women who enrolled", "600"],
  ]));
  assert.deepEqual(counts, { applied: 22020, admitted: 2200, enrolled: 1100 });
});

test("the 2025-26 wording: males / females / students of unknown sex", () => {
  const counts = extractC1Counts(rows([
    ["First-Time, First-Year Student Applicants Total", null],
    ["Total first-time, first-year males who applied", "30,474"],
    ["Total first-time, first-year females who applied", "46,302"],
    ["Total first-time, first-year students of unknown sex who", null],
    ["First-Time, First-Year Student Admits Total", null],
    ["Total first-time, first-year males who were admitted", "4,070"],
    ["Total first-time, first-year females who were admitted", "5,783"],
    ["Total first-time, first-year students of unknown sex who", null],
    ["were admitted", null],
    ["First-Time, First-Year Student Enrollees Total", null],
    ["Total first-time, first-year males who enrolled", "1,356"],
    ["Total first-time, first-year females who enrolled", "2,093"],
    ["First-Time, First-Year Student Enrollees by Status Total", null],
    ["Total full-time, first-time, first-year males who enrolled", "1,355"],
    ["Total part-time, first-time, first-year males who enrolled", "1"],
    ["Total full-time, first-time, first-year females who enrolled", "2,091"],
    ["Total part-time, first-time, first-year females who enrolled", "2"],
  ]));
  // Boston University's Fall 2025 figures: 76,776 applied, 9,853 admitted,
  // 3,449 enrolled (the residency table's totals).
  assert.equal(counts.applied, 76776);
  assert.equal(counts.admitted, 9853);
  assert.equal(counts.enrolled, 3449);
});

test("a wrapped 'unknown sex' row with its count on one line is read too", () => {
  const counts = extractC1Counts(rows([
    ["Total first-time, first-year males who applied", "14155"],
    ["Total first-time, first-year females who applied", "14063"],
    ["Total first-time, first-year students of unknown sex who applied", "12"],
    ["Total first-time, first-year males who were admitted", "917"],
    ["Total first-time, first-year females who were admitted", "782"],
  ]));
  assert.deepEqual(counts, { applied: 28230, admitted: 1699 });
});

test("one row per count with Men / Women / Unknown / Total columns; the residency rows that repeat the labels are ignored", () => {
  // UNC Chapel Hill's 2025-26 layout. The enrollee numbers wrap to the next line.
  const counts = extractC1Counts(table([
    ["Men", "Women", "Unknown", "Total"],
    ["Total first-time, first-year who applied", "31,665", "44,582", "0", "76,247"],
    ["Total first-time, first-year who were admitted", "5,305", "7,446", "0", "12,751"],
    ["Total full-time, first-time, first-year who enrolled"],
    ["1,908", "3,176", "0", "5,084"],
    ["Total part-time, first-time, first-year who enrolled"],
    ["4", "3", "0", "7"],
    ["First-Time, First-Year Student Applicants", "In-State", "Out-of-State", "International", "Unknown"],
    ["Total first-time, first-year who applied", "17,846", "48,645", "9,756", "0"],
    ["Total first-time, first-year who were admitted", "6,605", "4,685", "1,461", "0"],
    ["Total first-time, first-year who enrolled", "4,063", "728", "300", "0"],
  ]));
  assert.deepEqual(counts, { applied: 76247, admitted: 12751, enrolled: 5091 });
});

test("a row whose label, colon and columns share one text item", () => {
  // Carnegie Mellon's 2025-26 layout.
  const counts = extractC1Counts(table([
    ["Total first-time, first-year (freshman) who applied: 21,054 12,942 871 0 34,867"],
    ["Total first-time, first-year (freshman) who were admitted: 2,140 1,628 91 0 3,859"],
    ["Total full-time, first-time first-year (freshman) who enrolled: 1,060 700 44 0 1804"],
    ["Total part-time, first-time first-year (freshman) who enrolled: 0 0 0 0 0"],
  ]));
  assert.deepEqual(counts, { applied: 34867, admitted: 3859, enrolled: 1804 });
});

test("a workbook export: two labels per sheet row, every label twice, coded residency rows", () => {
  // Cornell's 2025-26 workbook: the form view and the coded data view share
  // rows, "-" marks an empty cell, and the coded view drops "who".
  const counts = extractC1Counts(table([
    ["C.101", "Total first-time, first-year males who applied", "36834", "First-Time, First-Year Admission"],
    ["C.103", "Total first-time, first-year students of unknown sex applied", "2", "First-Time, First-Year Admission"],
    ["Total first-time, first-year males who applied", "36834", "C.110", "Total full-time, first-time, first-year males who enrolled", "1806", "First-Time, First-Year Admission"],
    ["Total first-time, first-year females who applied", "35687", "C.111", "Total part-time, first-time, first-year males who enrolled", "-", "First-Time, First-Year Admission"],
    ["Total first-time, first-year students of unknown sex who applied", "2", "C.112", "Total full-time, first-time, first-year females who enrolled", "2020", "First-Time, First-Year Admission"],
    ["C.114", "Total full-time, first-time, first-year students of unknown sex enrolled", "1", "First-Time, First-Year Admission"],
    ["Total first-time, first-year males who were admitted", "2794", "C.115", "Total part-time, first-time, first-year students of unknown sex enrolled", "-"],
    ["Total first-time, first-year females who were admitted", "3282", "C.116", "Total first-time, first-year students who applied", "72523"],
    ["Total first-time, first-year students of unknown sex who were admitted", "1", "C.117", "Total first-time, first-year students who were admitted", "6077"],
    ["C.119", "Total first-time, first-year who applied", "12978", "First-Time, First-Year Admission"],
    ["Total first-time, first-year males who enrolled", "1806", "C.120", "Total first-time, first-year who were admitted", "1720"],
    ["Total full-time, first-time, first-year females who enrolled", "2020", "C.127", "Total first-time, first-year who enrolled", "389"],
    ["Total part-time, first-time, first-year females who enrolled", "-", "C.128", "Total first-time, first-year who applied"],
  ]));
  assert.deepEqual(counts, { applied: 72523, admitted: 6077, enrolled: 3827 });
});
