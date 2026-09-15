// ═══════════════════════════════════════════════════════════════════════
// cds-sections.js — the remaining Common Data Set sections
// ═══════════════════════════════════════════════════════════════════════
// Read from the document's lines: B (undergraduate enrollment, first-year
// retention, six-year graduation), C2 (wait list), C22 (Early Action), D2
// (transfer volume), F1 (where first-year students come from and live), G1
// (the year's tuition, fees, food and housing), H2 (the share of need met)
// and I3 (class size). C1, C7, C9–C12, the application fee, Early Decision
// and the closing dates are read in cds-pdf-parser.js. The layouts vary:
// Indiana and the workbooks put the numbers on the label's line, Harvard
// and Stanford wrap them to the next line, the workbooks print ratios
// (0.71) where the PDFs print percentages (71%), and Harvard's graduation
// grid holds ratios beside Indiana's percentages — every reader below
// accepts both, and the first-year column is kept where a table has
// several. Every field is optional; a document that lacks a section
// simply contributes nothing.
// An amount: "$67,731", "7070" or "3860.5", never the digits of a coded item
// id ("G.201" follows the G1 labels in the workbooks' coded view).
const MONEY = /(?<![\w.])\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{3,6}(?:\.\d+)?)(?![\w.]\w)/;

export function extractSections(rawLines) {
  const lines = (Array.isArray(rawLines) ? rawLines : []).map((l) => String(l || "").replace(/\s+/g, " ").trim());
  const out = {};
  const find = (re, from = 0, to = lines.length) => {
    for (let i = Math.max(0, from); i < Math.min(to, lines.length); i++) if (re.test(lines[i])) return i;
    return -1;
  };
  const window = (i, n) => lines.slice(Math.max(0, i), i + n).join(" ");
  const after = (text, re) => String(text).replace(re, "").trim();
  // Whole numbers not attached to a range, decimal, percentage or amount.
  const whole = (text) => [...String(text).matchAll(/(?<![\d.\-–$])(\d{1,3}(?:,\d{3})+|\d+)(?![\d.%\-–])/g)]
    .map((m) => Number(m[1].replace(/,/g, "")));
  // Shares: "98.00%" is 98, "0.71" is 71, "89.3617" is 89.4. Years and whole
  // counts are not shares (a share carries a % sign or a decimal point).
  const shares = (text) => [...String(text).matchAll(/(\d{1,3}(?:\.\d+)?)\s?%|(?<![\d.,$])(\d{1,3}\.\d+)(?![\d%])/g)]
    .map((m) => (m[1] != null ? Number(m[1]) : (Number(m[2]) <= 1 ? Number(m[2]) * 100 : Number(m[2]))))
    .filter((v) => v >= 0 && v <= 100)
    .map((v) => Math.round(v * 10) / 10);
  const money = (text) => { const m = String(text).match(MONEY); return m ? Math.round(Number(m[1].replace(/,/g, ""))) : null; };
  const isLabel = (line) => /^[A-Za-z(]/.test(line) && !/^\(?\d/.test(line);
  // The count after a label: on the label's line, else on the next line
  // when that line is a value and not the next label (Harvard leaves the
  // wait-list slots blank, and the next line is the next question).
  const countAfter = (i, labelRe, lo = 0, hi = 10000000) => {
    if (i < 0) return null;
    const own = whole(after(lines[i], labelRe)).filter((n) => n >= lo && n <= hi);
    if (own.length) return own[0];
    const next = lines[i + 1] || "";
    if (!next || isLabel(next)) return null;
    const nums = whole(next).filter((n) => n >= lo && n <= hi);
    return nums.length ? nums[0] : null;
  };
  const clean = (obj) => {
    for (const k of Object.keys(obj)) if (obj[k] == null) delete obj[k];
    return Object.keys(obj).length ? obj : null;
  };

  // B1: undergraduate headcount.
  const undergrad = find(/Total all undergraduates/i);
  if (undergrad >= 0) {
    const n = whole(after(lines[undergrad], /^.*?Total all undergraduates/i))[0];
    if (n) out.enrollment = { undergraduates: n };
  }

  // B22: first-year retention, as a percentage or a ratio.
  const retentionLabel = /percentage of the Fall \d{4} entering cohort who remained enrolled/i;
  let retention = find(retentionLabel);
  let retentionValue = retention >= 0 ? shares(after(window(retention, 2), /^.*?remained enrolled[^.]*\.?/i))[0] : null;
  if (retentionValue == null) {
    const alt = find(/was enrolled at your institution as of/i);
    if (alt >= 0) retentionValue = shares(after(window(alt, 4), /^.*?was enrolled at your institution as of[^?]*\??/i))[0];
  }
  if (retentionValue != null) out.retention = { firstYearPct: retentionValue };

  // B4–B21: the six-year graduation rate of the most recent cohort listed;
  // the last figure on the row is the whole-cohort column.
  const grad = find(/Six-year graduation rate for (\d{4})/i);
  if (grad >= 0) {
    const cohort = Number(lines[grad].match(/Six-year graduation rate for (\d{4})/i)[1]);
    const values = shares(after(window(grad, 2), /^.*?Six-year graduation rate for \d{4}(?: cohort)?[^0-9]*/i)).filter((v) => v >= 5);
    if (values.length) out.graduation = { sixYearPct: values[values.length - 1], cohort };
  }

  // C2: the wait list.
  const waitlist = clean({
    offered: countAfter(find(/Number of qualified applicants offered a place on waiting list/i), /^.*?on waiting list:?/i, 1, 200000),
    accepted: countAfter(find(/Number accepting a place on the waiting list/i), /^.*?on the waiting list:?/i, 1, 200000),
    admitted: countAfter(find(/Number of wait-listed students admitted/i), /^.*?students admitted:?/i, 0, 200000),
  });
  if (waitlist) out.waitlist = waitlist;

  // C22: Early Action volume, where the school reports it.
  const eaReceived = countAfter(find(/Number of early action applications received/i), /^.*?received(?: by your(?: institution)?)?:?/i, 1, 500000);
  const eaAdmitted = countAfter(find(/Number of applicants admitted under (?:an )?early action/i), /^.*?early action(?: plan)?:?/i, 1, 500000);
  if (eaReceived && eaAdmitted && eaAdmitted <= eaReceived) {
    out.earlyAction = { applications: eaReceived, admitted: eaAdmitted, admitRate: Math.round((eaAdmitted / eaReceived) * 10000) / 10000 };
  }

  // D2: transfer applicants, admits and enrollees — the Total row of the
  // table that follows the question.
  const transferQ = find(/enrolled as degree-seeking transfer/i);
  if (transferQ >= 0) {
    for (let i = transferQ + 1; i < Math.min(lines.length, transferQ + 16); i++) {
      if (!/^Total\b/i.test(lines[i])) continue;
      const nums = whole(lines[i]);
      if (nums.length >= 3 && nums[1] <= nums[0] && nums[2] <= nums[1]) {
        out.transfer = { applied: nums[0], admitted: nums[1], enrolled: nums[2] };
        break;
      }
    }
  }

  // F1: first-year students from out of state and living on campus.
  const outOfState = find(/Percent who are from out of state/i);
  const onCampus = find(/Percent who live in college-owned/i);
  const studentLife = clean({
    outOfStatePct: outOfState >= 0 ? shares(after(window(outOfState, 3), /^.*?Percent who are from out of state/i))[0] ?? null : null,
    onCampusPct: onCampus >= 0 ? shares(after(window(onCampus, 3), /^.*?Percent who live in college-owned/i))[0] ?? null : null,
  });
  if (studentLife) out.studentLife = studentLife;

  // G1: the sticker costs for the academic year the document names.
  const g1 = find(/PRIVATE INSTITUTIONS/i);
  if (g1 >= 0) {
    const region = (re) => { const i = find(re, g1, g1 + 18); return i >= 0 ? money(after(lines[i], re)) : null; };
    const yearLine = find(/FULL (\d{4}-\d{4}) academic year/i, Math.max(0, g1 - 10), g1 + 3);
    const costs = clean({
      tuitionUsd: region(/^Tuition:(?!\s*(?:In-|Out-|Non))/i),
      tuitionInStateUsd: region(/^Tuition: In-state(?: \(out-of-district\))?:?/i),
      tuitionOutOfStateUsd: region(/^Tuition: (?:Out-of-state|Nonresident|Non-resident):?/i),
      requiredFeesUsd: region(/^Required Fees:?/i),
      foodAndHousingUsd: region(/^(?:Food and Housing|Room and board) \(on-campus\):?/i),
      academicYear: yearLine >= 0 ? lines[yearLine].match(/FULL (\d{4}-\d{4}) academic year/i)[1] : null,
    });
    if (costs && Object.keys(costs).some((k) => k !== "academicYear")) out.costs = costs;
  }

  // H2: the average share of need met for students awarded need-based aid.
  const needMet = find(/On average, the percentage of need that was met/i);
  if (needMet >= 0) {
    const value = shares(after(window(needMet, 2), /^.*?need that was met/i))[0];
    if (value != null) out.aid = { needMetPct: value };
  }

  // I3: class sections by size; the share under 20 students.
  // Upper case only: the definitions above the table begin "Class Sections:".
  const sections = find(/^CLASS SECTIONS\b/);
  if (sections >= 0) {
    let nums = whole(after(lines[sections], /^CLASS SECTIONS/));
    if (nums.length < 7) nums = whole(lines[sections + 1] || "");
    if (nums.length >= 7) {
      const bands = nums.slice(0, 7);
      const total = nums[7] ?? bands.reduce((a, b) => a + b, 0);
      if (total > 0) {
        out.classSize = {
          sections: { "2-9": bands[0], "10-19": bands[1], "20-29": bands[2], "30-39": bands[3], "40-49": bands[4], "50-99": bands[5], "100+": bands[6], total },
          under20Pct: Math.round(((bands[0] + bands[1]) / total) * 1000) / 10,
        };
      }
    }
  }

  return out;
}

// The line strings the section reader consumes, from the positional items
// both parsers produce (one string per y-line, in reading order).
export function lineStringsFromGroups(lineGroups) {
  return (Array.isArray(lineGroups) ? lineGroups : []).map((l) => l.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim());
}
