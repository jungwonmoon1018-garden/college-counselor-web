// ═══════════════════════════════════════════════════════════════════════
// cds-pdf-positional.js — column-aware CDS extractor.
// ═══════════════════════════════════════════════════════════════════════
// Uses pdfjs-dist to get every text item with its (x, y) coordinates,
// which lets us reconstruct the column layout that pdf-parse loses.
// Critical for C7 (factor importance ratings) where the meaning is
// purely positional: an X under "Very Important" vs "Considered" is the
// only thing that distinguishes them, and after a flat text dump those
// Xs end up unmoored from their column headers.
//
// Pipeline:
//   1. extractItems(pdfPath) → [{page, x, y, str, width}]
//   2. groupByLine(items)    → rows of items with similar y
//   3. extractC7Positional(items) → factor → rating
//   4. extractC1Counts(items)     → applied / admitted / enrolled
//   5. extractC9Bands(items)      → SAT / ACT 25/75
//   6. extractC12GPA(items)       → GPA distribution → p25/p75
// ═══════════════════════════════════════════════════════════════════════

import { extractSections, lineStringsFromGroups } from "./cds-sections.js";
import { groupByLine, round4, extractItems } from "./cds-pdf-text.js";
import { runDocumentJob } from "../shared/file-extractors.js";
import { extractC7Positional } from "./cds-pdf-c7.js";
import { extractC1Counts, extractC1SubBreakdowns } from "./cds-pdf-c1.js";
export { extractC1Counts, extractC1SubBreakdowns } from "./cds-pdf-c1.js";
export { C7_FACTOR_PATTERNS, extractC7Positional } from "./cds-pdf-c7.js";
export { extractItems, looksLikeImageOnlyPDF, ocrWords, extractItemsViaOCR, groupByLine } from "./cds-pdf-text.js";


// ─── C9: SAT / ACT 25th–75th ─────────────────────────────────────────
// CDS C9 has rows like:
//   SAT Composite           1500   1580
//   SAT EBRW               750     780
//   SAT Math               770     800
//   ACT Composite           34     35
// pdfjs-dist preserves these numbers along with their column positions,
// so we anchor on the row labels and grab the two numbers immediately
// following.
export function extractC9Bands(items) {
  const lines = groupByLine(items, 2.5);
  const out = {};

  function findBand(labelRe, numRange) {
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].items.map((it) => it.str).join(" ");
      if (!labelRe.test(text)) continue;
      // Step 1: prefer numbers ON THE SAME LINE as the label. Cross-line
      // collection produces false positives when subsequent rows hold their
      // own scores (e.g. SAT Composite, then SAT Math right after — picking
      // up Math's 690 as a candidate breaks the band).
      const sameLine = collectInRange(lines[i].items, numRange);
      if (sameLine.length >= 2) return pickP25P75(sameLine);
      // Step 2: fall back to a wider window (up to 5 lines) but ONLY if the
      // label line itself has no candidates AND the next labeled row is
      // outside the window. This handles split layouts (Caltech/some LACs)
      // where the numbers wrap below the label.
      const windowItems = [];
      for (let k = i; k < Math.min(i + 5, lines.length); k++) {
        const lineText = lines[k].items.map((it) => it.str).join(" ");
        if (k > i && labelRe.test(lineText)) break;
        // Stop at the next C9 row label so we don't bleed numbers across.
        if (k > i && /SAT\s+(Composite|Evidence|Math|EBRW|Total)|ACT\s+(Composite|Math|English|Reading|Writing|Science)/i.test(lineText)) break;
        windowItems.push(...lines[k].items);
      }
      const candidates = collectInRange(windowItems, numRange);
      if (candidates.length >= 2) return pickP25P75(candidates);
    }
    return null;
  }

  function collectInRange(items, [lo, hi]) {
    const out = [];
    for (const it of items) {
      const m = it.str.trim().match(/^([\d,]+)$/);
      if (!m) continue;
      const n = Number(m[1].replace(/,/g, ""));
      if (n >= lo && n <= hi) out.push({ x: it.x, n });
    }
    return out;
  }

  function pickP25P75(candidates) {
    candidates.sort((a, b) => a.x - b.x);
    const p25 = candidates[0].n;
    const p75 = candidates[candidates.length - 1].n;
    if (p25 <= p75) return { p25, p75 };
    return null;
  }

  const satComp = findBand(/SAT\s+Composite|Composite\s*\(SAT\s+Total\)|SAT\s+Total/i, [400, 1600]);
  if (satComp) out.enrolledSAT = satComp;
  else {
    const ebrw = findBand(/SAT\s+Evidence|SAT\s+EBRW|Critical\s+Reading|Evidence-?Based\s+Reading/i, [200, 800]);
    const math = findBand(/SAT\s+Math|^Math\s+\(SAT\)/i, [200, 800]);
    if (ebrw && math) out.enrolledSAT = { p25: ebrw.p25 + math.p25, p75: ebrw.p75 + math.p75 };
  }

  const actComp = findBand(/ACT\s+Composite/i, [10, 36]);
  if (actComp) out.enrolledACT = actComp;

  return out;
}

// ─── C12 average / mean GPA ───────────────────────────────────────────
// Many schools publish an "Average HS GPA" line (sometimes labeled "Mean
// GPA") near the C12 distribution. CDS doesn't mandate it but it's
// extremely useful: a single 3.91 number is more comparable across
// schools than the cumulative-distribution-derived p25/p75.
export function extractC12AverageGPA(allText) {
  // Common phrasings: "Average GPA: 3.91", "Mean high school GPA 3.91",
  // "Average high school GPA: 3.91", "Average GPA of enrolled freshmen 3.91"
  // The form's own wording puts the number after "first-time, first-year"
  // (the label wraps around it: "…first-year 3.94 students who submitted
  // GPA:"); a blank slot leaves only "%" behind and matches nothing.
  const patterns = [
    /Average\s+(?:high\s+school\s+|HS\s+)?GPA\s+of\s+all\s+degree-seeking,?\s+first-time,?\s+first-year\s+(?:students\s+who\s+submitted\s+GPA:?\s*)?(\d\.\d{1,2})\b/i,
    /(?:Average|Mean)\s+(?:high\s+school\s+|HS\s+)?GPA(?:\s+of\s+enrolled[^\n]*)?[\s:]*([\d.]+)/i,
    /Average\s+GPA[^\n]{0,30}?([\d.]+)\s*(?:\n|$|\(|on)/i,
  ];
  for (const re of patterns) {
    const m = allText.match(re);
    if (m) {
      const v = Number(m[1]);
      if (v > 1.0 && v <= 5.0) return v;
    }
  }
  return null;
}

// ─── C12: GPA distribution → derive p25/p75 unweighted GPA ───────────
export function extractC12GPA(allText) {
  // The form words each row "between 3.75 and 3.99"; a dash form is kept
  // for documents that condense the label. Without the "and" alternative
  // every cached record came through with no GPA band at all. The text
  // has no line breaks, so the percentage must sit right after the label:
  // a blank table (Columbia) would otherwise read the "100%" total of a
  // later row into every band.
  const labelMap = [
    ["4.00", /4\.0+\s+([\d.]+)\s*%/, 4.00],
    ["3.75-3.99", /3\.75\s*(?:[-–]|and)\s*3\.99[^\n%\d]{0,12}?([\d.]+)\s*%/i, 3.75],
    ["3.50-3.74", /3\.50?\s*(?:[-–]|and)\s*3\.74[^\n%\d]{0,12}?([\d.]+)\s*%/i, 3.50],
    ["3.25-3.49", /3\.25\s*(?:[-–]|and)\s*3\.49[^\n%\d]{0,12}?([\d.]+)\s*%/i, 3.25],
    ["3.00-3.24", /3\.0{1,2}\s*(?:[-–]|and)\s*3\.24[^\n%\d]{0,12}?([\d.]+)\s*%/i, 3.00],
    ["2.50-2.99", /2\.50?\s*(?:[-–]|and)\s*2\.99[^\n%\d]{0,12}?([\d.]+)\s*%/i, 2.50],
    ["2.00-2.49", /2\.0{1,2}\s*(?:[-–]|and)\s*2\.49[^\n%\d]{0,12}?([\d.]+)\s*%/i, 2.00],
  ];
  const pcts = [];
  for (const [label, re, lower] of labelMap) {
    const m = allText.match(re);
    if (m) pcts.push({ label, lower, pct: Number(m[1]) });
  }
  if (pcts.length < 3) return null;
  // Sort top→bottom
  pcts.sort((a, b) => b.lower - a.lower);
  let cum = 0, p75 = null, p25 = null;
  for (const r of pcts) {
    cum += r.pct;
    if (p75 == null && cum >= 25) p75 = r.lower;
    if (p25 == null && cum >= 75) p25 = r.lower;
  }
  if (p25 == null && p75 != null) p25 = Math.max(0, p75 - 0.4);
  if (p75 == null) return null;
  return { p25, p75, source: "C12_cumulative" };
}

// ─── Test policy ─────────────────────────────────────────────────────
// CDS C8A is a 5-column table whose row "SAT or ACT" gets a single X in
// one of: Required / Required-for-some / Recommended / Not-required-but-
// considered (test-optional) / Not-considered-even-if-submitted (test-
// blind). Column header text wraps across multiple y-lines, so we
// approximate column boundaries from the words "Required", "considered"
// and "submitted" markers when they appear within a header band.
export function extractTestPolicyPositional(items) {
  const lines = groupByLine(items, 2.5);
  // Find C8A row(s). The row is "SAT or ACT" followed by an X mark.
  const satRow = lines.find((l) => l.items.some((i) => /^SAT\s+or\s+ACT$/i.test(i.str.trim())));
  // Not found is null, not a policy: the caller decides the default (a
  // text layer keeps "test_required" as before; an OCR read, which misses
  // rows, leaves the policy unknown rather than telling a student a
  // test-optional school requires scores — Bradley's 2025-26 record).
  if (!satRow) return null;
  const xItem = satRow.items.find((i) => /^[Xx•✓✔]$/.test(i.str.trim()));
  if (!xItem) return null;
  const xPos = xItem.x;

  // Locate the C8A header band (within ~80pt above the row, same page)
  const header = lines.filter(
    (l) =>
      l.page === satRow.page &&
      l.y > satRow.y &&
      l.y < satRow.y + 80
  );
  // Build {keyword → x} map by scanning header tokens
  const headerTokens = [];
  for (const line of header) {
    for (const it of line.items) {
      const s = it.str.trim();
      if (/^Admission$/.test(s)) headerTokens.push({ key: "admission", x: it.x });
      if (/^Required$/.test(s) || /^Required\s+to/.test(s)) headerTokens.push({ key: "required", x: it.x });
      if (/^Required\s+for$/i.test(s) || /^some$/i.test(s)) headerTokens.push({ key: "some", x: it.x });
      if (/^Recommended$/i.test(s)) headerTokens.push({ key: "recommended", x: it.x });
      if (/^Not\s+required\s+for$/i.test(s) || /^submitted$/i.test(s)) headerTokens.push({ key: "test_optional", x: it.x });
      if (/^Not$/i.test(s) && header.some((l2) => l2.items.some((it2) => /^considered\s+for/i.test(it2.str.trim())))) headerTokens.push({ key: "test_blind", x: it.x });
    }
  }
  // Heuristic boundaries: 5 columns roughly evenly spaced. We look at the
  // x-distribution of identifiers and pick the closest one to xPos.
  // Simpler & robust: define x-bins by the column anchors we recorded.
  // For each candidate key we may have multiple x's; collapse to the min.
  const cols = {};
  for (const t of headerTokens) {
    if (cols[t.key] == null || t.x < cols[t.key]) cols[t.key] = t.x;
  }
  // Collapse: ensure the 5 buckets we care about
  const buckets = [
    { key: "test_required", x: cols.admission ?? cols.required },
    { key: "test_required_some", x: cols.some },
    { key: "test_recommended", x: cols.recommended },
    { key: "test_optional", x: cols.test_optional },
    { key: "test_blind", x: cols.test_blind },
  ].filter((b) => b.x != null);
  if (buckets.length < 2) {
    // Fall back to simple text matching if positional fails
    const t = items.map((i) => i.str).join(" ");
    if (/test[\s-]?blind/i.test(t)) return "test_blind";
    if (/test[\s-]?optional/i.test(t)) return "test_optional";
    return "test_required";
  }
  // Snap xPos to the nearest bucket center
  let nearest = buckets[0];
  let dist = Math.abs(xPos - buckets[0].x);
  for (const b of buckets.slice(1)) {
    const d = Math.abs(xPos - b.x);
    if (d < dist) { dist = d; nearest = b; }
  }
  // Reduce intermediate buckets to either required / optional / blind
  if (nearest.key === "test_blind") return "test_blind";
  if (nearest.key === "test_optional" || nearest.key === "test_recommended") return "test_optional";
  return "test_required";
}

// Plain-text fallback (kept for callers that already have the text).
export function extractTestPolicy(text) {
  if (/test[\s-]?blind/i.test(text)) return "test_blind";
  if (/test[\s-]?optional/i.test(text)) return "test_optional";
  return "test_required";
}

// ─── Year ────────────────────────────────────────────────────────────
export function extractYear(text) {
  const m = text.match(/Common\s+Data\s+Set\s+(\d{4})\s*[-–]\s*(\d{2,4})/i);
  if (m) return Number(m[1]);
  return null;
}

// ─── Top-level: parse one PDF into a CDS record ──────────────────────
// Strategy: positional pass first (works for text-rendered CDSes like
// Princeton/MIT). Fall back to form-fields for any field positional
// missed (works for AcroForm CDSes like Cornell/UW). The two paths
// produce the same record shape so the merge is straightforward.
// parseCDSPositional({ method }): orchestrates C1/C7/C9/C12 extraction
// from one CDS PDF.
//
//   method: "auto" (default) — pdfjs primary, OCR fallback for image-only
//           "ocr"             — OCR for the text/positional layer (still
//                               merges form-field reads as a second pass)
//           "pdfjs"           — pdfjs only, no OCR fallback
//
// The C7/C9/C1/C12 extractors are method-agnostic: they consume the same
// `{page, x, y, str, width}[]` items shape that both pdfjs and tesseract
// produce.
// ─── Wider read: C9 sections, C10, C13, C14, C21, C22, H2, I2 ─────────
// Everything the VERIFIED DATA block could cite beyond the admit rate and
// composite bands: SAT section middle-50% bands (so a student's Math and
// Reading & Writing scores compare section by section), the share of
// enrolled students who submitted each test, class-rank shares, the
// application fee, Early Decision volume and admit rate, the closing dates
// the school reported (RD, ED, ED II, EA) plus aid filing dates, the average
// first-year aid package, and the student-to-faculty ratio. Two PDF
// generations are handled: the older form puts a label's numbers on the
// next line ("SAT Evidence-Based Reading" / "740 760 780"); the newer one
// keeps label and numbers together ("SAT Math 720 750 780"). Dates are kept
// as the month-day the document states ("01-03") with the raw text, never
// converted to a year here — the CDS describes the previous cycle.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function parseCdsMonthDay(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  let m = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/);
  if (m) {
    const month = Number(m[1]), day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { mmdd: `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, raw };
  }
  m = raw.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
  if (m) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3))) + 1;
    const day = Number(m[2]);
    if (month >= 1 && day >= 1 && day <= 31) return { mmdd: `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, raw };
  }
  return null;
}

// The C9 score-range tables: rows such as "700-800 97% 99%" (SAT sections),
// "1400-1600 99%" (SAT total) and "30-36 100% 98% 93% 99% 97%" (ACT
// composite and sections). A blank cell shifts the remaining values left
// in the text, so each percentage is assigned to the header column nearest
// its x position; when no header can be located, rows are read by order
// only when every column is filled.
const RANGE_ROW_RE = /^(\d{1,4})\s*[-–]\s*(\d{1,4})\b|^Below\s+(\d{1,2})\b/i;
const PERCENT_TOKEN_RE = /^(\d{1,3}(?:\.\d+)?)\s?%$/;

export function extractScoreDistributions(lineObjs) {
  const tables = { satComposite: [], satSections: { ebrw: [], math: [] }, actComposite: [], actSections: { english: [], math: [], reading: [], science: [] } };
  const text = (line) => line.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
  const percentItems = (line) => {
    const out = [];
    for (let i = 0; i < line.items.length; i++) {
      const raw = line.items[i].str.trim();
      const joined = raw === "%" ? null : (raw.endsWith("%") ? raw : (line.items[i + 1]?.str.trim() === "%" ? `${raw}%` : raw));
      const m = joined && joined.match(PERCENT_TOKEN_RE);
      if (m) out.push({ x: line.items[i].x, pct: Math.round(Number(m[1]) * 10) / 10 });
    }
    return out;
  };
  // Header anchors: the x of each column label within the few lines above
  // the first data row of a table.
  const anchorsAbove = (index, labels) => {
    const found = {};
    for (let k = index - 1; k >= Math.max(0, index - 5); k--) {
      for (const it of lineObjs[k].items) {
        // pdfjs may hand over "ACT Composite" as one item, so a label is
        // matched at the end of the token, not as the whole token.
        const token = it.str.trim().toLowerCase().replace(/[^a-z-]/g, "");
        for (const [key, names] of Object.entries(labels)) {
          if (found[key] == null && names.some((name) => token === name || token.endsWith(name))) found[key] = it.x + (it.width || 0) / 2;
        }
      }
    }
    return Object.keys(found).length === Object.keys(labels).length ? found : null;
  };
  const assign = (values, anchors, order) => {
    const byKey = {};
    if (anchors) {
      for (const v of values) {
        let best = null;
        for (const key of order) {
          const d = Math.abs(v.x - anchors[key]);
          if (best == null || d < best.d) best = { key, d };
        }
        if (best && byKey[best.key] == null) byKey[best.key] = v.pct;
      }
      if (Object.keys(byKey).length === values.length) return byKey;
    }
    if (values.length === order.length) order.forEach((key, i) => { byKey[key] = values[i].pct; });
    return Object.keys(byKey).length ? byKey : null;
  };
  let anchors = { sat: undefined, act: undefined };
  for (let i = 0; i < lineObjs.length; i++) {
    const line = text(lineObjs[i]);
    const m = line.match(RANGE_ROW_RE);
    if (!m) continue;
    const low = m[3] != null ? 0 : Number(m[1]);
    const high = m[3] != null ? Number(m[3]) - 1 : Number(m[2]);
    if (!(high >= low)) continue;
    const values = percentItems(lineObjs[i]);
    if (!values.length) continue;
    if (high <= 36) {
      if (anchors.act === undefined) anchors.act = anchorsAbove(i, { composite: ["composite"], english: ["english"], math: ["math", "mathematics"], reading: ["reading"], science: ["science"] });
      const row = assign(values, anchors.act, ["composite", "english", "math", "reading", "science"]);
      if (!row) continue;
      if (row.composite != null) tables.actComposite.push({ low, high, pct: row.composite });
      for (const key of ["english", "math", "reading", "science"]) if (row[key] != null) tables.actSections[key].push({ low, high, pct: row[key] });
    } else if (high <= 800) {
      if (anchors.sat === undefined) anchors.sat = anchorsAbove(i, { ebrw: ["evidence-based", "evidence", "reading"], math: ["math", "mathematics"] });
      const row = assign(values, anchors.sat, ["ebrw", "math"]);
      if (!row) continue;
      for (const key of ["ebrw", "math"]) if (row[key] != null) tables.satSections[key].push({ low, high, pct: row[key] });
    } else if (high <= 1600 && values.length === 1) {
      tables.satComposite.push({ low, high, pct: values[0].pct });
    }
  }
  // Keep a table only when it reads like a whole distribution: a total near
  // 100 (a single 100% band is a real reading at the most selective schools).
  const whole = (rows) => rows.length >= 1 && Math.abs(rows.reduce((sum, r) => sum + r.pct, 0) - 100) <= 6 ? rows : null;
  const out = {};
  if (whole(tables.satComposite)) out.satComposite = tables.satComposite;
  const satSections = Object.fromEntries(Object.entries(tables.satSections).filter(([, rows]) => whole(rows)));
  if (Object.keys(satSections).length) out.satSections = satSections;
  if (whole(tables.actComposite)) out.actComposite = tables.actComposite;
  const actSections = Object.fromEntries(Object.entries(tables.actSections).filter(([, rows]) => whole(rows)));
  if (Object.keys(actSections).length) out.actSections = actSections;
  return Object.keys(out).length ? out : null;
}

// C11: "Percent who had GPA of 4.0 73.3%", "Percent who had GPA between
// 3.75 and 3.99 16.5%", … "Percent who had GPA below 1.0". The newest form
// carries three columns (students who submitted scores, who did not, all
// enrolled); the last percentage on a line is the all-enrolled figure
// whenever more than one is filled. Blank rows are 0, and a table that is
// blank throughout (Columbia) is not a distribution at all.
const GPA_BAND_CEILINGS = { "3.75": 3.99, "3.50": 3.74, "3.25": 3.49, "3.00": 3.24, "2.50": 2.99, "2.00": 2.49, "1.00": 1.99 };

export function extractGpaDistribution(lines) {
  const rows = [];
  let filled = 0;
  let sum = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let band = null;
    let m;
    if (/Percent who had GPA of 4\.0/i.test(line)) band = { low: 4, high: 4 };
    else if ((m = line.match(/Percent who had GPA between (\d\.\d{1,2}) and (\d\.\d{1,2})/i))) band = { low: Number(m[1]), high: Number(m[2]) };
    // A label cut short by the layout ("Percent who had GPA between 3.75
    // 36%") still names the band's floor; its ceiling is the form's.
    else if ((m = line.match(/Percent who had GPA between (\d\.\d{1,2})\b(?!\s+and)/i))) band = { low: Number(m[1]), high: GPA_BAND_CEILINGS[Number(m[1]).toFixed(2)] ?? Number(m[1]) };
    else if (/Percent who had GPA below 1\.0/i.test(line)) band = { low: 0, high: 0.99 };
    if (!band) continue;
    const own = [...line.replace(/^.*?(?:of 4\.0|between \d\.\d{1,2}(?: and \d\.\d{1,2})?|below 1\.0)/i, "").matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)].map((x) => Number(x[1]));
    // Older layout: the percentage alone on the next line.
    const next = own.length ? [] : [...String(lines[i + 1] || "").matchAll(/^(\d{1,3}(?:\.\d+)?)\s?%$/g)].map((x) => Number(x[1]));
    const values = own.length ? own : next;
    const pct = values.length ? Math.round(values[values.length - 1] * 10) / 10 : 0;
    if (values.length) filled++;
    sum += pct;
    rows.push({ ...band, pct });
  }
  if (filled < 3 || Math.abs(sum - 100) > 6) return null;
  return rows;
}

// The 25th and 75th percentile GPA bands implied by a distribution: the
// band in which the cumulative share from the top crosses 25% and 75%.
export function gpaBandFromDistribution(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.low - a.low);
  let cum = 0;
  let p75 = null;
  let p25 = null;
  for (const row of sorted) {
    cum += Number(row.pct) || 0;
    if (p75 == null && cum >= 25) p75 = row.low;
    if (p25 == null && cum >= 75) p25 = row.low;
  }
  if (p75 == null) return null;
  if (p25 == null) p25 = sorted[sorted.length - 1].low;
  return { p25, p75, source: "C11_cumulative" };
}

export function extractExtras(items) {
  const lineObjs = groupByLine(items, 2.5);
  const lines = lineObjs.map((l) => l.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim());
  const extras = {};
  const find = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; return -1; };
  const windowText = (i, n) => lines.slice(Math.max(0, i), i + n).join(" ");
  // Whole numbers not attached to a range, decimal or percentage.
  const numbers = (text, lo, hi) => [...String(text).matchAll(/(?<![\d.\-–$])(\d{1,3}(?:,\d{3})+|\d+)(?![\d.%\-–])/g)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => n >= lo && n <= hi);
  // Two numbers are the 25th and 75th percentile; three carry the median
  // between them (the newer form prints all three).
  const band = (values) => (values.length >= 2
    ? { p25: values[0], ...(values.length >= 3 ? { p50: values[1] } : {}), p75: values[values.length - 1] }
    : null);
  const afterLabel = (line, labelRe) => String(line).replace(labelRe, "").trim();
  // Percentages keep their decimals: "97.8%" is 97.8, not the 8 that the
  // old whole-number read produced (which turned Stanford's class-rank and
  // submit shares into 8% and 3%).
  const pct = (line) => { const m = String(line || "").match(/(\d{1,3}(?:\.\d+)?)\s?%/); return m ? Math.round(Number(m[1]) * 10) / 10 : null; };

  // C9: section bands. The first label occurrence is the percentile table;
  // the later one heads the score-range distribution and is skipped by
  // requiring 2–3 plain numbers within the label line or the next two.
  // A "(200 - 800)" scale note after the label is not a score; a real
  // section band sits well above the floor and spans at most a few hundred
  // points. ACT sections read the same way on the 1–36 scale.
  const stripScale = (text) => String(text).replace(/\(\s*\d{1,3}\s*[-–]\s*\d{1,3}\s*\)/g, " ");
  const plausibleSat = (b) => Boolean(b) && b.p25 >= 300 && b.p25 <= b.p75 && b.p75 - b.p25 <= 250;
  const plausibleAct = (b) => Boolean(b) && b.p25 >= 1 && b.p25 <= b.p75 && b.p75 <= 36 && b.p75 - b.p25 <= 15;
  const sectionBand = (labelRe, { lo = 200, hi = 800, plausible = plausibleSat } = {}) => {
    let from = 0;
    for (let guard = 0; guard < 4; guard++) {
      const i = find(labelRe, from);
      if (i < 0) return null;
      const own = numbers(stripScale(afterLabel(lines[i], labelRe)), lo, hi);
      // Older layout: the numbers sit on a following line of their own —
      // never pooled across lines, and never a line that carries the next
      // row's label (a blank "ACT Writing" row must not read ACT Science's
      // scores from the line beneath it).
      let below = [];
      for (let k = i + 1; k <= i + 2 && k < lines.length && below.length < 2; k++) {
        if (!/^[\d,\s]+$/.test(lines[k])) break;
        below = numbers(stripScale(lines[k]), lo, hi);
      }
      const candidate = band(own.length >= 2 ? own : below);
      if (plausible(candidate) && !/score range|%/i.test(windowText(i, 3))) return candidate;
      from = i + 1;
    }
    return null;
  };
  // The label wraps in some documents ("SAT Evidence-Based" / "740 760 780"
  // / "Reading and Writing"), so "Reading and Writing" is optional.
  const ebrw = sectionBand(/SAT\s+Evidence-?\s*Based(?:\s+Reading(?:\s+and(?:\s+Writing)?)?)?/i);
  const math = sectionBand(/SAT\s+Math(?:ematics)?\b/i);
  if (ebrw || math) extras.satSections = { ...(ebrw ? { ebrw } : {}), ...(math ? { math } : {}) };
  const actSections = {};
  for (const [key, re] of [["english", /ACT\s+English\b/i], ["math", /ACT\s+Math(?:ematics)?\b/i], ["reading", /ACT\s+Reading\b/i], ["science", /ACT\s+Science\b/i]]) {
    const found = sectionBand(re, { lo: 1, hi: 36, plausible: plausibleAct });
    if (found) actSections[key] = found;
  }
  if (Object.keys(actSections).length) extras.actSections = actSections;

  const satSubmit = find(/Submitting SAT Scores/i);
  const actSubmit = find(/Submitting ACT Scores/i);
  if (satSubmit >= 0 || actSubmit >= 0) {
    extras.submitting = {
      ...(satSubmit >= 0 && pct(lines[satSubmit]) != null ? { satPct: pct(lines[satSubmit]) } : {}),
      ...(actSubmit >= 0 && pct(lines[actSubmit]) != null ? { actPct: pct(lines[actSubmit]) } : {}),
    };
    if (!Object.keys(extras.submitting).length) delete extras.submitting;
  }

  // The score-range tables under C9 — what share of the enrolled class's
  // submitted scores fell in each band — read column by column.
  const distribution = extractScoreDistributions(lineObjs);
  if (distribution) extras.scoreDistribution = distribution;

  // C10 class rank: the shares in the top tenth, quarter and half, and the
  // share of the class that submitted a rank at all (the number may sit on
  // the label's line or on the next one).
  const topTenth = find(/top tenth of high school graduating class/i);
  const topQuarter = find(/top quarter of high school graduating class/i);
  const topHalf = find(/top half of high school graduating class/i);
  const c11 = find(/C11\b|Percentage of all enrolled, degree-seeking/i, Math.max(0, topTenth));
  if (topTenth >= 0 || topQuarter >= 0) {
    const rank = {};
    const share = (i) => (i >= 0 ? pct(lines[i].replace(/^.*?class/i, "")) : null);
    if (share(topTenth) != null) rank.topTenthPct = share(topTenth);
    if (share(topQuarter) != null) rank.topQuarterPct = share(topQuarter);
    if (share(topHalf) != null) rank.topHalfPct = share(topHalf);
    const submitted = find(/students who submitted/i, Math.max(topTenth, topQuarter) + 1);
    if (submitted >= 0 && (c11 < 0 || submitted < c11)) {
      const value = pct(afterLabel(windowText(submitted, 3), /^.*?who submitted/i));
      if (value != null) rank.submittedPct = value;
    }
    if (Object.keys(rank).length) extras.classRank = rank;
  }

  // C11 / C12: the enrolled class's high-school GPA distribution, its
  // average, and the share who submitted a GPA. A blank table (Columbia
  // does not report GPA) yields nothing rather than a row of zeros.
  const gpaDistribution = extractGpaDistribution(lines);
  if (gpaDistribution) extras.gpaDistribution = gpaDistribution;
  const gpa = {};
  const avgLabel = find(/Average high school GPA/i);
  if (avgLabel >= 0) {
    // Up to 5.0: a school that averages weighted GPAs (Harvard reports
    // 4.21) is a real reading, not a scale note.
    const m = windowText(avgLabel, 3).match(/(?<![\d.])([1-5]\.\d{1,2})\b(?!\s*(?:%|scale))/);
    if (m) gpa.average = Number(m[1]);
    const submitted = find(/Percent of total[^%]*who submitted/i, avgLabel);
    if (submitted >= 0) {
      const value = pct(afterLabel(windowText(submitted, 3), /^.*?who submitted/i));
      if (value != null) gpa.submittedPct = value;
    }
  }
  if (Object.keys(gpa).length) extras.gpa = gpa;

  // C13 application fee
  const fee = find(/Amount of application fee/i);
  if (fee >= 0) {
    const m = windowText(fee, 2).match(/Amount of application fee:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
    if (m) extras.applicationFeeUsd = Math.round(Number(m[1].replace(/,/g, "")));
  }

  // C21 early decision volume
  const edReceived = find(/Number of early decision applications received/i);
  const edAdmitted = find(/Number of applicants admitted under early decision plan/i);
  if (edReceived >= 0 && edAdmitted >= 0) {
    const received = numbers(afterLabel(windowText(edReceived, 2), /.*?received(?: by your(?: institution)?)?/i), 1, 200000)[0];
    const admitted = numbers(afterLabel(windowText(edAdmitted, 2), /.*?early decision plan/i), 1, 200000)[0];
    if (received && admitted && admitted <= received) {
      extras.earlyDecision = { applications: received, admitted, admitRate: Math.round((admitted / received) * 10000) / 10000 };
    }
  }

  // C14 / C21 / C22 / H: closing and filing dates, same line as the label
  // only — a blank slot's next line is the next label.
  const dateAfter = (labelRe) => {
    const i = find(labelRe);
    if (i < 0) return null;
    return parseCdsMonthDay(afterLabel(lines[i], labelRe));
  };
  const dates = {
    regularClosing: dateAfter(/Application closing date \(fall\):?/i),
    edClosing: dateAfter(/First or only early decision plan closing date:?/i),
    edNotification: (() => { const i = find(/First or only early decision plan notification date:?/i); return i >= 0 ? (afterLabel(lines[i], /First or only early decision plan notification date:?/i) || null) : null; })(),
    edIIClosing: dateAfter(/Other early decision plan closing date:?/i),
    eaClosing: dateAfter(/^Early action closing date:?/i),
    aidPriority: dateAfter(/Priority date for filing required financial aid forms:?/i),
    aidDeadline: dateAfter(/^Deadline for filing required financial aid forms:?/i),
  };
  for (const key of Object.keys(dates)) if (!dates[key]) delete dates[key];
  if (Object.keys(dates).length) extras.dates = dates;

  // H2 average first-year aid package: first dollar figure after the label.
  const pkg = find(/average financial aid package/i);
  if (pkg >= 0) {
    const m = windowText(pkg, 4).match(/\$\s*([\d,]{4,})/);
    if (m) extras.aid = { averagePackageFirstYearUsd: Number(m[1].replace(/,/g, "")) };
  }

  // I2 student-to-faculty ratio
  const ratio = find(/Student to Faculty r(?:atio)?\b/i);
  if (ratio >= 0) {
    const m = windowText(ratio, 2).match(/(\d{1,2})\s*to\s*1\b/i);
    if (m) extras.studentFacultyRatio = `${m[1]} to 1`;
  }

  return extras;
}

// The version both parsers stamp on a record. The store re-ingests a parsed
// file that carries a newer version than its row, and the refresh skips a
// cached document whose row already carries this one (cachedParseIsCurrent).
// Bump it whenever a parser reads more, or reads differently. Version 7
// (2026-09-22) sends a document whose text layer is unreadable glyph codes
// to OCR instead of reading nothing from it.
export const CDS_PARSER_VERSION = 7;

export async function parseCDSPositional(pdfPath, { method = "auto" } = {}) {
  const items = await extractItems(pdfPath, { method });
  const allText = items.map((i) => i.str).join(" ");
  // Version 4 reads ACT section bands, the score-range and GPA
  // distributions, the C12 average and the submitted shares, and keeps the
  // decimals of every percentage; version 5 reads the 2025-26 template's
  // C1 rows ("males" / "females" / "students of unknown sex"). The store
  // re-ingests records whose parsed file carries a newer version than the
  // row. Version 6 adds the remaining sections (cds-sections.js): B
  // enrollment, retention and graduation, the wait list, Early Action,
  // transfer volume, student life, the year's costs, need met, class size.
  const positional = { source: "cds", parserVersion: CDS_PARSER_VERSION };
  // Surface the actual extraction source so the validator and the AI
  // assistant can caveat numbers with lower confidence when OCR was used.
  if (items._source === "tesseract") {
    positional.parserNotes = (positional.parserNotes || []).concat(
      method === "ocr" ? "ocr_primary" : "ocr_fallback"
    );
    positional.extractionMethod = "ocr";
  } else {
    positional.extractionMethod = "pdfjs";
  }
  positional.year = extractYear(allText);
  positional.testPolicy = extractTestPolicyPositional(items) ?? (items._source === "tesseract" ? null : "test_required");
  const counts = extractC1Counts(items);
  if (counts) {
    positional.b1 = counts;
    if (counts.applied && counts.admitted) positional.overallAdmitRate = round4(counts.admitted / counts.applied);
    if (counts.admitted && counts.enrolled) positional.yieldRate = round4(counts.enrolled / counts.admitted);
  }
  Object.assign(positional, extractC9Bands(items));
  let extras = null;
  try {
    extras = extractExtras(items);
    const sections = extractSections(lineStringsFromGroups(groupByLine(items, 2.5)));
    extras = { ...extras, ...sections, ...(extras.aid || sections.aid ? { aid: { ...(extras.aid || {}), ...(sections.aid || {}) } } : {}) };
    if (Object.keys(extras).length) positional.extras = extras;
  } catch (e) {
    positional.parserNotes = (positional.parserNotes || []).concat("extras_failed: " + String(e.message).slice(0, 60));
  }
  // The GPA band comes from the line-by-line C11 read when the table is
  // filled (it takes the all-enrolled column); the text scan is the
  // fallback for documents whose rows the line read could not place.
  const gpa = gpaBandFromDistribution(extras?.gpaDistribution) || extractC12GPA(allText);
  if (gpa) positional.enrolledGPA = gpa;
  const avgGPA = extractC12AverageGPA(allText) ?? extras?.gpa?.average ?? null;
  if (avgGPA != null) {
    positional.enrolledGPA = positional.enrolledGPA || {};
    positional.enrolledGPA.avg = avgGPA;
  }
  const c1Sub = extractC1SubBreakdowns(items);
  if (c1Sub) positional.c1Breakdown = c1Sub;
  const c7 = extractC7Positional(items);
  if (c7 && Object.values(c7).some((v) => v !== "not_considered")) positional.c7 = c7;

  // Form-fields pass: only run if positional left key fields empty.
  const needsFormFields =
    !positional.b1 ||
    !positional.enrolledSAT ||
    !positional.c7;
  if (needsFormFields) {
    const { extractFormFields, buildCDSFromFormFields } = await import("./cds-pdf-form-fields.js");
    try {
      const fields = await runDocumentJob(() => extractFormFields(pdfPath), { background: true });
      const fromForm = buildCDSFromFormFields(fields);
      if (fromForm) {
        // Merge: positional wins where present; form fills in the rest.
        if (!positional.b1 && fromForm.b1) {
          positional.b1 = fromForm.b1;
          positional.overallAdmitRate = fromForm.overallAdmitRate;
          positional.yieldRate = fromForm.yieldRate;
        }
        if (!positional.enrolledSAT && fromForm.enrolledSAT) positional.enrolledSAT = fromForm.enrolledSAT;
        if (!positional.enrolledACT && fromForm.enrolledACT) positional.enrolledACT = fromForm.enrolledACT;
        if (!positional.enrolledGPA && fromForm.enrolledGPA) positional.enrolledGPA = fromForm.enrolledGPA;
        if (!positional.c7 && fromForm.c7) positional.c7 = fromForm.c7;
        if ((positional.testPolicy === "test_required" || positional.testPolicy == null) && fromForm.testPolicy && fromForm.testPolicy !== "test_required") {
          positional.testPolicy = fromForm.testPolicy;
        }
        positional.parserNotes = (positional.parserNotes || []).concat("merged_form_fields");
      }
    } catch (e) {
      positional.parserNotes = (positional.parserNotes || []).concat("form_fields_failed: " + String(e.message).slice(0, 60));
    }
  }
  if (!positional.c7) positional.c7 = {};
  return positional;
}


