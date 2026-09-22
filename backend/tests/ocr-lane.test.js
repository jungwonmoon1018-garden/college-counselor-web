// The instance has 512 MB for three Node processes, and a rasterized page
// plus its recognition lives outside the V8 heap. Measured on 2026-09-21:
// three Common Data Set ingests that each started their own tesseract worker
// peaked at 620 MB, and the text of three large PDFs read at once cost
// 160 MB. These tests pin what keeps that from happening again: one document
// lane for the whole process (PDF text, DOCX, each rasterized page), a
// student's job ahead of background jobs, a lane that a stuck job cannot
// close, a pixel ceiling on rasterized pages, and no second OCR worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_OCR_PAGE_PIXELS, ocrViewportScale, runDocumentJob } from "../shared/file-extractors.js";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test("the document lane runs one job at a time", async () => {
  let running = 0;
  let most = 0;
  const job = async () => {
    running += 1;
    most = Math.max(most, running);
    await tick();
    running -= 1;
  };
  await Promise.all([runDocumentJob(job), runDocumentJob(job, { background: true }), runDocumentJob(job), runDocumentJob(job, { background: true })]);
  assert.equal(most, 1);
});

test("a student's page goes ahead of waiting background pages, in arrival order otherwise", async () => {
  const order = [];
  const job = (name) => async () => { await tick(); order.push(name); };
  const all = [
    runDocumentJob(job("first")),                                   // takes the lane at once
    runDocumentJob(job("refresh-1"), { background: true }),
    runDocumentJob(job("refresh-2"), { background: true }),
    runDocumentJob(job("upload-1")),
    runDocumentJob(job("upload-2")),
  ];
  await Promise.all(all);
  assert.deepEqual(order, ["first", "upload-1", "upload-2", "refresh-1", "refresh-2"]);
});

test("a failed job frees the lane and rejects only its own caller", async () => {
  const failed = runDocumentJob(async () => { throw new Error("recognition failed"); });
  const next = runDocumentJob(async () => "ok");
  await assert.rejects(failed, /recognition failed/);
  assert.equal(await next, "ok");
});

test("a job that never settles is given up on, and the lane moves on", async () => {
  const stuck = runDocumentJob(() => new Promise(() => {}), { timeoutMs: 20 });
  const next = runDocumentJob(async () => "ok");
  await assert.rejects(stuck, (err) => err.code === "document_job_timeout");
  assert.equal(await next, "ok");
});

test("PDF text, DOCX and the ingest's text and form-field passes take the lane", () => {
  const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), "utf8");
  const extractors = read("shared/file-extractors.js");
  const squeezed = (text) => text.replace(/\s+/g, " ");
  assert.ok(squeezed(extractors).includes("export async function extractPDF(input) { const buf = asBuffer(input); return runDocumentJob("));
  assert.ok(extractors.includes("runDocumentJob(() => mammoth.extractRawText("));
  assert.ok(read("cds/cds-pdf-text.js").includes("runDocumentJob(() => readTextLayer(pdfPath), { background: true })"));
  assert.ok(read("cds/cds-pdf-parser.js").includes("runDocumentJob(() => extractFormFields(pdfPath), { background: true })"));
});

test("a page is rasterized at the wanted scale unless that passes the pixel ceiling", () => {
  const page = (width, height) => ({ getViewport: ({ scale }) => ({ width: width * scale, height: height * scale }) });
  // US Letter at scale 2 is 1.9 million pixels: unchanged.
  assert.equal(ocrViewportScale(page(612, 792), 2), 2);
  assert.equal(ocrViewportScale(page(612, 792), 1.5), 1.5);
  // A scan saved at one point per pixel (2550 x 3300) would be a 135 MB
  // canvas at scale 2; it is brought down to the ceiling instead.
  const scale = ocrViewportScale(page(2550, 3300), 2);
  assert.ok(scale < 1, `scale ${scale}`);
  const pixels = 2550 * scale * 3300 * scale;
  assert.ok(pixels <= MAX_OCR_PAGE_PIXELS * 1.001, `pixels ${pixels}`);
  assert.ok(pixels >= MAX_OCR_PAGE_PIXELS * 0.99, "the ceiling is used, not undershot");
});

test("the Common Data Set OCR pass uses the shared worker through the lane", () => {
  const text = fs.readFileSync(path.join(BACKEND, "cds", "cds-pdf-text.js"), "utf8");
  assert.ok(!/createWorker\s*\(/.test(text), "the ingest must not start a tesseract worker of its own");
  assert.match(text, /runDocumentJob\(/);
  assert.match(text, /background:\s*true/);
});
