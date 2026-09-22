// cds-pdf-text.js — the text layer under the CDS PDF parser: positioned text
// items from pdf.js, the OCR fallback for image-only documents, and the
// grouping of items into lines. Moved out of cds-pdf-parser.js on 2026-09-20,
// which re-exports what it exported.
import fs from "fs";
import { ocrViewportScale, recognizeOnSharedWorker, runDocumentJob } from "../shared/file-extractors.js";

// pdfjs-dist v4 ships ESM only. Import the legacy build which is more
// compatible with Node (no DOM dependencies).
const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

// extractItems supports three modes:
//   - "auto"  (default): pdfjs first; OCR fallback if PDF appears image-only
//   - "ocr":             always OCR, even for native PDFs (slower, less exact
//                        on numbers but uniform across all PDF rendering paths)
//   - "pdfjs":           always pdfjs, no OCR even on image-only docs
// All three return the same `{page, x, y, str, width}[]` shape with a
// `_source` marker ("pdfjs" or "tesseract") so downstream extractors can
// loosen tolerance for OCR data.
export async function extractItems(pdfPath, { method = "auto", ocrMaxPages = 25 } = {}) {
  if (method === "ocr") {
    const ocrItems = await extractItemsViaOCR(pdfPath, ocrMaxPages);
    if (ocrItems && ocrItems.length > 0) {
      ocrItems._source = "tesseract";
      return ocrItems;
    }
    // OCR returned nothing — fall through to pdfjs so we don't return empty
    // (e.g. tesseract.js missing in the deployment).
  }

  // The text pass holds the document lane (background) while pdf.js has the
  // file open, so it never runs beside a student's upload or another ingest.
  const { items, numPages } = await runDocumentJob(() => readTextLayer(pdfPath), { background: true });

  // ─── OCR fallback ─────────────────────────────────────────────────
  // Some smaller-school CDSes are scanned PDFs with no text layer. If
  // pdfjs returned essentially no items but the doc has multiple pages,
  // fall back to tesseract OCR with bounding-box positions.
  if (method === "auto" && looksLikeImageOnlyPDF(items, numPages)) {
    const ocrItems = await extractItemsViaOCR(pdfPath, ocrMaxPages);
    if (ocrItems && ocrItems.length > 0) {
      ocrItems._source = "tesseract";
      return ocrItems;
    }
  }
  items._source = "pdfjs";
  return items;
}

async function readTextLayer(pdfPath) {
  const buf = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data: buf, useSystemFonts: false, isEvalSupported: false, disableFontFace: true });
  const items = [];
  let numPages = 0;
  try {
    const pdf = await loadingTask.promise;
    numPages = pdf.numPages;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        // transform = [a, b, c, d, e, f] where (e, f) is the position
        const x = it.transform[4];
        const y = it.transform[5];
        const str = it.str;
        if (!str || !str.trim()) continue;
        items.push({ page: p, x: round1(x), y: round1(y), str, width: it.width || 0 });
      }
      page.cleanup?.();
    }
  } finally {
    // pdfjs-dist v6 removed PDFDocumentProxy.destroy() — cleanup lives on the
    // loading task now. Best-effort: a cleanup failure must not void a parse.
    try { await loadingTask.destroy(); } catch { /* cleanup best-effort */ }
  }
  return { items, numPages };
}

export function looksLikeImageOnlyPDF(items, numPages) {
  // Heuristic: a real CDS has 100+ text items per page (labels, numbers,
  // headers, footers). An image-only PDF has fewer than 50 across the
  // entire doc, often zero. We require numPages > 1 to avoid misclassifying
  // a single-page summary that happens to be sparse.
  if (numPages < 2) return false;
  return items.length < Math.max(50, numPages * 5);
}

// extractItemsViaOCR: rasterizes each PDF page, runs tesseract.js with
// word-level bounding boxes, and converts each detected word to the same
// `{page, x, y, str, width}` shape as pdfjs's text extraction. The
// downstream C7/C9/C1/C12 extractors are coordinate-driven so they work
// uniformly on either source.
//
// PDF-space mapping:
//   We render at scale=2 (i.e. 144dpi when 72dpi is the PDF default).
//   Tesseract returns pixel coordinates in image space; we divide by the
//   scale to get back to PDF points and flip Y so the origin matches
//   pdfjs's bottom-left convention.
//
// Cost: roughly 5-10s per page on commodity hardware. A 30-page CDS
// takes 2-5 minutes to OCR. Fine for offline ingestion, not for
// interactive paths.
//
// A page that takes longer than this is abandoned (the worker is dropped and
// the document fails to parse). Shorter than the shared worker's idle
// release, which is re-armed when each page starts.
const OCR_PAGE_TIMEOUT_MS = 90_000;

// The words of a recognition result. tesseract.js 6+ emits only text by
// default and, asked for blocks, nests words under blocks > paragraphs >
// lines; earlier versions put a flat `words` array on the result. Both
// shapes are read here so the OCR items keep their boxes.
export function ocrWords(data) {
  if (Array.isArray(data?.words) && data.words.length) return data.words;
  const out = [];
  for (const block of data?.blocks || []) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        for (const word of line?.words || []) out.push(word);
      }
    }
  }
  return out;
}

export async function extractItemsViaOCR(pdfPath, maxPages = 25) {
  let canvasPkg;
  try {
    // Match the file-extractors.js convention: @napi-rs/canvas (CommonJS).
    canvasPkg = await import("@napi-rs/canvas");
  } catch (e) {
    console.warn("[cds-pdf-parser] @napi-rs/canvas not available — OCR skipped");
    return null;
  }
  const { createCanvas } = canvasPkg;

  const buf = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await pdfjsLib.getDocument({
    data: buf,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  const items = [];
  try {
    const pagesToRead = Math.min(pdf.numPages, maxPages);
    const SCALE = 2;

    // PSM 6 — "Assume a single uniform block of text" — works better for
    // CDS table layouts where columns are tight and rows are dense. Default
    // PSM 3 (auto-segmentation) often splits the C7 table into the wrong
    // regions and loses row alignment. The blocks output carries the word
    // boxes (tesseract.js 6+ omits them unless asked).
    //
    // This pass used to start a tesseract worker of its own per document.
    // Three ingests at once (a College Fit request for three schools the
    // store lacks, or the daily refresh) then held three WASM heaps and
    // three rasterized pages: 620 MB at the peak, measured on 2026-09-21, on
    // an instance with 512 MB. Each page now goes through the process-wide
    // document lane on the shared worker, as background work, so a student's
    // upload is read ahead of it.
    for (let p = 1; p <= pagesToRead; p++) {
      const page = await pdf.getPage(p);
      let pageScale = SCALE;
      let pageHeightPx = 0;
      let data;
      try {
        data = await runDocumentJob(async () => {
          pageScale = ocrViewportScale(page, SCALE);
          const viewport = page.getViewport({ scale: pageScale });
          pageHeightPx = viewport.height;
          const cv = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const ctx = cv.getContext("2d");
          // White background (some PDFs render transparent which Tesseract dislikes).
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, cv.width, cv.height);
          await page.render({ canvasContext: ctx, viewport }).promise;
          const png = cv.toBuffer("image/png");
          return recognizeOnSharedWorker(png, {
            languages: "eng",
            timeoutMs: OCR_PAGE_TIMEOUT_MS,
            parameters: { tessedit_pageseg_mode: "6" },
            output: { text: true, blocks: true },
          });
        }, { background: true });
      } catch (e) {
        if (e?.code === "ocr_failed" && /Cannot find (module|package)/i.test(String(e?.cause?.message || e?.message))) {
          console.warn("[cds-pdf-parser] tesseract.js not available — OCR skipped");
          return null;
        }
        throw e;
      }
      const words = ocrWords(data);

      for (const w of words) {
        const text = String(w.text || "").trim();
        if (!text) continue;
        const x0 = w.bbox?.x0 ?? 0;
        const x1 = w.bbox?.x1 ?? x0;
        const y0 = w.bbox?.y0 ?? 0;
        const x = x0 / pageScale;
        // Flip Y: pdfjs uses bottom-left origin, tesseract uses top-left.
        const y = (pageHeightPx - y0) / pageScale;
        const width = (x1 - x0) / pageScale;
        items.push({
          page: p,
          x: round1(x),
          y: round1(y),
          str: text,
          width: round1(width),
          confidence: w.confidence ?? null,
        });
      }
      page.cleanup();
    }
  } finally {
    // pdfjs-dist v6: destroy moved to the loading task (pdf.loadingTask). In
    // a finally since 2026-09-21: a page that failed used to leave the whole
    // document — the file and everything pdf.js built from it — behind.
    try { await (pdf.destroy?.() ?? pdf.loadingTask?.destroy?.()); } catch { /* cleanup best-effort */ }
  }
  return items;
}

// Group items into lines by (page, y) within tolerance.
export function groupByLine(items, yTolerance = 2.0) {
  const lines = [];
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  let cur = null;
  for (const it of sorted) {
    if (!cur || it.page !== cur.page || Math.abs(cur.y - it.y) > yTolerance) {
      cur = { page: it.page, y: it.y, items: [] };
      lines.push(cur);
    }
    cur.items.push(it);
  }
  // sort items in each line left-to-right
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

function round1(v) { return Math.round(v * 10) / 10; }

export function round4(v) { return Math.round(v * 10000) / 10000; }
