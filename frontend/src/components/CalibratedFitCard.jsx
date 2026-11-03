import { t } from "../i18n.js";
import { MAX_TARGET_SCHOOLS } from "../profile/target-schools.js";

// ═══════════════════════════════════════════════════════════════════════
// CalibratedFitCard — replaces the single inflated "Fit: X%" with the
// positioning engine's SEPARATED reach/target/safety read. Honesty is the
// brand: we show a calibrated label + four independent sub-scores +
// an evidence-confidence badge, never one merged number. Falls back to the
// existing values-coverage view when positioning has no data for a school.
//
// Props:
//   collegeValues — the /api/colleges/values body (displayName, sourceUrl,
//                   values[], fit.{overall,perValueCoverage}). Used for the
//                   header, the core-values list, and the fallback. When the
//                   values read failed it is { error, code, status }, or
//                   null: the card then stands on the positioning read, with
//                   the values part marked unavailable (fit-7). It used to
//                   be hidden behind the raw English error while the chat
//                   quoted the label the server had computed and kept.
//   positioning   — a single per-school positioning object (targets[0] from
//                   /api/positioning/targets), or null while loading / when
//                   unavailable.
//   loading       — true while the positioning request is in flight.
//   schoolName    — the name to show when neither read carries one.
//   targetListFull — the target list holds its maximum, so ➕ target cannot
//                   add this school (profile/target-schools.js).
//   locale        — the app's locale. It wins over the locale the server
//                   stamped on the values body: that one falls back to the
//                   browser's Accept-Language, which put Korean placement
//                   words on the card of a student using the app in English.
// ═══════════════════════════════════════════════════════════════════════

// The reads the engine withholds a label from (positioning-engine.js): a
// record with no GPA of either kind and no SAT/ACT ("insufficient_student_
// data", since positioning_v3). A thin record used to read "Reach" at a
// 70%-admit school and "High reach" where nothing was known, with
// "academically stretched" beside it; the card now says what is missing
// instead of placing the student (fit-4). A school whose admit rate no
// source held still gets a label today, starting from an assumed 50% that
// the comparison block names; the school-side key is drawn the same way if
// the engine starts withholding that one too (fit-5).
const INSUFFICIENT_LABELS = {
  insufficient_student_data: { badge: "fit.insufficient_student_data", hint: "fit.insufficient_student_hint" },
  insufficient_school_data: { badge: "fit.insufficient_school_data", hint: "fit.insufficient_school_hint" },
};

function insufficientRead(positioning) {
  if (!positioning) return null;
  const key = String(positioning.labelKey || "");
  if (INSUFFICIENT_LABELS[key]) return INSUFFICIENT_LABELS[key];
  if (key.startsWith("insufficient_")) return INSUFFICIENT_LABELS.insufficient_student_data;
  // A payload without the key still carries the label the engine gives it.
  if (!key && positioning.overallPositioningLabel === "Not enough data yet") return INSUFFICIENT_LABELS.insufficient_student_data;
  return null;
}

// Why the values part of the card is missing, in the student's language.
// The values read needs AI consent, budget and a readable official site;
// the fit read needs none of them, so it can stand without the values.
export function valuesErrorText(valuesError, locale) {
  const code = String(valuesError?.code || "");
  const status = Number(valuesError?.status) || 0;
  let key = "fit.values_error_generic";
  if (code === "consent_required" || status === 403) key = "fit.values_error_consent";
  else if (code === "budget_exceeded" || status === 402) key = "fit.values_error_budget";
  else if (code === "openrouter_not_configured") key = "fit.values_error_not_configured";
  else if (code === "school_site_not_found") key = "fit.values_error_not_found";
  else if (code === "no_official_pages" || code === "values_not_found" || status === 404) key = "fit.values_error_unreadable";
  return t(locale, key);
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The card speaks the engine's stable codes in the student's language
// (fit-10): labelKey, summaryKey, strategyKey, mainRedFlagCodes and
// evidenceConfidenceKey, beside the English text the chat quotes. A Korean-
// mode card used to print the headline band, the summary, the flags, the
// strategy, the confidence and the double-check in English beside Korean
// bars. A payload cached before the codes existed carries only the English,
// which these maps read back to a key; anything still unknown is shown as
// the server sent it rather than blank.
const LABEL_KEY_OF = {
  "highly competitive": "highly_competitive",
  competitive: "competitive",
  reach: "reach",
  "high reach": "high_reach",
  "not enough data yet": "insufficient_student_data",
};
const SUMMARY_KEY_OF = {
  "academically in-range": "in_range",
  "academically plausible but not comfortable": "plausible",
  "academically stretched": "stretched",
  "not enough academic data yet": "not_enough_data",
};

// t() answers the key itself when no string exists; this answers the
// fallback instead, so a code the card does not know yet shows the
// server's English, never a raw key or "undefined".
function tr(locale, key, params, fallback) {
  const text = t(locale, key, params);
  return text === key ? (fallback ?? "") : text;
}

export function labelKeyOf(read) {
  if (!read) return null;
  if (read.labelKey) return String(read.labelKey);
  return LABEL_KEY_OF[String(read.overallPositioningLabel || "").trim().toLowerCase()] || null;
}

function labelText(read, locale) {
  const key = labelKeyOf(read);
  if (!key) return read?.overallPositioningLabel || "";
  const insufficient = INSUFFICIENT_LABELS[key];
  if (insufficient) return t(locale, insufficient.badge);
  return tr(locale, `fit.label_${key}`, null, read?.overallPositioningLabel || key);
}

// Map the positioning label to a reach/target/safety color band. Higher
// position = stronger standing for the student. Keyed off the label key:
// keyed off the English text, the colors would have broken the moment the
// label was translated.
const BAND_COLOR = {
  highly_competitive: "#68d391", // strong standing
  competitive: "#63b3ed",        // target
  reach: "#f6ad55",
  high_reach: "#f56565",
};
function bandColor(read) {
  return BAND_COLOR[labelKeyOf(read)] || "#8a8a9a";
}

function confidenceKeyOf(confidence) {
  if (!confidence) return null;
  if (confidence.evidenceConfidenceKey) return String(confidence.evidenceConfidenceKey);
  const level = String(confidence.evidenceConfidence || "").trim().toLowerCase();
  return level ? level.replace(/\s+/g, "_") : null;
}

function confColor(key) {
  if (key === "high") return "#68d391";
  if (key === "medium") return "#f6ad55";
  return "#f56565"; // low / very low
}

function summaryText(admissibility, locale) {
  const key = admissibility?.summaryKey || SUMMARY_KEY_OF[String(admissibility?.summary || "").trim().toLowerCase()];
  return key ? tr(locale, `fit.summary_${key}`, null, admissibility?.summary || "") : (admissibility?.summary || "");
}

function strategyText(positioning, locale) {
  const key = positioning.strategyKey;
  return key ? tr(locale, `fit.strategy_${key}`, null, positioning.recommendedPositioningStrategy || "") : (positioning.recommendedPositioningStrategy || "");
}

// Each flag in the student's language when its code is known, else the
// engine's English sentence for it.
function redFlagTexts(positioning, locale) {
  const english = Array.isArray(positioning.mainRedFlags) ? positioning.mainRedFlags : [];
  const codes = Array.isArray(positioning.mainRedFlagCodes) && positioning.mainRedFlagCodes.length === english.length
    ? positioning.mainRedFlagCodes
    : null;
  return english.map((text, i) => {
    const entry = codes?.[i];
    return entry?.code ? tr(locale, `fit.flag_${entry.code}`, entry.params || {}, text) : text;
  });
}

// The sentence for a verification request that did not answer, by what
// went wrong and whether trying again can help.
export function verificationErrorText(error, locale) {
  const status = Number(error?.status) || 0;
  const code = String(error?.code || "");
  if (status === 401) return t(locale, "fit.verify_error_session");
  if (code === "consent_required" || status === 403) return t(locale, "fit.verify_error_consent");
  if (status === 402) return t(locale, "fit.verify_error_budget");
  if (code === "rate_limited" || status === 429) return t(locale, "fit.verify_error_rate");
  if (status === 0) return t(locale, "fit.verify_error_network");
  return t(locale, "fit.verify_error_generic");
}

// SubBar renders a point estimate and, when `range` is supplied and has real
// width (low-confidence schools), an honest uncertainty band behind the fill
// plus a low–high numeric label instead of a single over-precise number.
// A score the payload does not carry draws an empty bar and a dash, never a
// 0 the read did not compute.
function SubBar({ label, score, color, range }) {
  const known = finiteOrNull(score);
  const pct = known == null ? 0 : Math.max(0, Math.min(100, known));
  const lo = known != null && range ? Math.max(0, Math.min(100, Number(range.low) || 0)) : null;
  const hi = known != null && range ? Math.max(0, Math.min(100, Number(range.high) || 0)) : null;
  const hasBand = lo != null && hi != null && hi - lo >= 1;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
      <div style={{ width: 96, fontSize: 10, color: "#a0aec0", flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.05)", overflow: "hidden", position: "relative" }}>
        {/* uncertainty band (faint) */}
        {hasBand && (
          <div style={{ position: "absolute", left: `${lo}%`, width: `${hi - lo}%`, top: 0, height: "100%", background: color, opacity: 0.22 }} />
        )}
        {/* point estimate fill */}
        <div style={{ position: "absolute", left: 0, width: `${pct}%`, height: "100%", background: color, opacity: hasBand ? 0.5 : 1, borderRadius: 3 }} />
        {/* point marker */}
        {hasBand && (
          <div style={{ position: "absolute", left: `calc(${pct}% - 1px)`, width: 2, top: 0, height: "100%", background: color }} />
        )}
      </div>
      <div style={{ width: hasBand ? 52 : 28, fontSize: 10, color: "#8a8a9a", textAlign: "right", flexShrink: 0 }}>
        {known == null ? "—" : hasBand ? `${Math.round(lo)}–${Math.round(hi)}` : Math.round(pct)}
      </div>
    </div>
  );
}

const CHECK_ICON = { consistent: "✓", differs: "≠", filled: "+", inconclusive: "?", unavailable: "–", info: "ℹ" };
const CHECK_COLOR = { consistent: "#68d391", differs: "#f56565", filled: "#f6ad55", inconclusive: "#f6ad55", unavailable: "#6a6a7a", info: "#8ec5ff" };
const VERDICT_COLOR = { consistent: "#68d391", discrepancies_found: "#f56565", inconclusive: "#f6ad55", unverifiable: "#8a8a9a" };

function isUrl(value) {
  return /^https?:/.test(String(value || ""));
}

// A check's name in the card's language, by its field (fit-verifier.js);
// a deadline by its plan. An unknown field shows the server's English.
function checkLabel(c, locale) {
  if (c.plan || /^deadline_/.test(String(c.field || ""))) {
    const plan = c.plan || String(c.field).replace(/^deadline_/, "");
    return t(locale, "fit.check_deadline", { plan: tr(locale, `fit.plan_${plan}`, null, String(plan).replace(/_/g, " ")) });
  }
  return tr(locale, `fit.check_${c.field}`, null, c.label || c.field);
}

// The test-policy check's values are buckets the card can name; the
// others are numbers, ranges and dates that read the same in any language.
function bucketText(bucket, fallback, locale) {
  return bucket ? tr(locale, `fit.bucket_${bucket}`, null, fallback) : fallback;
}

function checkUsed(c, locale) {
  if (c.used == null) return null;
  return c.field === "test_policy" ? bucketText(c.usedBucket, c.used, locale) : c.used;
}

function checkLive(c, locale) {
  if (c.live == null) return null;
  if (c.field !== "test_policy") return c.live;
  if (c.liveBucket) return bucketText(c.liveBucket, c.live, locale);
  // Two readers that disagree: each with what it read.
  if (Array.isArray(c.readers) && c.readers.length && c.readers.every((r) => r.readerKey && r.bucket)) {
    return c.readers.map((r) => `${tr(locale, `fit.reader_${r.readerKey}`, null, r.reader)}: ${bucketText(r.bucket, r.value, locale)}`).join(" · ");
  }
  return c.live;
}

function liveSourceText(c, locale) {
  if (!c.liveSource || isUrl(c.liveSource)) return null;
  return c.liveSourceKind === "college_scorecard" ? t(locale, "fit.source_scorecard_live") : c.liveSource;
}

const SITE_STATUSES = new Set(["bad_name", "site_unresolved", "robots_disallowed", "no_pages", "not_attempted", "read_failed"]);

// The web double-check: what the fit used vs what the live sources say.
function VerificationPanel({ v, locale }) {
  const color = VERDICT_COLOR[v.verdict] || "#8a8a9a";
  const checks = Array.isArray(v.checks) ? v.checks : [];
  const scored = checks.filter((c) => c.status !== "info");
  const info = checks.filter((c) => c.status === "info");
  const siteStatus = String(v.officialSite?.status || "");
  return (
    <div data-testid="fit-verification" style={{ marginTop: 6, padding: 8, borderRadius: 6, background: "rgba(255,255,255,0.02)", border: `1px solid ${color}33` }}>
      <div style={{ fontSize: 10, fontWeight: 700, color, marginBottom: 4 }}>
        {tr(locale, `fit.verdict_${v.verdict}`, null, t(locale, "fit.verdict_unverifiable"))}
        <span style={{ fontWeight: 400, color: "#6a6a7a", marginLeft: 6 }}>
          {String(v.checkedAt || "").slice(0, 10)}{v.cached ? ` · ${t(locale, "fit.cached_short")}` : ""}
        </span>
      </div>
      {scored.map((c) => {
        const used = checkUsed(c, locale);
        const live = checkLive(c, locale);
        const source = liveSourceText(c, locale);
        return (
          <div key={c.field} style={{ fontSize: 10, color: "#bbb", lineHeight: 1.5, display: "flex", gap: 6 }}>
            <span style={{ color: CHECK_COLOR[c.status] || "#8a8a9a", width: 10, flexShrink: 0 }}>{CHECK_ICON[c.status] || "•"}</span>
            <span>
              <span style={{ color: "#ddd" }}>{checkLabel(c, locale)}:</span>{" "}
              {used != null && <span>{t(locale, "fit.fit_used")} {used}</span>}
              {c.status === "filled" && used == null && <span>{t(locale, "fit.check_filled")}</span>}
              {(used != null || c.status === "filled") && live != null && <span> · </span>}
              {live != null && (
                isUrl(c.liveSource)
                  ? <a href={c.liveSource} target="_blank" rel="noopener noreferrer" style={{ color: "#8ec5ff", textDecoration: "none" }}>{t(locale, "fit.live")} {live} ↗</a>
                  : <span>{t(locale, "fit.live")} {live}{source ? ` (${source})` : ""}</span>
              )}
              {used == null && live == null && <span style={{ color: "#6a6a7a" }}>{t(locale, "fit.check_not_available")}</span>}
              {c.evidence && <div style={{ fontSize: 9, color: "#777", fontStyle: "italic" }}>{"“"}{c.evidence}{"”"}</div>}
            </span>
          </div>
        );
      })}
      {info.length > 0 && (
        <div style={{ fontSize: 9, color: "#8a8a9a", marginTop: 4, lineHeight: 1.5 }}>
          {info.map((c) => (
            <span key={c.field} style={{ marginRight: 8 }}>
              ℹ {checkLabel(c, locale)}: {isUrl(c.liveSource)
                ? <a href={c.liveSource} target="_blank" rel="noopener noreferrer" style={{ color: "#8ec5ff", textDecoration: "none" }}>{c.live}</a>
                : c.live}
            </span>
          ))}
        </div>
      )}
      {v.recomputed && (
        <div data-testid="fit-recomputed" style={{ fontSize: 10, marginTop: 6, color: v.recomputed.labelChanged ? "#f6ad55" : "#9ae6b4" }}>
          {t(locale, "fit.recomputed")}: <strong>{labelText(v.recomputed, locale) || t(locale, "fit.check_not_available")}</strong>
          {" "}{v.recomputed.labelChanged
            ? t(locale, "fit.recomputed_was", { label: labelText(v.original, locale) || "—" })
            : t(locale, "fit.recomputed_unchanged")}
        </div>
      )}
      {v.modelReview && v.modelReview.status && v.modelReview.status !== "ok" && (
        <div style={{ fontSize: 9, color: "#6a6a7a", marginTop: 4 }}>{t(locale, "fit.model_review")}: {t(locale, "fit.model_review_unavailable")}</div>
      )}
      {v.modelReview && v.modelReview.status === "ok" && (v.modelReview.summary || (v.modelReview.notes || []).length > 0) && (
        <div style={{ marginTop: 6, fontSize: 10, color: "#aaa", lineHeight: 1.5 }}>
          <div style={{ fontSize: 9, color: "#6a6a7a", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t(locale, "fit.model_review")}</div>
          {v.modelReview.summary && <div>{v.modelReview.summary}</div>}
          {(v.modelReview.notes || []).map((n, idx) => <div key={idx}>• {n}</div>)}
        </div>
      )}
      {siteStatus && siteStatus !== "read" && (
        <div style={{ fontSize: 9, color: "#6a6a7a", marginTop: 4 }}>
          {t(locale, "fit.site_label")}: {t(locale, SITE_STATUSES.has(siteStatus) ? `fit.site_${siteStatus}` : "fit.site_read_failed")}
        </div>
      )}
    </div>
  );
}

// How the student's own record compares with the enrolled class the
// school's Common Data Set describes — the facts behind the admissibility
// bar: the test that was read (with each section against its band and the
// score-range table), the GPA against the average, band and distribution,
// the class rank against C10, and the AP exam evidence.
const TONE_COLOR = { above: "#68d391", within: "#63b3ed", below: "#f6ad55", unknown: "#8a8a9a", note: "#fbd38d" };

function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (values[key] != null ? String(values[key]) : ""));
}

// The priorities matrix under the card: for each value or declared
// admission factor, what in the student's record speaks to it — a score
// placed against the enrolled class, a course, an activity with the
// qualities its description shows — and, for an essay, recommendations or
// family background, that the profile cannot show it.
const EVIDENCE_TONE = { strong: "#68d391", fair: "#63b3ed", weak: "#f6ad55", info: "#8a8a9a" };

function coverageLabel(coverage, locale) {
  if (coverage.hits > 0) return coverage.hits === 1 ? t(locale, "fit.hits_one") : fill(t(locale, "fit.hits_many"), { n: coverage.hits });
  if (coverage.unreadable) return t(locale, "fit.not_readable");
  if ((coverage.evidence || []).length > 0) return t(locale, "fit.below_range");
  return t(locale, "fit.no_match");
}

function coverageColor(coverage) {
  if (coverage.hits > 0) return "#68d391";
  if (coverage.unreadable) return "#8a8a9a";
  return (coverage.evidence || []).length > 0 ? "#f6ad55" : "#666";
}

// The course load behind the rigor read, in the card's language:
// "6 AP (4 with exam scores), 1 IB, 2 dual enrollment".
function rigorLoad(r, locale) {
  const parts = [];
  if (r.apTaken) parts.push(fill(t(locale, "fit.rigor_ap"), { n: r.apTaken }) + (r.apScored ? ` (${fill(t(locale, "fit.rigor_ap_scored"), { n: r.apScored })})` : ""));
  if (r.ib) parts.push(fill(t(locale, "fit.rigor_ib"), { n: r.ib }));
  if (r.dualEnrollment) parts.push(fill(t(locale, "fit.rigor_dual"), { n: r.dualEnrollment }));
  if (r.aLevel) parts.push(fill(t(locale, "fit.rigor_alevel"), { n: r.aLevel }));
  if (r.honors) parts.push(fill(t(locale, "fit.rigor_honors"), { n: r.honors }));
  return parts.join(", ");
}

function evidenceText(e, locale) {
  const parts = [e.label];
  const d = e.detail || {};
  // The course-load line is placed against the load the admitted average
  // implies, not against a percentile band.
  if (e.kind === "rigor") {
    if (d.expectation != null) parts.push(fill(t(locale, "fit.cmp_rigor_expected"), { n: d.expectation }));
    if (e.position) parts.push(t(locale, `fit.rigor_${e.position}`));
    return parts.join(" · ");
  }
  if (e.position) parts.push(t(locale, `fit.pos_${e.position}`));
  if (d.band) parts.push(`${t(locale, "fit.cmp_band")} ${d.band.low}–${d.band.high}`);
  if (d.average != null) parts.push(`${t(locale, "fit.cmp_average")} ${d.average}${d.weighted ? ` (${t(locale, "fit.cmp_weighted")})` : ""}`);
  if (d.topTenthPct != null) parts.push(fill(t(locale, "fit.cmp_rank_school"), { tenth: d.topTenthPct }));
  if (e.advice === "withhold") parts.push(t(locale, "fit.withhold_short"));
  if (Array.isArray(e.traits) && e.traits.length) parts.push(e.traits.map((trait) => t(locale, `fit.trait_${trait}`)).join(", "));
  return parts.join(" · ");
}

// The test policy the read used, as the card speaks of it. Only a policy
// that was read says "required or considered": an unread one used to come
// through as required, so a student without scores was told tests were
// required at UCLA, which does not consider them (fit-6).
function testPolicyKind(policy) {
  const v = String(policy || "").toLowerCase();
  if (!v || v === "unknown") return "unknown";
  if (/blind|free/.test(v)) return "blind";
  if (/optional|deemphas|de-emphas/.test(v)) return "optional";
  if (/required|considered|flexible/.test(v)) return "required";
  return "unknown";
}

const NO_TEST_KEYS = {
  required: "fit.cmp_no_tests",
  optional: "fit.cmp_no_tests_optional",
  blind: "fit.cmp_no_tests_blind",
  unknown: "fit.cmp_no_tests_unknown",
};

function ProfileComparison({ pc, locale, withLikelihood = true }) {
  const rows = [];
  // The admit rate the read started from. For a regular-round applicant it
  // is the pool outside Early Decision when the school's counts give one,
  // lower than the headline rate wherever ED admits are counted in it. A
  // rate no source held says so rather than leaving the row out.
  const admit = pc.admitRate;
  const admitUsed = finiteOrNull(admit?.used);
  if (admitUsed != null) {
    const pct = (v) => Math.round(v * 1000) / 10;
    const overall = finiteOrNull(admit.overall);
    const ed = finiteOrNull(admit.earlyDecision);
    const value = admit.basis === "outside_early_decision"
      ? [fill(t(locale, "fit.cmp_admit_regular"), { used: pct(admitUsed) }),
        overall != null ? fill(t(locale, "fit.cmp_admit_overall"), { overall: pct(overall) }) : null,
        ed != null ? fill(t(locale, "fit.cmp_admit_ed"), { ed: pct(ed) }) : null].filter(Boolean).join(" · ")
      : fill(t(locale, "fit.cmp_admit_all"), { used: pct(admitUsed) });
    rows.push({ label: t(locale, "fit.cmp_admit"), value, tone: "unknown" });
  } else if (admit) {
    rows.push({ label: t(locale, "fit.cmp_admit"), value: t(locale, "fit.cmp_admit_unavailable"), tone: "unknown" });
    // The likelihood still starts somewhere; the card says from what. A
    // read with no label has no likelihood to start.
    const assumed = withLikelihood ? finiteOrNull(admit.assumedForLikelihood) : null;
    if (assumed != null) rows.push({ value: fill(t(locale, "fit.cmp_admit_assumed"), { pct: Math.round(assumed * 100) }), tone: "note", sub: true });
  }
  const tests = pc.tests;
  // The engine marks a test-blind school beside its optional bucket.
  const policyKind = tests?.blind ? "blind" : testPolicyKind(tests?.policy);
  if (tests?.used) {
    const u = tests.used;
    const band = u.band ? `${u.band.low}–${u.band.high}` : null;
    const shown = u.convertedFrom ? `${u.test.toUpperCase()} ${u.score} (≈ ${u.equivalent})` : `${u.test.toUpperCase()} ${u.score}`;
    rows.push({ label: t(locale, "fit.cmp_tests"), value: band ? `${shown} · ${band} · ${t(locale, `fit.pos_${u.position || "unknown"}`)}` : shown, tone: u.position });
    for (const s of tests.sections || []) {
      if (!s?.band) continue;
      rows.push({ label: s.key ? tr(locale, `fit.section_${s.key}`, null, s.label) : s.label, value: `${s.value} · ${s.band.low}–${s.band.high} · ${t(locale, `fit.pos_${s.position || "unknown"}`)}`, tone: s.position, sub: true });
    }
    if (tests.distribution) rows.push({ value: fill(t(locale, "fit.cmp_distribution"), tests.distribution), tone: "unknown", sub: true });
    if (tests.advice === "withhold") rows.push({ value: t(locale, "fit.advice_withhold"), tone: "note", sub: true });
    else if (tests.advice === "borderline") rows.push({ value: t(locale, "fit.advice_borderline"), tone: "note", sub: true });
    else if (tests.advice === "not_considered" || policyKind === "blind") rows.push({ value: t(locale, "fit.advice_not_considered"), tone: "note", sub: true });
    if (policyKind === "unknown") rows.push({ value: t(locale, "fit.policy_unknown"), tone: "note", sub: true });
  } else if (tests) {
    rows.push({ label: t(locale, "fit.cmp_tests"), value: t(locale, NO_TEST_KEYS[policyKind]), tone: "unknown" });
  }
  const g = pc.gpa;
  if (g && (g.gpa != null || (g.basis === "weighted_only" && g.comparedGpa != null))) {
    const parts = [];
    // A weighted average (above 4.0) is compared with the weighted GPA.
    const weighted = g.averageScale === "weighted";
    if (g.average != null) parts.push(`${t(locale, "fit.cmp_average")} ${g.average}${weighted ? ` (${t(locale, "fit.cmp_weighted")})` : ""}`);
    if (g.band) parts.push(`${t(locale, "fit.cmp_band")} ${g.band.low}–${g.band.high}`);
    // A weighted GPA alone is read as min(weighted, 4.0) against an
    // unweighted class; the row says that is what was compared.
    const weightedOnly = g.gpa == null;
    const weightedValue = g.weightedGpa ?? g.weighted ?? null;
    const shownGpa = weightedOnly
      ? (weightedValue != null
        ? fill(t(locale, "fit.cmp_gpa_weighted_only"), { weighted: weightedValue, compared: g.comparedGpa })
        : fill(t(locale, "fit.cmp_gpa_weighted_only_bare"), { compared: g.comparedGpa }))
      : (weighted && g.comparedGpa != null && g.comparedGpa !== g.gpa ? `${g.gpa} (${t(locale, "fit.cmp_weighted")} ${g.comparedGpa})` : `${g.gpa}`);
    const position = g.position && g.position !== "unknown" ? ` · ${t(locale, `fit.pos_${g.position}`)}` : "";
    rows.push({ label: t(locale, "fit.cmp_gpa"), value: `${shownGpa}${parts.length ? ` · ${parts.join(", ")}` : ""}${position}`, tone: g.position || "unknown" });
    if (g.placement) rows.push({ value: fill(t(locale, "fit.cmp_gpa_placement"), { above: g.placement.shareAbove, band: g.placement.band }), tone: "unknown", sub: true });
    if (weightedOnly) rows.push({ value: t(locale, "fit.gpa_weighted_only_note"), tone: "note", sub: true });
    // An unweighted GPA above 4.0 is on a scale the profile does not name:
    // it was not read as a 4.0-scale GPA, and the card asks for the scale.
    if (g.basis === "scale_unknown" || g.note === "gpa_scale_unknown") rows.push({ value: t(locale, "fit.gpa_scale_unknown_note"), tone: "note", sub: true });
  }
  // The course load behind the rigor component: APs taken (courses, or
  // exams no course names) with how many carry scores, IB, dual enrollment
  // and A-Level, against the load the admitted average implies.
  const cr = pc.rigor;
  if (cr && (cr.apTaken || cr.ib || cr.dualEnrollment || cr.aLevel || cr.honors)) {
    rows.push({ label: t(locale, "fit.cmp_rigor"), value: `${rigorLoad(cr, locale)} · ${fill(t(locale, "fit.cmp_rigor_expected"), { n: cr.expectation })} · ${t(locale, `fit.rigor_${cr.position}`)}`, tone: cr.position });
  }
  const r = pc.classRank;
  if (r && r.topPercent != null) {
    const school = r.school?.topTenthPct != null ? ` · ${fill(t(locale, "fit.cmp_rank_school"), { tenth: r.school.topTenthPct })}` : "";
    const tone = r.shareAbove == null ? "unknown" : r.shareAbove <= 10 ? "above" : r.shareAbove <= 50 ? "within" : "below";
    rows.push({ label: t(locale, "fit.cmp_rank"), value: `${t(locale, "fit.cmp_top")} ${r.topPercent}%${school}`, tone });
  }
  const a = pc.apExams;
  if (a && a.count) {
    const relevant = a.relevant?.length ? ` · ${t(locale, "fit.cmp_ap_relevant")} ${a.relevant.map((x) => `${x.name} ${x.score}`).join(", ")}` : "";
    const average = finiteOrNull(a.average);
    const shownAverage = average != null ? ` · ${t(locale, "fit.cmp_average")} ${average}` : "";
    rows.push({ label: t(locale, "fit.cmp_ap"), value: `${a.count} ${t(locale, "fit.cmp_ap_exams")}${shownAverage}${relevant}`, tone: average == null ? "unknown" : average >= 4 ? "above" : average >= 3 ? "within" : "below" });
  }
  if (!rows.length) return null;
  return (
    <div data-testid="profile-comparison" style={{ marginTop: 8, padding: 8, borderRadius: 6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{ fontSize: 9, color: "#6a6a7a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{t(locale, "fit.compare")}</div>
      {rows.map((row, i) => (
        <div key={i} style={{ fontSize: 10, lineHeight: 1.5, display: "flex", gap: 6, paddingLeft: row.sub ? 10 : 0, color: row.sub ? "#9a9aa8" : "#ccc" }}>
          <span style={{ color: TONE_COLOR[row.tone] || "#8a8a9a", flexShrink: 0 }}>●</span>
          <span>{row.label ? <span style={{ color: "#ddd" }}>{row.label}: </span> : null}{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function CalibratedFitCard({ collegeValues, positioning, loading, isTarget, onAddTarget, targetListFull, verification, verifying, onVerify, schoolName, locale: appLocale }) {
  // The values body when the values read answered; otherwise what went
  // wrong with it. Either way the card can stand on the positioning read.
  const values = collegeValues && !collegeValues.error ? collegeValues : null;
  const valuesError = collegeValues?.error ? collegeValues : null;
  const locale = appLocale || values?.locale || "en-US";
  const hasPositioning = Boolean(positioning && (positioning.overallPositioningLabel || positioning.labelKey));
  const insufficient = hasPositioning ? insufficientRead(positioning) : null;
  const engineName = positioning?.schoolName && positioning.schoolName !== "Unknown school" ? positioning.schoolName : null;
  const title = values?.displayName || engineName || schoolName || "";
  const confidenceKey = hasPositioning ? confidenceKeyOf(positioning.confidence) : null;
  const redFlags = hasPositioning ? redFlagTexts(positioning, locale) : [];
  // The engine's data notes, each said once: three of them already have a
  // row of their own (the insufficient hint, the GPA scale note, the
  // assumed admit rate), so only a note no row covers is shown here, in the
  // card's language when its key is known and as the engine wrote it if not.
  const extraNotes = [];
  if (hasPositioning) {
    const keys = Array.isArray(positioning.dataNoteKeys) ? positioning.dataNoteKeys : [];
    const notes = Array.isArray(positioning.dataNotes) ? positioning.dataNotes : [];
    const pc = positioning.profileComparison || {};
    const covered = {
      add_gpa_or_test: Boolean(insufficient),
      gpa_scale_unknown: Boolean(pc.gpa && (pc.gpa.gpa != null || (pc.gpa.basis === "weighted_only" && pc.gpa.comparedGpa != null))
        && (pc.gpa.basis === "scale_unknown" || pc.gpa.note === "gpa_scale_unknown")),
      admit_rate_assumed: Boolean(!insufficient && pc.admitRate && finiteOrNull(pc.admitRate.used) == null && finiteOrNull(pc.admitRate.assumedForLikelihood) != null),
    };
    if (keys.length === notes.length && keys.length) {
      keys.forEach((key, i) => { if (!covered[key]) extraNotes.push(tr(locale, `fit.note_${key}`, null, notes[i])); });
    }
  }

  return (
    <div data-testid="fit-card" style={{ background: "rgba(104,211,145,0.05)", border: "1px solid rgba(104,211,145,0.15)", borderRadius: 8, padding: 10, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#cfe5d8" }}>{title}</div>
        {loading && <div style={{ fontSize: 10, color: "#8a8a9a" }}>…</div>}
        {!loading && onAddTarget && (
          isTarget
            ? <span style={{ fontSize: 9, color: "#9ce5b6", whiteSpace: "nowrap" }}>{t(locale, "fit.is_target")}</span>
            : targetListFull
              ? <span data-testid="fit-target-full" title={t(locale, "targets.cap_reached", { max: MAX_TARGET_SCHOOLS })} style={{ fontSize: 9, color: "#8a8a9a", whiteSpace: "nowrap" }}>{t(locale, "targets.cap_short", { max: MAX_TARGET_SCHOOLS })}</span>
              : <button onClick={onAddTarget} title={t(locale, "fit.add_target_title")} style={{ fontSize: 9, color: "#c4b5fd", background: "rgba(167,139,250,0.10)", border: "1px solid rgba(167,139,250,0.3)", borderRadius: 6, padding: "2px 6px", cursor: "pointer", whiteSpace: "nowrap" }}>{t(locale, "fit.add_target")}</button>
        )}
      </div>

      {/* ── Calibrated band (preferred) ── */}
      {hasPositioning ? (
        <div style={{ marginBottom: 10 }}>
          {insufficient ? (
            // No label: a neutral badge that says what to add. The engine
            // withholds a label only when a GPA and an SAT/ACT are both
            // missing (studentDataNeeded), which is what the badge names. The bars,
            // the "academically stretched" summary, the red flags and the
            // strategy text all describe a placement the read did not make.
            <>
              <div data-testid="fit-insufficient" style={{
                display: "inline-block", fontSize: 12, fontWeight: 700,
                color: "#cbd5e0", background: "rgba(160,174,192,0.10)", border: "1px solid rgba(160,174,192,0.35)",
                borderRadius: 8, padding: "3px 10px", marginBottom: 6,
              }}>
                {t(locale, insufficient.badge)}
              </div>
              <div style={{ fontSize: 10, color: "#a0aec0", lineHeight: 1.5, marginBottom: 4 }}>{t(locale, insufficient.hint)}</div>
            </>
          ) : (
            <>
              <div data-testid="fit-label" style={{
                display: "inline-block", fontSize: 12, fontWeight: 700,
                color: bandColor(positioning),
                background: `${bandColor(positioning)}1a`,
                border: `1px solid ${bandColor(positioning)}55`,
                borderRadius: 8, padding: "3px 10px", marginBottom: 8,
              }}>
                {labelText(positioning, locale)}
              </div>

              <SubBar label={t(locale, "fit.admissibility")} score={positioning.admissibility?.academicReadinessScore} range={positioning.scoreRanges?.admissibility} color="#63b3ed" />
              <SubBar label={t(locale, "fit.competitiveness")} score={positioning.competitiveness?.majorCompetitivenessScore} range={positioning.scoreRanges?.competitiveness} color="#f6ad55" />
              <SubBar label={t(locale, "fit.fitdim")} score={positioning.fit?.institutionalPriorityFitScore} range={positioning.scoreRanges?.fit} color="#68d391" />
              <SubBar label={t(locale, "fit.confidence_dim")} score={positioning.confidence?.evidenceConfidenceScore} color="#9f7aea" />

              {summaryText(positioning.admissibility, locale) && (
                <div data-testid="fit-summary" style={{ fontSize: 10, color: "#8a8a9a", marginTop: 4, lineHeight: 1.5 }}>
                  {summaryText(positioning.admissibility, locale)}
                </div>
              )}
            </>
          )}

          {positioning.profileComparison && <ProfileComparison pc={positioning.profileComparison} locale={locale} withLikelihood={!insufficient} />}

          {/* Notes the rows above do not already say (a note's own row
              shows the GPA scale and the assumed admit rate). */}
          {extraNotes.length > 0 && (
            <div data-testid="fit-notes" style={{ marginTop: 6 }}>
              {extraNotes.map((note, i) => <div key={i} style={{ fontSize: 10, color: "#fbd38d", lineHeight: 1.5 }}>{note}</div>)}
            </div>
          )}

          {confidenceKey && (
            <div data-testid="fit-confidence" style={{ fontSize: 10, marginTop: 6 }}>
              <span style={{ color: "#6a6a7a" }}>{t(locale, "fit.confidence")}: </span>
              <span style={{ color: confColor(confidenceKey), fontWeight: 600 }}>
                {tr(locale, `fit.conf_${confidenceKey}`, null, positioning.confidence?.evidenceConfidence || confidenceKey)}
              </span>
            </div>
          )}

          {/* ── Data provenance: where these numbers came from ── */}
          {positioning.dataProvenance && (() => {
            const p = positioning.dataProvenance;
            const isCds = p.kind === "cds_store" || p.kind === "cds_live" || p.kind === "cds_web";
            const bits = [];
            if (p.kind === "cds_web") bits.push(t(locale, "fit.source_cds_web"));
            else if (isCds) bits.push(t(locale, p.validated ? "fit.source_cds_validated" : p.verification === "consistent" ? "fit.source_cds_document" : "fit.source_cds_unverified"));
            else if (p.kind === "baseline_only") bits.push(t(locale, "fit.source_baseline"));
            // A Scorecard-sourced read printed no source line at all, and a
            // read with nothing behind it must not claim one (fit-5).
            else if (p.kind === "college_scorecard") bits.push(t(locale, "fit.source_scorecard"));
            else if (p.kind === "none") bits.push(t(locale, "fit.source_none"));
            if (p.yearLabel || p.year) bits.push(String(p.yearLabel || p.year));
            if (finiteOrNull(p.admitRatePercent) != null) bits.push(t(locale, "fit.source_admit", { pct: p.admitRatePercent }));
            // Admit rate specifically pulled from a web search (no CDS/IPEDS).
            if (p.admitRate?.source === "web" && finiteOrNull(p.admitRate.admitRatePercent) != null) {
              bits.push(t(locale, p.admitRate.season ? "fit.source_admit_web_season" : "fit.source_admit_web", { pct: p.admitRate.admitRatePercent, season: p.admitRate.season || "" }));
            }
            // A field the College Scorecard filled where the main source
            // had none: the read names it rather than crediting the CDS.
            const filled = p.kind === "college_scorecard" ? [] : Object.entries(p.fieldSources || {})
              .filter(([, source]) => source === "college_scorecard")
              .map(([field]) => tr(locale, `fit.field_${field}`, null, field.replace(/_/g, " ")));
            // Where the test policy came from, and an unconfirmed one said so.
            const policy = p.testPolicy;
            const policyLine = !policy ? null
              : policy.source === "official_site" ? t(locale, "fit.policy_source_official", { date: String(policy.checkedAt || "").slice(0, 10) || "—" })
                : policy.source === "cds" ? t(locale, "fit.policy_source_cds")
                  : policy.source === "unknown" ? t(locale, "fit.policy_source_unknown") : null;
            if (!bits.length && !filled.length && !policyLine) return null;
            return (
              <div data-testid="fit-source" style={{ fontSize: 9, marginTop: 4, color: "#6a8ab5", lineHeight: 1.5 }}>
                {bits.length > 0 && (
                  <div>
                    <span style={{ color: "#55606e" }}>{t(locale, "fit.source_label")}: </span>
                    {p.sourceUrl
                      ? <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#6a8ab5", textDecoration: "none" }}>↗ {bits.join(" · ")}</a>
                      : <span>{bits.join(" · ")}</span>}
                  </div>
                )}
                {filled.length > 0 && <div>{t(locale, "fit.source_filled_scorecard", { fields: filled.join(", ") })}</div>}
                {policyLine && <div>{policyLine}</div>}
              </div>
            );
          })()}

          {positioning.degraded && (
            <div data-testid="fit-degraded" style={{ fontSize: 9, color: "#f6ad55", marginTop: 4, lineHeight: 1.5 }}>{t(locale, "fit.degraded")}</div>
          )}

          {!insufficient && redFlags.length > 0 && (
            <div data-testid="fit-redflags" style={{ marginTop: 8 }}>
              <div style={{ fontSize: 9, color: "#fc8181", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>
                {t(locale, "fit.redflags")}
              </div>
              {redFlags.slice(0, 3).map((f, i) => (
                <div key={i} style={{ fontSize: 10, color: "#cbb", lineHeight: 1.5 }}>• {f}</div>
              ))}
            </div>
          )}

          {!insufficient && strategyText(positioning, locale) && (
            <div data-testid="fit-strategy" style={{ marginTop: 8, fontSize: 10, color: "#9ae6b4", lineHeight: 1.5 }}>
              <span style={{ color: "#6a6a7a" }}>{t(locale, "fit.strategy")}: </span>
              {strategyText(positioning, locale)}
            </div>
          )}

          {/* ── Web double-check: live Scorecard + the school's own pages ── */}
          {onVerify && (
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => onVerify()}
                disabled={verifying}
                title={t(locale, "fit.verify_title")}
                style={{ fontSize: 10, color: verifying ? "#666" : "#8ec5ff", background: "rgba(142,197,255,0.08)", border: "1px solid rgba(142,197,255,0.25)", borderRadius: 6, padding: "3px 8px", cursor: verifying ? "default" : "pointer" }}
              >{verifying ? t(locale, "fit.verifying") : t(locale, "fit.verify")}</button>
              {verification?.error && <div data-testid="fit-verify-error" style={{ fontSize: 10, color: "#fc8181", marginTop: 4 }}>{verificationErrorText(verification, locale)}</div>}
              {verification && !verification.error && <VerificationPanel v={verification} locale={locale} />}
            </div>
          )}
        </div>
      ) : (
        // ── Fallback: limited data → values coverage only, no fabricated band ──
        !loading && values && (
          <div style={{ fontSize: 10, color: "#fbd38d", marginBottom: 8, lineHeight: 1.5 }}>
            {t(locale, "fit.limited")}
            {finiteOrNull(values.fit?.overall) != null && (
              <span style={{ color: "#68d391", marginLeft: 6 }}>{values.fit.overall}%</span>
            )}
          </div>
        )
      )}

      {/* ── The values part failed: say why, and keep the read above ── */}
      {!values && (
        <div data-testid="fit-matrix-unavailable" style={{ fontSize: 10, lineHeight: 1.5 }}>
          <div style={{ fontSize: 10, color: "#6a6a7a", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {t(locale, "fit.values_heading")} · <span style={{ color: "#fbd38d" }}>{t(locale, "fit.values_unavailable")}</span>
          </div>
          {valuesError && <div style={{ color: "#a0aec0" }}>{valuesErrorText(valuesError, locale)}</div>}
        </div>
      )}

      {values?.sourceUrl && (
        <a href={values.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 9, color: "#6a8ab5", textDecoration: "none", display: "block", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>↗ {values.sourceUrl}</a>
      )}

      {/* ── Core values + per-value coverage (kept from the original view) ── */}
      {values?.note && (
        <div style={{ fontSize: 9, color: "#f6ad55", background: "rgba(246,173,85,0.08)", border: "1px solid rgba(246,173,85,0.2)", borderRadius: 6, padding: "5px 8px", marginBottom: 8, lineHeight: 1.5 }}>
          {values.note}
        </div>
      )}
      {values && <div data-testid="fit-matrix">
        <div style={{ fontSize: 10, color: "#6a6a7a", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{t(locale, values.fallback === "cds_admission_factors" ? "fit.values_heading_cds" : "fit.values_heading")}</div>
        {(values.values || []).map((v) => {
          const coverage = values.fit?.perValueCoverage?.find((p) => p.theme === v.theme);
          return (
            <div key={v.theme} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#ddd" }}>
                {v.theme} {coverage && <span style={{ fontSize: 9, color: coverageColor(coverage), marginLeft: 6 }}>{coverageLabel(coverage, locale)}</span>}
              </div>
              {v.summary && <div style={{ fontSize: 10, color: "#888", marginTop: 2 }}>{v.summary}</div>}
              {v.evidence && <div style={{ fontSize: 9, color: "#666", fontStyle: "italic", marginTop: 3 }}>{"“"}{v.evidence}{"”"}</div>}
              {(coverage?.evidence || []).slice(0, 4).map((e, i) => (
                <div key={i} style={{ fontSize: 9, lineHeight: 1.5, color: "#9a9aa8", display: "flex", gap: 5, marginTop: 1 }}>
                  <span style={{ color: EVIDENCE_TONE[e.tone] || "#8a8a9a", flexShrink: 0 }}>●</span>
                  <span>{evidenceText(e, locale)}</span>
                </div>
              ))}
              {coverage?.reason === "interest" && (
                <div style={{ fontSize: 9, color: "#fbd38d", marginTop: 3, lineHeight: 1.5 }}>{t(locale, "fit.interest_note")}</div>
              )}
            </div>
          );
        })}
      </div>}
      {values?.cached && (
        <div style={{ fontSize: 9, color: "#555", marginTop: 4 }}>
          {Number.isFinite(new Date(values.extractedAt).getTime())
            ? t(locale, "fit.cached_on", { date: new Date(values.extractedAt).toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US") })
            : t(locale, "fit.cached_short")}
        </div>
      )}
      {values?.refreshedAt && (
        <div data-testid="fit-refreshed" style={{ fontSize: 9, color: "#6a8ab5", marginTop: 4 }}>
          {t(locale, "fit.refreshed")} · {new Date(values.refreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
}
