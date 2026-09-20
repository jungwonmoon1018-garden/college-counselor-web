// policy-scout-extract.js — the scout's pure extraction: test policy, plans
// and deadlines (sentences and tables), the application fee, the policy
// fields and the diff between two reads, with SCOUT_VERSION, the constant to
// bump whenever these rules change. Moved out of admissions-policy-scout.js
// on 2026-09-20, which re-exports what it exported.
import { currentAdmissionsCycle } from "./college-research.js";

// Bumped whenever discovery or extraction changes; a boot after a bump
// re-scouts immediately instead of waiting for the next cadence.
export const SCOUT_VERSION = 4;

// ─── Pure extraction ───────────────────────────────────────────────────
export const TEST_POLICY_LABELS = Object.freeze({
  test_optional: "test-optional",
  test_required: "test scores required",
  test_blind: "test-blind (scores not considered)",
  test_flexible: "test-flexible",
});

export const PLAN_LABELS = Object.freeze({
  restrictive_early_action: "Restrictive Early Action",
  early_decision: "Early Decision",
  early_decision_2: "Early Decision II",
  early_action: "Early Action",
  regular_decision: "Regular Decision",
});

const TEST_CONTEXT_RE = /\b(?:SAT|ACT|standardized test(?:ing| scores?)?|test scores?|test[- ]?optional|test[- ]?blind|test[- ]?free|test[- ]?flexible|testing (?:policy|requirement))\b/i;

const TEST_POLICY_RULES = [
  ["test_blind", /\btest[- ]?(?:blind|free)\b|\bwill not (?:consider|review|use|look at) (?:the )?(?:SAT|ACT|standardized test|test scores)|\b(?:do|does) not consider (?:the )?(?:SAT|ACT|standardized test|test scores)/i],
  ["test_flexible", /\btest[- ]?flexible\b/i],
  ["test_required", /\b(?:SAT|ACT|standardized test(?:ing| scores)?|test scores?)\b[^.;\n]{0,40}?\b(?:are|is|will be|remain|remains|become|becomes)\s+required\b|\brequire(?:s|d)?\s+(?:the |an? |official )?(?:SAT|ACT|standardized test|test scores)|\bmust submit (?:the |an? |official )?(?:SAT|ACT|(?:standardized )?test scores)|\breinstat(?:e|es|ed|ing) (?:the |its |our |a )?(?:SAT|ACT|standardized test|testing) requirement/i],
  ["test_optional", /\btest[- ]?optional\b|\b(?:SAT|ACT|test scores?)\b[^.;\n]{0,40}?\b(?:are|is|remain|remains)\s+(?:not required|optional)\b|\b(?:not|no longer) required to submit (?:the |an? )?(?:SAT|ACT|test scores)|\b(?:may|can) (?:choose|elect|opt|decide) (?:whether (?:or not )?)?to submit/i],
];

const NOT_REQUIRED_NEGATION_RE = /\b(?:not|no longer|aren't|isn't|are not|is not|never)\s+(?:be\s+)?required\b|\boptional\b/i;

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

const DATE_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d\d))?\b|\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\b/g;

// Long names match case-insensitively; the abbreviations must be upper-case
// ("ed" and "rd" are ordinary words). Order matters: REA before EA, ED II
// before ED.
const PLAN_RULES = [
  ["restrictive_early_action", [/\b(?:restrictive|single[- ]choice) early action\b/i, /\bREA\b|\bSCEA\b/]],
  ["early_decision_2", [/\bearly decision (?:II|2)\b/i, /\bED ?(?:II|2)\b/]],
  ["early_decision", [/\bearly decision(?: I| 1)?\b(?! ?(?:II|2))/i, /\bED ?(?:I|1)?\b(?! ?(?:II|2))/]],
  ["early_action", [/\bearly action\b(?! ?(?:II|2))/i, /\bEA\b/]],
  // MIT calls its regular round "Regular Action (RA)".
  ["regular_decision", [/\bregular (?:decision|action)\b/i, /\bRD\b/, /\bRA\s+(?:deadline|application|applicants|cycle|round)/i]],
];

function splitSentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function pad(n) { return String(n).padStart(2, "0"); }

// Turn a month/day (optionally with a year) into the ISO date for the
// admissions cycle in progress: Aug–Dec dates belong to the cycle's first
// calendar year, Jan–Jul to its second.
export function resolveCycleDate(month, day, year, now = new Date()) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const cycle = currentAdmissionsCycle(now);
  const startYear = Number(cycle.slice(0, 4));
  const resolvedYear = year || (month >= 8 ? startYear : startYear + 1);
  const iso = `${resolvedYear}-${pad(month)}-${pad(day)}`;
  const ts = Date.parse(iso + "T00:00:00Z");
  if (!Number.isFinite(ts)) return null;
  const min = now.getTime() - 150 * 24 * 60 * 60 * 1000;
  const max = now.getTime() + 560 * 24 * 60 * 60 * 1000;
  return ts >= min && ts <= max ? iso : null;
}

function datesIn(text, now) {
  const out = [];
  DATE_RE.lastIndex = 0;
  let m;
  while ((m = DATE_RE.exec(text))) {
    const month = m[1] ? MONTHS[m[1].toLowerCase()] : Number(m[4]);
    const day = m[1] ? Number(m[2]) : Number(m[5]);
    const year = m[1] ? (m[3] ? Number(m[3]) : null) : Number(m[6]);
    const iso = resolveCycleDate(month, day, year, now);
    if (iso) out.push({ iso, index: m.index, text: m[0] });
  }
  return out;
}

function trimEvidence(sentence) {
  const s = String(sentence || "").replace(/\s+/g, " ").trim();
  return s.length > 240 ? `${s.slice(0, 237)}…` : s;
}

function yearsMentioned(sentence) {
  return [...String(sentence).matchAll(/\b(20\d\d)\b/g)].map((m) => Number(m[1]));
}

export function extractTestPolicy(pages, now = new Date()) {
  const cycle = currentAdmissionsCycle(now);
  const entryYear = Number(cycle.slice(0, 4)) + 1;
  let best = null;
  for (const page of pages) {
    for (const sentence of splitSentences(page.text)) {
      if (sentence.length > 600 || !TEST_CONTEXT_RE.test(sentence)) continue;
      let policy = null;
      for (const [name, re] of TEST_POLICY_RULES) {
        if (!re.test(sentence)) continue;
        // "SAT scores are not required" must not read as test_required.
        if (name === "test_required" && NOT_REQUIRED_NEGATION_RE.test(sentence)) continue;
        policy = name;
        break;
      }
      if (!policy) continue;
      const years = yearsMentioned(sentence);
      let score = 1;
      if (years.includes(entryYear)) score += 3;
      else if (years.length && !years.some((y) => y >= entryYear - 1)) score -= 2; // only past cycles mentioned
      if (/\bfirst[- ]year|freshman|first-time/i.test(sentence)) score += 1;
      if (/\btest[- ]?(?:optional|blind|free|flexible)\b|\brequired\b/i.test(sentence)) score += 1;
      if (!best || score > best.score) {
        const through = sentence.match(/\b(?:through|until|for)\s+(?:the\s+)?(?:fall\s+|the\s+)?(?:(20\d\d)(?:[-–](\d\d))?|(?:entering\s+)?class(?:es)?\s+of\s+(20\d\d))/i);
        best = {
          score,
          value: policy,
          through: through ? (through[3] ? `Class of ${through[3]}` : `${through[1]}${through[2] ? `-${through[2]}` : ""}`) : null,
          evidence: trimEvidence(sentence),
          sourceUrl: page.url,
        };
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...policy } = best;
  return policy;
}

// A line that states the plan's deadline outright ("Restrictive Early
// Action: November 1", "Early Decision deadline: Nov 1") outranks a hedged
// note that happens to name the plan and a date ("if you intend to submit
// an REA application with an arts portfolio, submit by October 15").
const DEADLINE_HINT_RE = /\bdeadlines?\b|\bdue\b|must be (?:submitted|received)|submit(?:ted)? by|application date|apply by/i;

// A plan-change window ("ED I applicants can change to ED II until November
// 15") and a reply-by date name a plan and a date without stating the plan's
// deadline; Johns Hopkins' ED II read as November 15 from exactly such a
// sentence. Decision release is not hedged here: MIT's deadline sentence
// says when decisions are released in the same breath.
const DEADLINE_HEDGE_RE = /portfolio|arts? supplement|audition|financial aid|css profile|fafsa|scholarship|priority|housing|deposit|interview|recommendation|transcript|mid-?year|if you (?:intend|plan|choose|wish)|optional|\bchange (?:to|from|your|their|plans?)\b|\bswitch(?:ing)?\b|\breply[- ]by\b/i;

const DEADLINE_STANDARD_RE = /\bstandard\b|\bwithout\b|\bregular applicants\b/i;

function scoreDeadlineLine(sentence) {
  let score = 0;
  if (DEADLINE_HINT_RE.test(sentence)) score += 3;
  if (DEADLINE_HEDGE_RE.test(sentence)) score -= 4;
  if (sentence.length < 120) score += 1; // table rows read as short lines
  return score;
}

const SECTION_LINES = 14; // how far below a plan header its dates may sit

const HEADER_MAX_CHARS = 60;

const CELL_MAX_CHARS = 40; // one table cell on a line of its own ("January 2, 2027")

const TABLE_MAX_ROWS = 8;

function planOnLine(sentence) {
  for (const [plan, rules] of PLAN_RULES) {
    const m = rules.map((re) => re.exec(sentence)).find(Boolean);
    if (m) return { plan, index: m.index };
  }
  return null;
}

// Every plan named on a line in order of appearance, one entry per plan.
function plansOnLine(sentence) {
  const found = [];
  for (const [plan, rules] of PLAN_RULES) {
    for (const re of rules) {
      const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      for (const m of String(sentence || "").matchAll(global)) found.push({ plan, index: m.index, end: m.index + m[0].length });
    }
  }
  found.sort((a, b) => a.index - b.index || b.end - a.end);
  const out = [];
  for (const hit of found) {
    if (out.some((o) => hit.index < o.end || o.plan === hit.plan)) continue;
    out.push(hit);
  }
  return out;
}

// Rows of a dates table that are about something other than when the
// application is due — the aid filing date, the decision release, the
// reply-by date. Real dates, never the plan's deadline.
const TABLE_ROW_OTHER_RE = /financial aid|css profile|fafsa|scholarship|housing|deposit|interview|recommendation|transcript|mid-?year|portfolio|audition|notif|releas|reply|respon|announce|decisions? (?:date|by|posted|available|sent|mailed)/i;

// What a row label looks like, as opposed to a column header ("Transfer").
const ROW_LABEL_RE = /deadline|due|date|apply|application|submit|notif|releas|reply|respon|decision|aid|deposit|scholarship|priority|announce/i;

const CELL_PLACEHOLDER_RE = /^(?:rolling|n\/?a|tba|tbd|none|not offered|not available|[-–—])\.?$/i;

// A cell is the date and little else ("November 1*", "Jan. 2"); a line such
// as "Common Application Deadline: October 15" is a statement, not a cell.
function tableCell(line, now) {
  if (!line || line.length > CELL_MAX_CHARS) return null;
  if (CELL_PLACEHOLDER_RE.test(line)) return { placeholder: true };
  const dates = datesIn(line, now);
  if (dates.length !== 1) return null;
  const rest = line.replace(dates[0].text, "").replace(/[^a-z0-9]/gi, "");
  return rest.length <= 12 ? { iso: dates[0].iso, text: line } : null;
}

function scoreTableRow(label, rowIndex) {
  // A table pairs plan and date explicitly, like a same-line statement, and
  // its cells read as short lines — the same +2 and +1 the line logic gives.
  let score = 3;
  if (label) {
    if (DEADLINE_HINT_RE.test(label)) score += 3;
    if (/application|apply/i.test(label)) score += 1;
    if (DEADLINE_HEDGE_RE.test(label)) score -= 4;
  }
  if (rowIndex === 0) score += 1; // an unlabeled table puts the deadline first
  return score;
}

// Header-row tables — plans across the top, one date per column beneath —
// reach the text as one cell per line when the page's source breaks lines
// between cells (Johns Hopkins), or as one line per row when it does not.
// The section logic pairs the last header with the first date below it,
// which gave Hopkins' Early Decision II the ED I date; the columns have to
// be zipped. Returns the paired candidates and the lines a table used, so
// the line-by-line pass leaves them alone.
function tableCandidates(lines, now) {
  const candidates = [];
  const consumed = new Set();
  const headerCell = (line) => Boolean(line) && line.length <= CELL_MAX_CHARS && !datesIn(line, now).length;
  const rowLabel = (line) => Boolean(line) && line.length <= HEADER_MAX_CHARS && !datesIn(line, now).length && !plansOnLine(line).length && ROW_LABEL_RE.test(line);
  const cellsAt = (start, width) => {
    const cells = [];
    for (let i = start; i < start + width; i += 1) {
      const cell = tableCell(lines[i], now);
      if (!cell) return null;
      cells.push(cell);
    }
    return cells;
  };
  const emit = (columns, rows) => {
    rows.forEach((row, rowIndex) => {
      if (row.label && TABLE_ROW_OTHER_RE.test(row.label)) return;
      const score = scoreTableRow(row.label, rowIndex);
      columns.forEach((plan, col) => {
        const cell = row.cells[col];
        if (!plan || !cell?.iso) return;
        candidates.push({ plan, score, date: cell.iso, evidence: `${PLAN_LABELS[plan]} — ${row.label ? `${row.label}: ` : ""}${cell.text}` });
      });
    });
  };

  for (let j = 0; j < lines.length; j += 1) {
    if (consumed.has(j)) continue;

    // One line per row: "Early Decision I Early Decision II Regular Decision"
    // over "Application Deadline November 1, 2026 January 2, 2027 January 2, 2027".
    const line = lines[j];
    const plans = line && line.length <= 200 && !datesIn(line, now).length ? plansOnLine(line) : [];
    if (plans.length >= 2) {
      // Only whitespace and punctuation may separate the plan columns, and
      // nothing but a corner cell may precede the first: a non-plan column
      // among or before them would shift every date.
      const gaps = [line.slice(0, plans[0].index), ...plans.slice(1).map((p, k) => line.slice(plans[k].end, p.index))];
      if (gaps.every((g) => g.replace(/[^a-z0-9]/gi, "").length <= 3)) {
        const rows = [];
        for (let r = j + 1; r < lines.length && rows.length < TABLE_MAX_ROWS; r += 1) {
          const rowLine = lines[r];
          if (!rowLine || rowLine.length > 400 || plansOnLine(rowLine).length) break;
          const dates = datesIn(rowLine, now);
          if (dates.length < plans.length) break;
          rows.push({ label: rowLine.slice(0, dates[0].index).replace(/[\s:–—-]+$/, "").trim() || null, cells: dates.map((d) => ({ iso: d.iso, text: d.text })), line: r });
        }
        if (rows.length) {
          emit(plans.map((p) => p.plan), rows);
          consumed.add(j);
          for (const row of rows) consumed.add(row.line);
          j = rows[rows.length - 1].line;
          continue;
        }
      }
    }

    // One cell per line: a run of date cells, with the headers (and an
    // optional row label) on the lines just above it.
    if (!tableCell(line, now)?.iso) continue;
    let k = j;
    while (k < lines.length && tableCell(lines[k], now)) k += 1;
    const run = k - j;
    if (run < 2) { j = k - 1; continue; }
    const labeled = rowLabel(lines[j - 1]);
    let headers = [];
    let width = run;
    if (labeled) {
      for (let h = j - 2; h >= 0 && headers.length < run; h -= 1) {
        if (!headerCell(lines[h])) break;
        headers.unshift(lines[h]);
      }
      if (headers.length !== run) { j = k - 1; continue; }
    } else {
      for (let h = j - 1; h >= 0 && headers.length < run; h -= 1) {
        if (!headerCell(lines[h])) break;
        headers.unshift(lines[h]);
      }
      while (headers.length && !plansOnLine(headers[0]).length) headers.shift(); // headings above the table
      if (headers.length === run) width = run;
      else if (headers.length >= 2 && run % headers.length === 0) width = headers.length; // unlabeled rows back to back
      else { j = k - 1; continue; }
    }
    const columns = headers.map((h) => plansOnLine(h)[0]?.plan || null);
    if (new Set(columns.filter(Boolean)).size < 2) { j = k - 1; continue; }

    const rows = [];
    let next = labeled ? j : j;
    if (labeled) {
      rows.push({ label: lines[j - 1], cells: cellsAt(j, width) });
      next = j + width;
      while (rows.length < TABLE_MAX_ROWS && rowLabel(lines[next])) {
        const cells = cellsAt(next + 1, width);
        if (!cells) break;
        rows.push({ label: lines[next], cells });
        next += 1 + width;
      }
    } else {
      while (next < k) {
        rows.push({ label: null, cells: cellsAt(next, width) });
        next += width;
      }
    }
    emit(columns, rows);
    for (let i = j - headers.length - (labeled ? 1 : 0); i < next; i += 1) consumed.add(i);
    j = next - 1;
  }
  return { candidates, consumed };
}

// Three layouts occur on real pages:
//   • same line — "Early Decision: November 1" / "November 1 — Early Decision";
//   • section — the plan name is a heading and the dates follow on later
//     lines, often under sub-headings ("With Arts Portfolio" / "Standard");
//   • header-row table — plans across the top, dates beneath, read by
//     column (tableCandidates).
// Every candidate is scored so a plain deadline statement beats a hedged
// note, and a "standard" line beats a portfolio/supplement variant.
export function extractDeadlines(pages, now = new Date()) {
  const best = {};
  const consider = (plan, score, date, sentence, page) => {
    if (!best[plan] || score > best[plan].score) {
      best[plan] = { score, date, evidence: trimEvidence(sentence), sourceUrl: page.url };
    }
  };
  for (const page of pages) {
    const lines = String(page.text || "").split(/\n+/).map((l) => l.trim());
    const table = tableCandidates(lines, now);
    for (const c of table.candidates) consider(c.plan, c.score, c.date, c.evidence, page);
    let section = null; // { plan, line, hedged }
    for (let i = 0; i < lines.length; i += 1) {
      if (table.consumed.has(i)) { section = null; continue; }
      const sentence = lines[i];
      if (!sentence || sentence.length > 400) continue;
      const dates = datesIn(sentence, now);
      const planHere = planOnLine(sentence);

      if (!dates.length) {
        const isHeader = sentence.length <= HEADER_MAX_CHARS;
        if (planHere && isHeader) section = { plan: planHere.plan, line: i, hedged: false };
        else if (section && isHeader && DEADLINE_HEDGE_RE.test(sentence)) section.hedged = true;
        else if (section && isHeader && DEADLINE_STANDARD_RE.test(sentence)) section.hedged = false;
        continue;
      }

      if (planHere) {
        // Prefer the first date after the plan name; fall back to the
        // nearest date before it ("November 1 — Early Decision").
        const after = dates.find((d) => d.index > planHere.index && d.index - planHere.index <= 120);
        const before = [...dates].reverse().find((d) => d.index < planHere.index && planHere.index - d.index <= 60);
        const pick = after || before;
        if (pick) consider(planHere.plan, scoreDeadlineLine(sentence) + 2, pick.iso, sentence, page);
        continue;
      }

      if (section && i - section.line <= SECTION_LINES) {
        // A dated sub-block header ("Application with Optional Arts
        // Portfolio - October 15") hedges the lines that follow it until a
        // "Standard …" line opens the plain block.
        if (DEADLINE_HEDGE_RE.test(sentence)) section.hedged = true;
        else if (DEADLINE_STANDARD_RE.test(sentence)) section.hedged = false;
        let score = scoreDeadlineLine(sentence);
        if (section.hedged) score -= 4;
        if (/\bstandard\b/i.test(sentence)) score += 2;
        if (/common app(?:lication)?|coalition|application deadline|application due/i.test(sentence)) score += 1;
        consider(section.plan, score, dates[0].iso, `${PLAN_LABELS[section.plan]} — ${sentence}`, page);
      }
    }
  }
  const found = {};
  for (const [plan, entry] of Object.entries(best)) {
    const { score: _score, ...rest } = entry;
    found[plan] = rest;
  }
  return found;
}

export function extractApplicationFee(pages) {
  for (const page of pages) {
    for (const sentence of splitSentences(page.text)) {
      if (!/\bapplication fee\b|\bfee to apply\b|\bfree to apply\b/i.test(sentence) || sentence.length > 400) continue;
      if (/\bno application fee\b|\bfree to apply\b|\bapplication fee\b[^.;\n]{0,30}?\bwaived for all\b/i.test(sentence)) {
        return { amount: 0, evidence: trimEvidence(sentence), sourceUrl: page.url };
      }
      const m = sentence.match(/\bapplication fee\b[^.;\n]{0,60}?\$\s?(\d{2,3})\b/i) || sentence.match(/\$\s?(\d{2,3})\b[^.;\n]{0,40}?\bapplication fee\b/i);
      if (m) return { amount: Number(m[1]), evidence: trimEvidence(sentence), sourceUrl: page.url };
    }
  }
  return null;
}

export function extractPolicyFromPages(pages, now = new Date()) {
  return {
    cycle: currentAdmissionsCycle(now),
    // The rules that produced this reading; a snapshot from an older scout
    // is re-read on demand (snapshotIsCurrent) and ahead of fresh ones in
    // the next sweep.
    scoutVersion: SCOUT_VERSION,
    testPolicy: extractTestPolicy(pages, now),
    deadlines: extractDeadlines(pages, now),
    applicationFee: extractApplicationFee(pages),
  };
}

// Flatten a policy into comparable field → value pairs (what the change log
// and the fact store see).
export function policyFields(policy) {
  const fields = {};
  if (policy?.testPolicy?.value) {
    fields.test_policy = {
      value: `${TEST_POLICY_LABELS[policy.testPolicy.value] || policy.testPolicy.value}${policy.testPolicy.through ? ` (through ${policy.testPolicy.through})` : ""}`,
      sourceUrl: policy.testPolicy.sourceUrl,
      severity: "high",
      type: "text",
    };
  }
  for (const [plan, entry] of Object.entries(policy?.deadlines || {})) {
    if (!entry?.date) continue;
    fields[`deadline_${plan}`] = { value: entry.date, sourceUrl: entry.sourceUrl, severity: "high", type: "date" };
  }
  if (policy?.applicationFee && Number.isFinite(policy.applicationFee.amount)) {
    fields.application_fee = {
      value: policy.applicationFee.amount === 0 ? "no fee" : `${policy.applicationFee.amount} USD`,
      sourceUrl: policy.applicationFee.sourceUrl,
      severity: "normal",
      type: "text",
    };
  }
  return fields;
}

export function diffPolicies(previous, next) {
  const before = policyFields(previous);
  const after = policyFields(next);
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key]?.value ?? null;
    const b = after[key]?.value ?? null;
    if (a === b) continue;
    // A field that merely dropped out of the fetched pages is not a policy
    // change — pages get restructured; only a stated → different stated
    // value counts.
    if (a != null && b == null) continue;
    changes.push({
      field: key,
      previousValue: a,
      newValue: b,
      sourceUrl: after[key]?.sourceUrl || before[key]?.sourceUrl || null,
      severity: after[key]?.severity || "normal",
    });
  }
  return changes;
}
