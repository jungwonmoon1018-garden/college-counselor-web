// cds-pdf-c1.js — the C1 reader: applied, admitted and enrolled counts across
// the layouts schools publish, and the sub-breakdowns beside them. Moved out
// of cds-pdf-parser.js on 2026-09-20, which re-exports what it exported.
import { groupByLine, round4 } from "./cds-pdf-text.js";

// ─── C1: First-year admission counts (applied / admitted / enrolled) ─
// CDS C1 comes in two layouts. The classic one has a row per gender under
// three headers ("Total first-time, first-year men who applied … 21,054"),
// each ending with the Total column, and the gender rows are summed. The
// other (UNC, CMU, Indiana, the 2025-26 template's own table) has one row
// per count with Men / Women / Another / Unknown columns, with or without a
// Total column, and no gender word in the label. Workbook exports
// complicate both: the form view and a coded data view share spreadsheet
// rows, so one line carries several labels each followed by its own
// number, and every label appears twice. Hence a number is only ever read
// from the tokens immediately after its label, and each distinct label
// counts once. The residency table repeats the no-gender labels with other
// numbers, which is why gender rows win when present and only the first
// occurrence of a no-gender label counts. Before this, Cornell's and
// Illinois's workbooks summed to 184,557 applicants and UNC and CMU read no
// counts at all.
export function extractC1Counts(items) {
  const lines = groupByLine(items, 2.5);
  const result = {};
  const NUMERIC = /^[\d,]+$/;

  // Numeric tokens right after a label: the rest of the label's own item,
  // then the following items, until something non-numeric (a "-" cell, the
  // next label) ends the run. `blocked` reports that something non-numeric
  // followed, which rules out the wrapped-number fallback. Indiana writes
  // "who applied in Fall 2024" between the label and the numbers; that
  // phrase is not a column.
  function numbersAfter(lineItems, itemIndex, tail) {
    const rest = [String(tail || ""), ...lineItems.slice(itemIndex + 1).map((it) => it.str)]
      .join(" ")
      .replace(/\bin\s+fall\b\s*(?:\d{4})?\.?/gi, " ")
      // Middlebury qualifies its rows: "who were admitted (September only) 775".
      .replace(/\([^)]*\)/g, " ");
    const nums = [];
    for (const raw of rest.split(/\s+/)) {
      // A token of punctuation alone (a colon after the label, the
      // semicolon OCR read after "admitted" in Bradley's document) is
      // neither a number nor the next label.
      const s = raw.trim().replace(/^[:;.,|]+$/, "");
      if (!s) continue;
      if (!NUMERIC.test(s)) return { nums, blocked: true };
      nums.push(Number(s.replace(/,/g, "")));
    }
    return { nums, blocked: false };
  }

  // A row with one number is that number. A row with several is either
  // Men / Women / … / Total, where the last number is the total and the
  // others add up to it, or Men / Women / Another / Unknown with no total
  // column (Indiana), where the numbers are summed.
  function rowTotal(nums) {
    if (nums.length === 1) return nums[0];
    const last = nums[nums.length - 1];
    const rest = nums.slice(0, -1).reduce((a, b) => a + b, 0);
    if (rest === last) return last;
    // Three or more columns whose last is at least the sum of the others
    // is a Total column with a cell the read dropped (Bradley's residency
    // table by OCR: in-state 6,341, out-of-state 1,369, international 2,
    // total 8,539); summing would count the total twice. Two columns are
    // men and women, summed.
    if (nums.length >= 3 && last >= rest) return last;
    return rest + last;
  }

  // Match canonical CDS labels and the UPenn-style "(freshman)" parenthetical.
  // Also tolerate optional "of " before "another gender" / "unknown gender"
  // (Cornell uses "of another gender", Princeton uses "another gender").
  // "(degree-seeking)" is the residency table's own qualifier ("Total
  // first-time, first-year (degree-seeking) who applied", with a Total
  // column), the table this reader falls back on when the gender rows are
  // incomplete.
  const FROSH = "first-time,?\\s+first-year,?(?:\\s*\\((?:freshman|degree-seeking)\\))?";
  // The 2025-26 template renamed the rows: "males", "females" and "students
  // of unknown sex" (or "of another sex") replace "men", "women", "another
  // gender" and "unknown gender". Ten of the eleven 2025-26 documents in the
  // cache parsed with no counts at all until these were added.
  const GENDER = "(men|women|males|females|(?:students\\s+of\\s+|of\\s+)?(?:another|unknown)\\s+(?:gender|sex))";
  const GENDER_WORD = new RegExp(`\\b(?:${GENDER})\\b`, "i");

  function total(rowRe) {
    const re = new RegExp(rowRe.source, "gi");
    const byGender = new Map();
    const plain = new Map();
    for (let i = 0; i < lines.length; i++) {
      const lineItems = lines[i].items;
      let text = "";
      const ends = [];
      for (const it of lineItems) {
        text += (text ? " " : "") + it.str;
        ends.push(text.length);
      }
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const end = m.index + m[0].length;
        const k = ends.findIndex((e) => e >= end);
        let { nums, blocked } = numbersAfter(lineItems, k, text.slice(end, ends[k]));
        if (nums.length === 0 && !blocked && i + 1 < lines.length) {
          // UPenn-, UNC- and Indiana-style documents wrap the numbers to the
          // following y-line. Only adopt them when that line is not itself a
          // labeled row (otherwise the wrong row's count would be read). OCR
          // often prepends a bracket "[" to row text, so strip leading
          // non-letters before the "starts with Total" check.
          const next = lines[i + 1];
          const nextText = next.items.map((it) => it.str).join(" ").replace(/^[^A-Za-z]+/, "");
          if (!/^Total\s+(first-time|full-time|part-time)/i.test(nextText)) nums = numbersAfter(next.items, -1, "").nums;
        }
        if (nums.length === 0) continue;
        // Workbooks spell the same row with and without "who" in the two
        // views, so the key drops it along with punctuation and case.
        const key = m[0].toLowerCase().replace(/[,:]|\(freshman\)|\bwho\b|\bstudents\b/g, "").replace(/\s+/g, " ").trim();
        const bucket = GENDER_WORD.test(m[0]) ? byGender : plain;
        if (!bucket.has(key)) bucket.set(key, rowTotal(nums));
      }
    }
    // Gender rows win over the no-gender rows (which the residency table
    // repeats with other numbers) only when they include men or women:
    // OCR of Bradley's 2025-26 document recognised just the "unknown sex"
    // rows, and their 19 applicants stood in for 8,539 until the
    // residency table's totals were allowed to win instead.
    const genderComplete = [...byGender.keys()].some((k) => /\b(men|women|males|females)\b/i.test(k));
    const use = genderComplete ? byGender : (plain.size ? plain : byGender);
    if (use.size === 0) return null;
    let sum = 0;
    for (const v of use.values()) sum += v;
    return sum;
  }

  // "students who applied" (Indiana, and the all-students rows of the
  // workbooks) and "who admitted" (Indiana) are tolerated beside the
  // canonical "who applied" / "who were admitted".
  const applied = total(new RegExp(`\\bTotal\\s+${FROSH}(?:\\s+${GENDER})?\\s+(?:students\\s+)?(?:who\\s+)?applied`, "i"));
  const admitted = total(new RegExp(`\\bTotal\\s+${FROSH}(?:\\s+${GENDER})?\\s+(?:students\\s+)?(?:who\\s+)?(?:were\\s+)?admitted`, "i"));
  // Enrollees row uses "Total full-time/part-time, first-time, first-year <gender> who enrolled"
  const enrolled = total(new RegExp(`\\bTotal\\s+(?:full-time|part-time),?\\s+${FROSH}(?:\\s+${GENDER})?\\s+(?:students\\s+)?(?:who\\s+)?enrolled`, "i"));

  if (applied) result.applied = applied;
  if (admitted) result.admitted = admitted;
  if (enrolled) result.enrolled = enrolled;

  // An OCR read that adds up to fewer than 100 applicants read the wrong
  // rows: no school in the repository index is that small, and a wrong
  // small count makes a false admit rate that passes every other check.
  if (items._source === "tesseract" && result.applied != null && result.applied < 100) return null;

  // Sanity: applied >= admitted >= enrolled (drop any failures)
  if (result.applied && result.admitted && result.admitted > result.applied) delete result.admitted;
  if (result.admitted && result.enrolled && result.enrolled > result.admitted) delete result.enrolled;

  return Object.keys(result).length ? result : null;
}

// ─── C1 sub-breakdowns: residency, decision plan, per-gender ─────────
// CDS C1 reports much richer detail than the totals: in-state vs
// out-of-state, ED vs RD, men vs women admit rates. The positioning
// engine uses these for ED-aware selectivity adjustment and for
// flagging gender-imbalanced schools (STEM admits skew female-friendly
// at some institutions).
export function extractC1SubBreakdowns(items) {
  const lines = groupByLine(items, 2.5);
  const out = {};

  function findNumberAfterLabel(labelRe) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.items.map((it) => it.str).join(" ");
      if (!labelRe.test(t)) continue;
      const nums = line.items
        .map((it) => it.str.trim())
        .filter((s) => /^[\d,]+$/.test(s))
        .map((s) => Number(s.replace(/,/g, "")))
        .filter((n) => n > 0);
      if (nums.length > 0) return nums[nums.length - 1];
      // Try next line for split layouts
      if (i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextText = next.items.map((it) => it.str).join(" ");
        if (!/^Total/i.test(nextText)) {
          const nums2 = next.items
            .map((it) => it.str.trim())
            .filter((s) => /^[\d,]+$/.test(s))
            .map((s) => Number(s.replace(/,/g, "")))
            .filter((n) => n > 0);
          if (nums2.length > 0) return nums2[nums2.length - 1];
        }
      }
    }
    return null;
  }

  // ── Per-gender admit counts (from C1 totals rows) ──
  const FROSH = "first-time,?\\s+first-year(?:\\s*\\(freshman\\))?";
  const menApplied = findNumberAfterLabel(new RegExp(`Total\\s+${FROSH}\\s+men\\s+who\\s+applied`, "i"));
  const womenApplied = findNumberAfterLabel(new RegExp(`Total\\s+${FROSH}\\s+women\\s+who\\s+applied`, "i"));
  const menAdmitted = findNumberAfterLabel(new RegExp(`Total\\s+${FROSH}\\s+men\\s+who\\s+were\\s+admitted`, "i"));
  const womenAdmitted = findNumberAfterLabel(new RegExp(`Total\\s+${FROSH}\\s+women\\s+who\\s+were\\s+admitted`, "i"));

  if (menApplied && menAdmitted) {
    out.byGender = out.byGender || {};
    out.byGender.men = { applied: menApplied, admitted: menAdmitted, admitRate: round4(menAdmitted / menApplied) };
  }
  if (womenApplied && womenAdmitted) {
    out.byGender = out.byGender || {};
    out.byGender.women = { applied: womenApplied, admitted: womenAdmitted, admitRate: round4(womenAdmitted / womenApplied) };
  }

  // ── Residency (state / non-resident / international) ──
  const stateApplied = findNumberAfterLabel(/(?:Number\s+of\s+)?(?:state\s+resident|in[- ]?state)\s+(?:first-year\s+)?applicants/i);
  const stateAdmitted = findNumberAfterLabel(/(?:Number\s+of\s+)?(?:state\s+resident|in[- ]?state)\s+(?:first-year\s+)?(?:admits|admitted)/i);
  if (stateApplied && stateAdmitted) {
    out.byResidency = out.byResidency || {};
    out.byResidency.inState = { applied: stateApplied, admitted: stateAdmitted, admitRate: round4(stateAdmitted / stateApplied) };
  }
  const intlApplied = findNumberAfterLabel(/international\s+(?:first-year\s+)?applicants/i);
  const intlAdmitted = findNumberAfterLabel(/international\s+(?:first-year\s+)?(?:admits|admitted)/i);
  if (intlApplied && intlAdmitted) {
    out.byResidency = out.byResidency || {};
    out.byResidency.international = { applied: intlApplied, admitted: intlAdmitted, admitRate: round4(intlAdmitted / intlApplied) };
  }

  // ── ED / EA / RD splits ──
  // Patterns:
  //   "Number of applicants admitted under early decision plan"
  //   "Number of students who applied early decision"
  const edApplied = findNumberAfterLabel(/early\s+decision[^\n]*?(?:applicants|applied)/i);
  const edAdmitted = findNumberAfterLabel(/early\s+decision[^\n]*?(?:admits|admitted)/i);
  if (edApplied && edAdmitted) {
    out.byDecisionPlan = out.byDecisionPlan || {};
    out.byDecisionPlan.earlyDecision = { applied: edApplied, admitted: edAdmitted, admitRate: round4(edAdmitted / edApplied) };
  }
  const eaApplied = findNumberAfterLabel(/early\s+action[^\n]*?(?:applicants|applied)/i);
  const eaAdmitted = findNumberAfterLabel(/early\s+action[^\n]*?(?:admits|admitted)/i);
  if (eaApplied && eaAdmitted) {
    out.byDecisionPlan = out.byDecisionPlan || {};
    out.byDecisionPlan.earlyAction = { applied: eaApplied, admitted: eaAdmitted, admitRate: round4(eaAdmitted / eaApplied) };
  }

  return Object.keys(out).length ? out : null;
}
