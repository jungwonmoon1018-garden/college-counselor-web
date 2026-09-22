// A PDF whose fonts carry no Unicode map has a text layer of glyph codes.
// Bradley University's 2025-26 Common Data Set (93,000 items of control
// characters over 50 pages) parsed to an empty record on 2026-09-22 and a
// chat attachment like it would have reached the model as noise. Readable
// text is mostly letters and digits; a layer that is not is treated as
// absent, which sends the CDS parser and the upload extractors to OCR.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { textLayerLooksReadable } from "../shared/file-extractors.js";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("text of words and numbers is readable, a layer of glyph codes is not", () => {
  assert.equal(textLayerLooksReadable("Total first-time, first-year males who applied 3,404 (2025-26)"), true);
  assert.equal(textLayerLooksReadable("C1. First-time students: 12,345 applied; 8,000 admitted; 1,100 enrolled — 9.8% / 62,484 USD"), true);
  assert.equal(textLayerLooksReadable("A B C D E F G H I J K L M N O P Q R S T U V W X Y Z 1 2 3 4 5 6"), true, "single letters are still letters");
  const codes = Array.from({ length: 400 }, (_, i) => String.fromCharCode(i % 32)).join("");
  assert.equal(textLayerLooksReadable(codes), false);
  assert.equal(textLayerLooksReadable(`${codes} Bradley University`), false, "a few real words in a sea of codes do not rescue it");
  assert.equal(textLayerLooksReadable("abc"), true, "too short to judge; the length checks decide");
  assert.equal(textLayerLooksReadable(""), true);
});

test("the upload extractor reports an unreadable layer as empty, and the CDS parser sends it to OCR", () => {
  const extractors = fs.readFileSync(path.join(BACKEND, "shared", "file-extractors.js"), "utf8");
  assert.ok(extractors.includes('if (!textLayerLooksReadable(text)) return { text: "", pageCount: pageCount || null, warning: "text_layer_unreadable" };'));
  const pdfText = fs.readFileSync(path.join(BACKEND, "cds", "cds-pdf-text.js"), "utf8");
  assert.ok(pdfText.includes('if (method === "auto" && (looksLikeImageOnlyPDF(items, numPages) || !textLayerLooksReadable(items.map((it) => it.str).join(""))))'));
});

test("the parser version moved past 6 for the OCR fallback, so stored rows are re-read", async () => {
  const { CDS_PARSER_VERSION } = await import("../cds/cds-pdf-parser.js");
  assert.ok(CDS_PARSER_VERSION >= 7, `version ${CDS_PARSER_VERSION}`);
});

// OCR misses rows. A test policy it did not read stays unknown instead of
// the "test_required" default a text layer keeps: Bradley is test-optional,
// and its first OCR record said scores were required.
test("a test policy that was not read is unknown for an OCR record, the old default for a text layer", async () => {
  const { extractTestPolicyPositional } = await import("../cds/cds-pdf-parser.js");
  assert.equal(extractTestPolicyPositional([]), null, "not found is not a policy");
  const parser = fs.readFileSync(path.join(BACKEND, "cds", "cds-pdf-parser.js"), "utf8");
  assert.ok(parser.includes('positional.testPolicy = extractTestPolicyPositional(items) ?? (items._source === "tesseract" ? null : "test_required");'));
});
