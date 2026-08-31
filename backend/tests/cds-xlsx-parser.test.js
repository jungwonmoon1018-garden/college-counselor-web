// ═══════════════════════════════════════════════════════════
// TESTS: xlsx CDS adapter — workbook cells → positional items
// ═══════════════════════════════════════════════════════════

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { extractItemsFromXlsx, parseCDSXlsxFile } from "../cds-xlsx-parser.js";

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
