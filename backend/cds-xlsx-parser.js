// ═══════════════════════════════════════════════════════════════════════
// cds-xlsx-parser.js — parse Excel-published Common Data Sets
// ═══════════════════════════════════════════════════════════════════════
// Several schools (Stony Brook, UC Berkeley, UIUC, MIT, Vanderbilt) publish
// their CDS as an Excel workbook instead of a PDF. Rather than reimplement
// the section extractors, this adapter converts workbook cells into the same
// positional item stream the PDF parser consumes — page = sheet, y descending
// by row, x by column — and reuses cds-pdf-parser's extractors verbatim.
// Spreadsheet coordinates are exact (no OCR/kerning noise), so the positional
// C7 grid matching is more reliable here than on PDFs.

import { createRequire } from "node:module";
import {
  C7_FACTOR_PATTERNS,
  groupByLine,
  extractC7Positional,
  extractC1Counts,
  extractC1SubBreakdowns,
  extractC9Bands,
  extractC12AverageGPA,
  extractC12GPA,
  extractTestPolicyPositional,
  extractTestPolicy,
  extractYear,
} from "./cds-pdf-parser.js";

const require = createRequire(import.meta.url);

const COL_SPACING = 60;   // synthetic x units per column
const ROW_SPACING = 10;   // synthetic y units per row
const Y_ORIGIN = 100000;  // top of each synthetic "page" (pdf y grows upward)

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part?.text || "").join("");
    if (value.result != null) return String(value.result);
    if (value.text != null) return String(value.text);
    if (value.hyperlink != null) return String(value.text ?? value.hyperlink);
  }
  return String(cell.text ?? "");
}

// Convert every worksheet into the PDF parser's item shape.
export async function extractItemsFromXlsx(xlsxPath) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  const items = [];
  let page = 0;
  workbook.eachSheet((sheet) => {
    page += 1;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        // Merged ranges repeat the master value in every member cell — emit
        // only the master so an X mark or header appears exactly once, at
        // the column where the workbook actually anchors it.
        try { if (cell.master && cell.master !== cell) return; } catch { /* some cells lack master */ }
        const str = cellText(cell).trim();
        if (!str) return;
        items.push({
          page,
          x: colNumber * COL_SPACING,
          y: Y_ORIGIN - rowNumber * ROW_SPACING,
          str,
          width: Math.max(str.length * 6, COL_SPACING / 2),
        });
      });
    });
  });
  items._source = "xlsx";
  return items;
}

// Mirror parseCDSPositional's output shape for a workbook source.
export async function parseCDSXlsxFile(xlsxPath) {
  const items = await extractItemsFromXlsx(xlsxPath);
  const allText = items.map((item) => item.str).join(" ");
  const result = { source: "cds", parserVersion: 5, extractionMethod: "xlsx" };

  result.year = extractYear(allText);
  result.testPolicy = extractTestPolicyPositional(items) || extractTestPolicy(allText);
  const counts = extractC1Counts(items);
  if (counts) {
    result.b1 = counts;
    if (counts.applied && counts.admitted) result.overallAdmitRate = round4(counts.admitted / counts.applied);
    if (counts.admitted && counts.enrolled) result.yieldRate = round4(counts.enrolled / counts.admitted);
  }
  Object.assign(result, extractC9Bands(items));
  const gpa = extractC12GPA(allText);
  if (gpa) result.enrolledGPA = gpa;
  const avgGPA = extractC12AverageGPA(allText);
  if (avgGPA != null) {
    result.enrolledGPA = result.enrolledGPA || {};
    result.enrolledGPA.avg = avgGPA;
  }
  const c1Sub = extractC1SubBreakdowns(items);
  if (c1Sub) result.c1Breakdown = c1Sub;
  const c7 = extractC7Positional(items);
  if (c7 && Object.values(c7).some((v) => v !== "not_considered")) result.c7 = c7;
  if (!result.c7) result.c7 = extractC7Labelled(items) || {};
  return result;
}

function round4(v) { return Math.round(v * 10000) / 10000; }

const C7_RATING_TEXT = [
  ["very_important", /^very\s+important$/i],
  ["important", /^important$/i],
  ["considered", /^considered$/i],
  ["not_considered", /^not\s+considered$/i],
];

// The 2025-26 workbooks from Cornell and Illinois carry a coded data view
// whose rows spell each C7 factor beside its rating as text ("C.701 |
// Rigor of secondary school record | Very Important"), while the form
// view's X grid shares sheet rows with unrelated coded cells and reads as
// all not_considered. Read the labelled rows instead: a factor label cell
// followed by a rating cell; the first sighting of each factor wins and
// factors the sheet does not list read as not_considered, as on a PDF.
export function extractC7Labelled(items) {
  const lines = groupByLine(items, 2.5);
  const ratings = {};
  for (const line of lines) {
    const cells = line.items;
    for (let k = 0; k + 1 < cells.length; k++) {
      const rating = C7_RATING_TEXT.find(([, re]) => re.test(cells[k + 1].str.trim()));
      if (!rating) continue;
      const factor = C7_FACTOR_PATTERNS.find(([, re]) => re.test(cells[k].str.trim()));
      if (factor && ratings[factor[0]] == null) ratings[factor[0]] = rating[0];
    }
  }
  if (Object.keys(ratings).length === 0) return null;
  for (const [factor] of C7_FACTOR_PATTERNS) if (ratings[factor] == null) ratings[factor] = "not_considered";
  return ratings;
}
