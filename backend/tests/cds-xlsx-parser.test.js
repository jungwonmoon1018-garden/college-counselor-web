// ═══════════════════════════════════════════════════════════
// TESTS: xlsx CDS adapter — workbook cells → positional items
// ═══════════════════════════════════════════════════════════

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { extractItemsFromXlsx, parseCDSXlsxFile } from "../cds/cds-xlsx-parser.js";

const require = createRequire(import.meta.url);

async function writeSampleWorkbook() {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("CDS");
  sheet.getCell("A1").value = "Common Data Set 2025-2026";
  sheet.getCell("A3").value = "SAT Composite";
  sheet.getCell("B3").value = 1350;
  sheet.getCell("C3").value = 1470;
  sheet.mergeCells("A5:C5");
  sheet.getCell("A5").value = "Merged Section Header";
  sheet.getCell("A7").value = { richText: [{ text: "Rich " }, { text: "Text" }] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cds-xlsx-test-")), "sample.xlsx");
  await workbook.xlsx.writeFile(file);
  return file;
}

test("workbook cells map to the PDF parser's item shape", async () => {
  const file = await writeSampleWorkbook();
  const items = await extractItemsFromXlsx(file);

  assert.equal(items._source, "xlsx");
  const title = items.find((item) => item.str === "Common Data Set 2025-2026");
  assert.ok(title);
  assert.equal(title.page, 1);
  assert.equal(title.x, 60);            // column 1

  const sat = items.filter((item) => item.y === title.y - 20); // row 3
  assert.deepEqual(sat.map((item) => item.str), ["SAT Composite", "1350", "1470"]);
  assert.deepEqual(sat.map((item) => item.x), [60, 120, 180]);

  // Rows lower in the sheet get smaller y (PDF-style, top of page = high y).
  const merged = items.filter((item) => item.str === "Merged Section Header");
  assert.equal(merged.length, 1, "merged range must emit its value exactly once");
  assert.ok(merged[0].y < title.y);

  assert.ok(items.some((item) => item.str === "Rich Text"));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("parseCDSXlsxFile produces the positional-parser output shape", async () => {
  const file = await writeSampleWorkbook();
  const parsed = await parseCDSXlsxFile(file);
  assert.equal(parsed.extractionMethod, "xlsx");
  assert.equal(parsed.source, "cds");
  assert.ok(parsed.c7 && typeof parsed.c7 === "object");
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("a workbook whose C7 grid is unreadable is read from its labelled coded rows", async () => {
  const { extractC7Labelled } = await import("../cds/cds-xlsx-parser.js");
  const row = (y, strs) => strs.map((str, i) => ({ page: 1, x: 60 + i * 60, y, str }));
  const items = [
    ...row(700, ["C4", "Does your institution require a college-preparatory program?", "C.701", "Rigor of secondary school record", "Very Important", "First-Time, First-Year Admission"]),
    ...row(680, ["Require", "C.702", "Class rank", "Not Considered", "First-Time, First-Year Admission"]),
    ...row(660, ["Recommend", "C.703", "Academic GPA", "Important", "First-Time, First-Year Admission"]),
    ...row(640, ["Total academic units", "15", "24", "C.708", "Extracurricular activities", "Very Important"]),
    ...row(620, ["Academic", "Very Important", "Important", "Considered", "Not Considered", "C.8G05", "Institutional Exam", "x"]),
    ...row(600, ["Rigor of secondary school record", "x", "C.8G06", "State Exam (specify):"]),
    ...row(580, ["335", "C.701", "Q111_1", "c7_rigor_of_secondary_school_record_very_important", "Rigor of secondary school record", "Very Important"]),
  ];
  const c7 = extractC7Labelled(items);
  assert.equal(c7.rigor, "very_important");
  assert.equal(c7.class_rank, "not_considered");
  assert.equal(c7.gpa, "important");
  assert.equal(c7.ec, "very_important");
  assert.equal(c7.interview, "not_considered");
  assert.equal(Object.keys(c7).length, 19);
});

test("parseCDSXlsxFile falls back to the labelled C7 rows", async () => {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("CDS");
  sheet.getCell("A1").value = "Common Data Set 2025-2026";
  sheet.getCell("C3").value = "C.701";
  sheet.getCell("D3").value = "Rigor of secondary school record";
  sheet.getCell("E3").value = "Very Important";
  sheet.getCell("C4").value = "C.702";
  sheet.getCell("D4").value = "Class rank";
  sheet.getCell("E4").value = "Considered";
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cds-xlsx-c7-")), "labelled.xlsx");
  await workbook.xlsx.writeFile(file);
  const parsed = await parseCDSXlsxFile(file);
  const { CDS_PARSER_VERSION } = await import("../cds/cds-pdf-parser.js");
  assert.equal(parsed.parserVersion, CDS_PARSER_VERSION);
  assert.equal(parsed.c7.rigor, "very_important");
  assert.equal(parsed.c7.class_rank, "considered");
  assert.equal(parsed.c7.gpa, "not_considered");
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

// ExcelJS loads a workbook whole. The refresh reads about thirty of them,
// and the read ran beside a student's PDF text layer or OCR job instead of
// waiting for the document lane every other heavy document step shares
// (shared/file-extractors.js runDocumentJob), which the 192 MB server heap
// depends on.
test("a workbook is read in the document lane, after the step holding it", async () => {
  const { runDocumentJob } = await import("../shared/file-extractors.js");
  const file = await writeSampleWorkbook();
  await extractItemsFromXlsx(file); // ExcelJS loaded, so only the lane can hold the parse back
  let release = () => {};
  const held = runDocumentJob(() => new Promise((resolve) => { release = resolve; }));
  let settled = false;
  const parsing = parseCDSXlsxFile(file).then((parsed) => { settled = true; return parsed; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, "the workbook waits while a student's step holds the lane");
  } finally {
    // Free the lane even when the assertion fails: a held job keeps the
    // process alive until the lane's 150-second give-up.
    release();
    await held;
  }
  const parsed = await parsing;
  assert.equal(parsed.extractionMethod, "xlsx");
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
