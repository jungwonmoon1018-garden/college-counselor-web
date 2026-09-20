// cds-pdf-c7.js — the C7 reader: which admission factors a school marks very
// important, important, considered or not considered, read by column
// position. Moved out of cds-pdf-parser.js on 2026-09-20, which re-exports
// what it exported.
import { groupByLine } from "./cds-pdf-text.js";

// ─── C7: Factor importance ratings (positional) ──────────────────────
// CDS C7 is a 4-column table:
//   [factor name] [Very Important] [Important] [Considered] [Not Considered]
// We:
//   1. Find the C7 page(s).
//   2. Locate the 4 column headers ("Very Important", "Important",
//      "Considered", "Not Considered") and record their X centers.
//   3. For each factor row, find the X mark in that row and assign it
//      to the nearest column.
export const C7_FACTOR_PATTERNS = [
  ["rigor",            /rigor\s+of\s+secondary\s+school\s+record/i],
  ["class_rank",       /class\s+rank/i],
  ["gpa",              /academic\s+gpa/i],
  ["test_scores",      /standardized\s+test\s+scores/i],
  ["application_essay", /application\s+essay/i],
  ["recommendations",  /recommendation/i],
  ["interview",        /interview/i],
  ["ec",               /extracurricular\s+activities/i],
  ["talent_ability",   /talent.{0,3}ability/i],
  ["character",        /character.{0,3}personal\s+qualities/i],
  ["first_generation", /first\s+generation/i],
  ["alumni_relation",  /alumni.{0,4}relation/i],
  ["geographical_residence", /geographical\s+residence/i],
  ["state_residency",  /state\s+residency/i],
  ["religious_affiliation", /religious\s+affiliation/i],
  ["racial_ethnic_status", /racial.{0,3}ethnic\s+status/i],
  ["volunteer_work",   /volunteer\s+work/i],
  ["work_experience",  /work\s+experience/i],
  ["level_of_interest", /level\s+of\s+applicant.{0,3}\s*interest/i],
];

const C7_COLUMNS = [
  ["very_important", /very\s*important/i],
  ["important",      /^important$/i],   // anchored to avoid catching "Very Important"
  ["considered",     /^considered$/i],
  ["not_considered", /not\s*considered/i],
];

export function extractC7Positional(items) {
  // Concatenate same-line items into "blob" tokens because pdfjs-dist
  // can split words across multiple items. We rebuild each line as an
  // ordered list of (x, text) tokens.
  const lines = groupByLine(items, 2.5);

  // 1. Find the line containing all 4 column headers.
  let headerLine = null;
  for (const line of lines) {
    const text = line.items.map((i) => i.str).join(" ");
    if (/very\s*important/i.test(text) && /not\s*considered/i.test(text)) {
      headerLine = line;
      break;
    }
  }
  if (!headerLine) {
    // Header sometimes split across two lines (each column on its own line);
    // fall back: scan a window of lines for 4 headers near each other in y.
    for (let k = 0; k < lines.length; k++) {
      const window = lines.slice(k, k + 3);
      const flat = window.flatMap((l) => l.items);
      const hasAll =
        flat.some((i) => /very\s*important/i.test(i.str)) &&
        flat.some((i) => /^important$/i.test(i.str.trim())) &&
        flat.some((i) => /^considered$/i.test(i.str.trim())) &&
        flat.some((i) => /not\s*considered/i.test(i.str));
      if (hasAll) { headerLine = { page: window[0].page, y: window[0].y, items: flat }; break; }
    }
  }
  if (!headerLine) return null;

  // 2. Extract column X centers
  // Three layouts:
  //   (a) pdfjs renders "Very Important" as one item — single regex match
  //       gives us the column anchor directly.
  //   (b) OCR splits at every space — "Very" and "Important" land as
  //       separate items at adjacent X positions. We pair them up.
  //   (c) OCR sometimes glues across spaces — "Veryimportant|" — and
  //       prepends/appends bracket noise like "[Not" or "Considered]".
  //       Both are handled by stripping non-alphanumerics before matching.
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z]+/g, "");
  const cols = {};
  for (const [key, re] of C7_COLUMNS) {
    const item = headerLine.items.find((i) => re.test(i.str.trim()) || re.test(norm(i.str)));
    if (item) cols[key] = item.x + (item.width || 30) / 2;
  }
  // Word-split fallback for OCR: detect the four columns by anchor words
  // and pair them up by horizontal proximity.
  if (Object.keys(cols).length < 3) {
    const verys = headerLine.items.filter((i) => norm(i.str) === "very");
    const importants = headerLine.items.filter((i) => norm(i.str) === "important");
    const considereds = headerLine.items.filter((i) => norm(i.str) === "considered");
    const nots = headerLine.items.filter((i) => norm(i.str) === "not");
    // Glued OCR variants: "veryimportant", "notconsidered"
    const glued = headerLine.items.filter((i) => norm(i.str) === "veryimportant");
    if (glued.length > 0 && cols.very_important == null) {
      cols.very_important = glued[0].x + (glued[0].width || 30) / 2;
    }
    const gluedNot = headerLine.items.filter((i) => norm(i.str) === "notconsidered");
    if (gluedNot.length > 0 && cols.not_considered == null) {
      cols.not_considered = gluedNot[0].x + (gluedNot[0].width || 30) / 2;
    }

    // Pair "Very" with the nearest "Important" to its right → very_important center
    if (verys.length > 0 && importants.length > 0) {
      const v = verys[0];
      const importantNearVery = importants
        .filter((i) => i.x > v.x)
        .sort((a, b) => (a.x - v.x) - (b.x - v.x))[0];
      if (importantNearVery) {
        cols.very_important = (v.x + importantNearVery.x + (importantNearVery.width || 30)) / 2;
      }
    }
    // The remaining "Important" (not paired with Very) is the standalone column
    const standaloneImportant = importants.find((i) =>
      !verys.some((v) => Math.abs(i.x - v.x) < 80 && i.x > v.x));
    if (standaloneImportant && cols.important == null) {
      cols.important = standaloneImportant.x + (standaloneImportant.width || 30) / 2;
    }
    // Pair "Not" with the nearest "Considered" to its right → not_considered
    if (nots.length > 0 && considereds.length > 0) {
      const n = nots[0];
      const consNearNot = considereds
        .filter((c) => c.x > n.x)
        .sort((a, b) => (a.x - n.x) - (b.x - n.x))[0];
      if (consNearNot) {
        cols.not_considered = (n.x + consNearNot.x + (consNearNot.width || 30)) / 2;
      }
    }
    // The remaining "Considered" is the standalone column
    const standaloneConsidered = considereds.find((c) =>
      !nots.some((n) => Math.abs(c.x - n.x) < 80 && c.x > n.x));
    if (standaloneConsidered && cols.considered == null) {
      cols.considered = standaloneConsidered.x + (standaloneConsidered.width || 30) / 2;
    }
  }
  if (Object.keys(cols).length < 3) return null; // insufficient anchor points

  // 3. Walk lines after the header and pick out factor rows. For each
  //    factor we find its label and then locate the nearest "X" marker
  //    on the same horizontal line (or the immediately following line —
  //    pdf-parse sometimes splits the X onto its own item with a
  //    fractionally lower y).
  const headerPage = headerLine.page;
  const headerY = headerLine.y;
  const candidateLines = lines.filter((l) => l.page === headerPage && l.y < headerY ||
                                              l.page > headerPage);

  const ratings = {};
  for (const [factor, re] of C7_FACTOR_PATTERNS) {
    let labelLine = null;
    let labelXEnd = null;
    for (const line of candidateLines) {
      const lineText = line.items.map((i) => i.str).join(" ");
      if (re.test(lineText)) {
        // find the first item whose text matches part of the label, then
        // the X-mark is to its right
        labelLine = line;
        const lastLabelItem = line.items
          .filter((i) => /[A-Za-z]/.test(i.str))
          .reduce((a, b) => (a && a.x > b.x ? a : b), null);
        labelXEnd = (lastLabelItem?.x || 0) + (lastLabelItem?.width || 0);
        break;
      }
    }
    if (!labelLine) { ratings[factor] = "not_considered"; continue; }

    // Recompute labelXEnd ignoring single-character X marks (so we don't
    // mistake the X marker itself for the end of the label text).
    const labelTextItems = labelLine.items.filter((i) => {
      const s = i.str.trim();
      return /[A-Za-z]/.test(s) && s.length > 2 && !/^[Xx]+$/.test(s);
    });
    const lastTextItem = labelTextItems.reduce((a, b) => (a && a.x > b.x ? a : b), null);
    labelXEnd = (lastTextItem?.x || 0) + (lastTextItem?.width || 0);

    // Find X-mark candidates: short string ("X", "x", "•", "✓") to the
    // right of the label end, within ±2pt vertically.
    const xCandidates = [];
    for (const it of labelLine.items) {
      if (it.x < labelXEnd + 5) continue;
      const s = it.str.trim();
      if (/^[Xx•✓✔]$/.test(s)) xCandidates.push(it);
    }
    // Also scan immediate neighbour lines (CDS sometimes splits X to its
    // own y-line a fractional point above/below the label).
    for (const line of candidateLines) {
      if (line === labelLine) continue;
      if (line.page !== labelLine.page) continue;
      if (Math.abs(line.y - labelLine.y) > 2) continue;
      for (const it of line.items) {
        if (it.x < labelXEnd + 5) continue;
        const s = it.str.trim();
        if (/^[Xx•✓✔]$/.test(s)) xCandidates.push(it);
      }
    }

    if (xCandidates.length === 0) { ratings[factor] = "not_considered"; continue; }

    // Use the leftmost X (in case there's noise) and assign to nearest col.
    xCandidates.sort((a, b) => a.x - b.x);
    const x = xCandidates[0].x;
    let nearest = null, nearestDist = Infinity;
    for (const [key, cx] of Object.entries(cols)) {
      const d = Math.abs(x - cx);
      if (d < nearestDist) { nearestDist = d; nearest = key; }
    }
    ratings[factor] = nearest || "not_considered";
  }
  return ratings;
}
