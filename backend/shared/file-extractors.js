// ═══════════════════════════════════════════════════════════════════════
// FILE EXTRACTORS — text extraction dispatcher for EC attachments
// ═══════════════════════════════════════════════════════════════════════
// Pure async functions: Buffer in → { text, pageCount?, warning? } out.
// Supported types: PDF, plain text, DOCX, images (PNG/JPEG) via OCR.
//
// The OCR path is lazy-loaded because tesseract.js pulls in ~100 MB of
// language data. Small deployments that never upload images will not pay
// that cost unless extractImage() is actually invoked.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_EXTRACTED_CHARS = 50_000;
export const MAX_ARCHIVE_ENTRIES = 1_024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
export const MAX_ARCHIVE_COMPRESSION_RATIO = 100;

export const SUPPORTED_MIME_TYPES = Object.freeze({
  "application/pdf": "pdf",
  "text/plain": "text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/webp": "image",
});

export class ExtractionError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// ─── Buffer coercion ────────────────────────────────────────
function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === "string") return Buffer.from(input, "utf8");
  throw new ExtractionError("invalid_input", "Expected a Buffer or Uint8Array");
}

function contentMismatch(message) {
  throw new ExtractionError("content_type_mismatch", message);
}

function validatePlainText(buf) {
  if (buf.includes(0)) contentMismatch("Plain-text uploads cannot contain NUL bytes");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    contentMismatch("Plain-text upload is not valid UTF-8");
  }
  const disallowedControls = [...buf].filter((byte) => byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)).length;
  if (disallowedControls > Math.max(2, Math.floor(buf.length * 0.01))) {
    contentMismatch("Plain-text upload contains binary control data");
  }
}

function findEndOfCentralDirectory(buf) {
  const first = Math.max(0, buf.length - 65_557);
  for (let offset = buf.length - 22; offset >= first; offset -= 1) {
    if (buf.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  contentMismatch("DOCX archive has no valid central directory");
}

function validateDocxArchive(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    contentMismatch("DOCX upload does not have a ZIP signature");
  }
  const eocdOffset = findEndOfCentralDirectory(buf);
  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const centralDisk = buf.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buf.readUInt16LE(eocdOffset + 8);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralSize = buf.readUInt32LE(eocdOffset + 12);
  const centralOffset = buf.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    contentMismatch("Multi-disk DOCX archives are not supported");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ExtractionError("archive_limits_exceeded", "ZIP64 DOCX archives are not accepted");
  }
  if (entryCount < 1 || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new ExtractionError("archive_limits_exceeded", `DOCX archive contains too many entries (${entryCount})`);
  }
  if (centralOffset + centralSize > eocdOffset || centralOffset < 0) {
    contentMismatch("DOCX central directory points outside the upload");
  }

  const names = new Set();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || buf.readUInt32LE(cursor) !== 0x02014b50) {
      contentMismatch("DOCX central directory is malformed");
    }
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocdOffset) contentMismatch("DOCX central-directory entry is truncated");
    if (flags & 0x0001) contentMismatch("Encrypted DOCX archives are not accepted");
    if (![0, 8].includes(method)) contentMismatch("DOCX archive uses an unsupported compression method");
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    if (!name || name.startsWith("/") || name.includes("../") || /^[A-Za-z]:/.test(name)) {
      contentMismatch("DOCX archive contains an unsafe entry path");
    }
    names.add(name);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new ExtractionError("archive_limits_exceeded", "DOCX expands beyond the allowed size");
    }
    if (uncompressedSize > 0 && uncompressedSize / Math.max(1, compressedSize) > MAX_ARCHIVE_COMPRESSION_RATIO) {
      throw new ExtractionError("archive_limits_exceeded", "DOCX entry has a suspicious compression ratio");
    }

    if (localOffset + 30 > centralOffset || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      contentMismatch("DOCX local entry points outside the upload");
    }
    const localFlags = buf.readUInt16LE(localOffset + 6);
    const localMethod = buf.readUInt16LE(localOffset + 8);
    const localCompressedSize = buf.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buf.readUInt32LE(localOffset + 22);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    if (localFlags !== flags || localMethod !== method) contentMismatch("DOCX local and central entry metadata disagree");
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8").replace(/\\/g, "/");
    if (localName !== name) contentMismatch("DOCX local and central entry names disagree");
    if (!(flags & 0x0008) && (localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) {
      contentMismatch("DOCX entry sizes are inconsistent");
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) contentMismatch("DOCX compressed entry is truncated");
    const compressed = buf.subarray(dataStart, dataEnd);
    let actualSize;
    try {
      actualSize = method === 0
        ? compressed.length
        : inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1 }).length;
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE") {
        throw new ExtractionError("archive_limits_exceeded", "DOCX entry expands beyond the allowed size", error);
      }
      contentMismatch("DOCX contains invalid compressed data");
    }
    if (actualSize !== uncompressedSize) contentMismatch("DOCX entry expands to an unexpected size");
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) contentMismatch("DOCX central-directory size is inconsistent");
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml") || !names.has("_rels/.rels")) {
    contentMismatch("ZIP upload is not a structurally valid DOCX document");
  }
}

export function validateFileContent(input, mimeType) {
  const buf = asBuffer(input);
  const normalizedMime = String(mimeType || "").toLowerCase();
  const kind = SUPPORTED_MIME_TYPES[normalizedMime];
  if (!kind) throw new ExtractionError("unsupported_mime", `Unsupported MIME type: ${mimeType}`);
  if (buf.length === 0) contentMismatch("Uploaded file is empty");

  if (kind === "pdf" && !buf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    contentMismatch("PDF upload does not have a PDF signature");
  } else if (kind === "docx") {
    validateDocxArchive(buf);
  } else if (normalizedMime === "image/png" && !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    contentMismatch("PNG upload does not have a PNG signature");
  } else if (["image/jpeg", "image/jpg"].includes(normalizedMime) && !(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    contentMismatch("JPEG upload does not have a JPEG signature");
  } else if (normalizedMime === "image/webp" && !(buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")) {
    contentMismatch("WebP upload does not have a WebP signature");
  } else if (kind === "text") {
    validatePlainText(buf);
  }
  return { kind, mimeType: normalizedMime };
}

// ─── Plain text ─────────────────────────────────────────────
export async function extractPlainText(input) {
  const buf = asBuffer(input);
  let text = buf.toString("utf8");
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, warning: null };
}

// ─── PDF ────────────────────────────────────────────────────
let _pdfParseRef = null;
async function loadPdfParse() {
  if (_pdfParseRef) return _pdfParseRef;
  // pdf-parse 2 exports a PDFParse class (getText() on a loaded document)
  // where 1.x exported one function; the CommonJS entry is required lazily
  // because the fallback is rarely reached.
  _pdfParseRef = require("pdf-parse");
  return _pdfParseRef;
}

// The text layer, read with pdfjs-dist (the build the CDS parser and the
// OCR path already run in production). pdf-parse's bundled 2020 pdf.js
// fails with "bad XRef entry" under Node 20+ on any PDF that carries a
// classic cross-reference table — which is every small PDF a student
// exports or a script writes — while PDFs with cross-reference streams
// (Word, Acrobat) still parse; on production every chat PDF upload of
// the first kind came back "could not be safely processed". Lines are
// joined the way pdf-parse joined them (same baseline → same line), pages
// separated by a blank line.
let _standardFontDataUrl = null;
function standardFontDataUrl() {
  if (_standardFontDataUrl != null) return _standardFontDataUrl || undefined;
  try {
    // The 14 standard fonts a PDF may reference without embedding; pdfjs
    // warns on every page that uses one when this is not supplied.
    const dir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
    _standardFontDataUrl = pathToFileURL(dir).href;
  } catch {
    _standardFontDataUrl = "";
  }
  return _standardFontDataUrl || undefined;
}

// A PDF whose embedded fonts carry no Unicode map yields a text layer of
// raw glyph codes: Bradley University's 2025-26 Common Data Set gave 93,000
// items of control characters, which no "is it empty" check caught, so the
// parser read nothing and a chat attachment would have handed the model
// noise. Readable text is mostly letters and digits; when it is not, the
// text layer is treated as absent and the callers' OCR fallbacks run.
export function textLayerLooksReadable(text) {
  const chars = String(text || "").replace(/\s+/g, "");
  if (chars.length < 20) return true; // too little to judge; the length checks decide
  let readable = 0;
  for (const ch of chars) if (/[\p{L}\p{N}]/u.test(ch)) readable += 1;
  return readable / chars.length >= 0.5;
}

async function extractPdfTextLayer(buf) {
  const pdfjsLib = await loadPdfJs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: standardFontDataUrl(),
  });
  let pdf = null;
  try {
    pdf = await loadingTask.promise;
    const pageCount = Number(pdf.numPages || 0) || 0;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      let lastY = null;
      for (const item of content.items || []) {
        if (typeof item?.str !== "string") continue;
        const y = Array.isArray(item.transform) ? item.transform[5] : null;
        text += lastY != null && y !== lastY ? `\n${item.str}` : item.str;
        lastY = y;
      }
      pages.push(text);
      page.cleanup?.();
    }
    const text = pages.map((p) => `\n\n${p}`).join("");
    if (!textLayerLooksReadable(text)) return { text: "", pageCount: pageCount || null, warning: "text_layer_unreadable" };
    return { text, pageCount: pageCount || null, warning: null };
  } finally {
    try { if (pdf) await (pdf.destroy?.() ?? pdf.loadingTask?.destroy?.()); } catch { /* best-effort */ }
  }
}

export async function extractPDF(input) {
  const buf = asBuffer(input);
  return runDocumentJob(() => extractPdfInLane(buf));
}

async function extractPdfInLane(buf) {
  let firstError = null;
  try {
    return await extractPdfTextLayer(buf);
  } catch (err) {
    firstError = err;
  }
  // pdf-parse stays as the second reader for a file pdfjs rejects.
  try {
    const { PDFParse } = await loadPdfParse();
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      // pdf-parse 2 writes a "-- 1 of 3 --" marker between pages; the text
      // layer read above does not, and the model should not see them.
      return {
        text: String(result?.text || "").replace(/^-- \d+ of \d+ --$/gm, "").replace(/\n{3,}/g, "\n\n").trim(),
        pageCount: Number(result?.total || 0) || null,
        warning: null,
      };
    } finally {
      try { await parser.destroy(); } catch { /* best-effort */ }
    }
  } catch (err) {
    const cause = firstError || err;
    throw new ExtractionError("pdf_parse_failed", `PDF extraction failed: ${cause.message}`, cause);
  }
}

// ─── DOCX ───────────────────────────────────────────────────
let _mammothRef = null;
async function loadMammoth() {
  if (_mammothRef) return _mammothRef;
  _mammothRef = require("mammoth");
  return _mammothRef;
}

export async function extractDOCX(input) {
  const buf = asBuffer(input);
  try {
    const mammoth = await loadMammoth();
    const result = await runDocumentJob(() => mammoth.extractRawText({ buffer: buf }));
    return {
      text: String(result?.value || ""),
      warning: Array.isArray(result?.messages) && result.messages.length
        ? `mammoth notes: ${result.messages.length}`
        : null,
    };
  } catch (err) {
    throw new ExtractionError("docx_parse_failed", `DOCX extraction failed: ${err.message}`, err);
  }
}

// ─── Image OCR (lazy) ───────────────────────────────────────
let _tesseractRef = null;
async function loadTesseract() {
  if (_tesseractRef) return _tesseractRef;
  _tesseractRef = require("tesseract.js");
  return _tesseractRef;
}

let _pdfJsRef = null;
async function loadPdfJs() {
  if (_pdfJsRef) return _pdfJsRef;
  _pdfJsRef = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return _pdfJsRef;
}

let _canvasRef = null;
async function loadCanvas() {
  if (_canvasRef) return _canvasRef;
  _canvasRef = require("@napi-rs/canvas");
  return _canvasRef;
}

// ─── Shared OCR worker ──────────────────────────────────────
// tesseract.recognize() (the one-shot API) spins up a fresh worker — WASM
// init + traineddata load — on EVERY call, and extractPdfOCR paid that per
// PAGE. Keep one warm worker per language set instead, and release it after
// an idle window so a quiet server isn't holding ~100 MB of OCR state.
const OCR_WORKER_IDLE_MS = 120_000;

// Language data on the persistent disk. tesseract.js downloads
// eng/kor.traineddata (5 MB and 2 MB) from its CDN the first time a
// language is used and caches the file in the working directory, which on
// the host is the ephemeral part of the filesystem: every deploy paid the
// download again, and OCR failed outright whenever the CDN did not answer.
// DATA_DIR is the persistent disk; TESSDATA_CACHE_DIR overrides it.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export function ocrCacheDir() {
  const dir = process.env.TESSDATA_CACHE_DIR || path.join(process.env.DATA_DIR || path.join(MODULE_DIR, "..", "data"), "tessdata");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let _ocrWorkerPromise = null;
let _ocrWorkerLangs = null;
let _ocrIdleTimer = null;

export async function releaseOcrWorker() {
  const pending = _ocrWorkerPromise;
  _ocrWorkerPromise = null;
  _ocrWorkerLangs = null;
  if (_ocrIdleTimer) { clearTimeout(_ocrIdleTimer); _ocrIdleTimer = null; }
  if (pending) {
    try { const worker = await pending; await worker.terminate(); } catch { /* best-effort */ }
  }
}

function scheduleOcrWorkerRelease() {
  if (_ocrIdleTimer) clearTimeout(_ocrIdleTimer);
  _ocrIdleTimer = setTimeout(() => { releaseOcrWorker(); }, OCR_WORKER_IDLE_MS);
  _ocrIdleTimer.unref?.();
}

async function getOcrWorker(languages) {
  if (!_ocrWorkerPromise || _ocrWorkerLangs !== languages) {
    if (_ocrWorkerPromise) await releaseOcrWorker();
    _ocrWorkerLangs = languages;
    _ocrWorkerPromise = (async () => {
      const tesseract = await loadTesseract();
      return tesseract.createWorker(languages.split("+"), 1, { logger: () => {}, cachePath: ocrCacheDir() });
    })();
  }
  scheduleOcrWorkerRelease();
  return _ocrWorkerPromise;
}

// ─── One document lane for the whole process ────────────────
// What pdf.js builds from a file, a rasterized page and its recognition all
// live outside the V8 heap, and the hosted instance has 512 MB for three
// Node processes that idle at about 240 MB together. Measured on 2026-09-21:
// the text of one large PDF costs about 80 MB, three at once 160 MB; one
// Common Data Set ingest with a tesseract worker of its own peaked at 320 MB
// and three at once — what one College Fit request for three unknown
// schools, or the daily refresh, could start — at 620 MB. So every heavy
// step on a document runs in this lane, one at a time for the process: a
// PDF's text layer, a DOCX, one rasterized-and-recognized page. A student's
// job goes ahead of waiting background jobs (the refresh, a live ingest), so
// background work never makes an upload wait for more than the step in
// progress. A job that never settles is given up on after `timeoutMs` so
// it cannot close the lane for everyone else.
const DOCUMENT_JOB_TIMEOUT_MS = 150_000;
const _laneWaiters = [];
let _laneBusy = false;

function drainDocumentLane() {
  if (_laneBusy) return;
  const next = _laneWaiters.shift();
  if (!next) return;
  _laneBusy = true;
  let timer;
  // The timer is not unref'd: a stuck job with no handle of its own would
  // otherwise let a process exit before the give-up fired (the lane test
  // did exactly that on CI), and the server's socket keeps it alive anyway.
  const gaveUp = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ExtractionError("document_job_timeout", `Document step did not finish in ${next.timeoutMs}ms`)), next.timeoutMs);
  });
  Promise.race([Promise.resolve().then(next.job), gaveUp])
    .then(next.resolve, next.reject)
    .finally(() => { clearTimeout(timer); _laneBusy = false; drainDocumentLane(); });
}

export function runDocumentJob(job, { background = false, timeoutMs = DOCUMENT_JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const entry = { job, resolve, reject, background, timeoutMs };
    const firstBackground = background ? -1 : _laneWaiters.findIndex((waiter) => waiter.background);
    if (firstBackground === -1) _laneWaiters.push(entry);
    else _laneWaiters.splice(firstBackground, 0, entry);
    drainDocumentLane();
  });
}

// A page is rasterized at the scale the caller wants unless that passes the
// pixel ceiling. US Letter at scale 2 is 1.9 million pixels; a scan saved at
// one point per pixel (2550 x 3300) would be a 135 MB canvas at scale 2.
export const MAX_OCR_PAGE_PIXELS = 4_000_000;
export function ocrViewportScale(page, wantedScale) {
  const base = page.getViewport({ scale: 1 });
  const area = Number(base.width) * Number(base.height);
  if (!(area > 0) || area * wantedScale * wantedScale <= MAX_OCR_PAGE_PIXELS) return wantedScale;
  return Math.sqrt(MAX_OCR_PAGE_PIXELS / area);
}

// One recognition on the shared worker. Callers hold the document lane. `output`
// asks tesseract.js for more than text (the ingest reads word boxes from
// `blocks`); `parameters` are set before the page is read.
export async function recognizeOnSharedWorker(input, { timeoutMs = 30_000, languages = "eng+kor", parameters = null, output = null } = {}) {
  const buf = asBuffer(input);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let timer;
    try {
      const worker = await getOcrWorker(languages);
      if (parameters) await worker.setParameters(parameters);
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new ExtractionError("ocr_timeout", `OCR timed out after ${timeoutMs}ms`)), timeoutMs);
        (output ? worker.recognize(buf, {}, output) : worker.recognize(buf))
          .then((r) => resolve(r?.data || {}))
          .catch((e) => reject(new ExtractionError("ocr_failed", `OCR failed: ${e.message}`, e)));
      });
    } catch (err) {
      // A timed-out or crashed worker can't be trusted (the WASM job keeps
      // running) — drop it so the retry / next call starts clean.
      await releaseOcrWorker();
      const timedOut = err instanceof ExtractionError && err.code === "ocr_timeout";
      if (!timedOut && attempt === 0) continue; // one clean-worker retry for crashes
      if (err instanceof ExtractionError) throw err;
      throw new ExtractionError("ocr_failed", `OCR failed: ${err.message}`, err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new ExtractionError("ocr_failed", "OCR failed after retry");
}

function ocrTextResult(data) {
  const text = String(data?.text || "");
  return { text, warning: text.trim().length === 0 ? "ocr_empty" : null };
}

// OCR of one uploaded image. Takes the lane; extractPdfOCR, which already
// holds it for the page it rasterized, calls recognizeOnSharedWorker itself.
export async function extractImage(input, { timeoutMs = 30_000, languages = "eng+kor" } = {}) {
  const buf = asBuffer(input);
  return runDocumentJob(async () => ocrTextResult(await recognizeOnSharedWorker(buf, { timeoutMs, languages })));
}

export async function extractPdfOCR(input, {
  timeoutMs = 60_000,
  languages = "eng",
  scale = 2,
  maxPages = 25,
} = {}) {
  const buf = asBuffer(input);
  const cacheKey = extractCacheKey("pdfocr", buf, `${languages}|${scale}|${maxPages}`);
  const cached = extractCacheGet(cacheKey);
  if (cached) return cached;
  let pdf = null;
  try {
    const pdfjsLib = await loadPdfJs();
    const { createCanvas } = await loadCanvas();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
    });
    pdf = await loadingTask.promise;
    const pageCount = Number(pdf.numPages || 0) || 0;
    const pagesToRead = Math.min(pageCount, Math.max(1, Number(maxPages) || 1));
    const pageTexts = [];
    const warnings = [];

    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      // The canvas exists only inside the lane, so two uploads read at the
      // same time never hold two rasterized pages.
      const ocr = await runDocumentJob(async () => {
        const viewport = page.getViewport({ scale: ocrViewportScale(page, scale) });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const canvasContext = canvas.getContext("2d");
        await page.render({ canvasContext, viewport }).promise;
        const png = canvas.toBuffer("image/png");
        return ocrTextResult(await recognizeOnSharedWorker(png, { timeoutMs, languages }));
      });
      pageTexts.push(ocr.text || "");
      if (ocr.warning) warnings.push(`page_${pageNumber}:${ocr.warning}`);
      page.cleanup?.();
    }

    if (pageCount > pagesToRead) warnings.push(`truncated_pages:${pagesToRead}/${pageCount}`);
    const text = pageTexts.join("\n\n").trim();
    const finished = {
      text,
      pageCount,
      warning: warnings.length ? warnings.join(";") : (text ? null : "ocr_empty"),
    };
    extractCacheSet(cacheKey, finished);
    return { ...finished };
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError("pdf_ocr_failed", `PDF OCR failed: ${err.message}`, err);
  } finally {
    // pdfjs-dist v6 removed PDFDocumentProxy.destroy(); cleanup lives on the
    // loading task. A cleanup failure must never mask a successful OCR.
    try { if (pdf) await (pdf.destroy?.() ?? pdf.loadingTask?.destroy?.()); } catch { /* best-effort */ }
  }
}

// ─── Dispatcher ─────────────────────────────────────────────
/**
 * Dispatch to the right extractor by MIME type.
 * Truncates output to MAX_EXTRACTED_CHARS and sets warning if truncated.
 *
 * @param {Buffer|Uint8Array} input
 * @param {string} mimeType
 * @returns {Promise<{ text: string, pageCount?: number|null, warning?: string|null, kind: string }>}
 */
// ─── Extraction result cache ────────────────────────────────
// Keyed by content hash, LRU-bounded. Re-uploading the same file (a student
// retrying a transcript import, re-attaching a document after a reload) used
// to redo the full parse/OCR; now it's a map lookup.
const EXTRACT_CACHE_MAX = 24;
const _extractCache = new Map();
function extractCacheKey(prefix, buf, extra = "") {
  return `${prefix}:${extra}:${createHash("sha256").update(buf).digest("hex")}`;
}
function extractCacheGet(key) {
  const hit = _extractCache.get(key);
  if (!hit) return null;
  _extractCache.delete(key);
  _extractCache.set(key, hit); // LRU bump
  return { ...hit };
}
function extractCacheSet(key, value) {
  _extractCache.set(key, value);
  if (_extractCache.size > EXTRACT_CACHE_MAX) {
    _extractCache.delete(_extractCache.keys().next().value);
  }
}

export async function extractText(input, mimeType) {
  const { kind } = validateFileContent(input, mimeType);
  const cacheKey = extractCacheKey("extract", asBuffer(input), kind);
  const cached = extractCacheGet(cacheKey);
  if (cached) return cached;

  let result;
  if (kind === "pdf") result = await extractPDF(input);
  else if (kind === "docx") result = await extractDOCX(input);
  else if (kind === "image") result = await extractImage(input);
  else result = await extractPlainText(input);

  let text = String(result?.text || "");
  let warning = result?.warning || null;
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_CHARS);
    warning = warning ? `${warning};truncated` : "truncated";
  }

  const finished = {
    text,
    pageCount: result?.pageCount ?? null,
    warning,
    kind,
  };
  extractCacheSet(cacheKey, finished);
  return { ...finished };
}

export function isSupportedMime(mimeType) {
  return Boolean(SUPPORTED_MIME_TYPES[String(mimeType || "").toLowerCase()]);
}
