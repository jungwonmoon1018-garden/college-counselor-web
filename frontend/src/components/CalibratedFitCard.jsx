import { t } from "../i18n.js";

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
//                   header, the core-values list, and the fallback.
//   positioning   — a single per-school positioning object (targets[0] from
//                   /api/positioning/targets), or null while loading / when
//                   unavailable.
//   loading       — true while the positioning request is in flight.
//   locale        — the app's locale. It wins over the locale the server
//                   stamped on the values body: that one falls back to the
//                   browser's Accept-Language, which put Korean placement
//                   words on the card of a student using the app in English.
// ═══════════════════════════════════════════════════════════════════════

// Map the positioning label to a reach/target/safety color band. Higher
// position = stronger standing for the student.
function bandColor(label) {
  const l = String(label || "").toLowerCase();
  if (l.includes("highly competitive")) return "#68d391"; // strong standing
  if (l.includes("high reach")) return "#f56565";
  if (l.includes("reach")) return "#f6ad55";
  if (l.includes("competitive")) return "#63b3ed";        // target
  return "#8a8a9a";
}

function confColor(level) {
  const l = String(level || "").toLowerCase();
  if (l === "high") return "#68d391";
  if (l === "medium") return "#f6ad55";
  return "#f56565"; // low / very low
}

// SubBar renders a point estimate and, when `range` is supplied and has real
// width (low-confidence schools), an honest uncertainty band behind the fill
// plus a low–high numeric label instead of a single over-precise number.
function SubBar({ label, score, color, range }) {
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  const lo = range ? Math.max(0, Math.min(100, Number(range.low) || 0)) : null;
  const hi = range ? Math.max(0, Math.min(100, Number(range.high) || 0)) : null;
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
        {hasBand ? `${Math.round(lo)}–${Math.round(hi)}` : Math.round(pct)}
      </div>
    </div>
  );
}

const CHECK_ICON = { consistent: "✓", differs: "≠", inconclusive: "?", unavailable: "–", info: "ℹ" };
const CHECK_COLOR = { consistent: "#68d391", differs: "#f56565", inconclusive: "#f6ad55", unavailable: "#6a6a7a", info: "#8ec5ff" };
const VERDICT_COLOR = { consistent: "#68d391", discrepancies_found: "#f56565", inconclusive: "#f6ad55", unverifiable: "#8a8a9a" };

function isUrl(value) {
  return /^https?:/.test(String(value || ""));
}

// The web double-check: what the fit used vs what the live sources say.
function VerificationPanel({ v, locale }) {
  const color = VERDICT_COLOR[v.verdict] || "#8a8a9a";
  const checks = Array.isArray(v.checks) ? v.checks : [];
  const scored = checks.filter((c) => c.status !== "info");
  const info = checks.filter((c) => c.status === "info");
  return (
    <div style={{ marginTop: 6, padding: 8, borderRadius: 6, background: "rgba(255,255,255,0.02)", border: `1px solid ${color}33` }}>
      <div style={{ fontSize: 10, fontWeight: 700, color, marginBottom: 4 }}>
        {t(locale, `fit.verdict_${v.verdict}`)}
        <span style={{ fontWeight: 400, color: "#6a6a7a", marginLeft: 6 }}>
          {String(v.checkedAt || "").slice(0, 10)}{v.cached ? " · cached" : ""}
        </span>
      </div>
      {scored.map((c) => (
        <div key={c.field} style={{ fontSize: 10, color: "#bbb", lineHeight: 1.5, display: "flex", gap: 6 }}>
          <span style={{ color: CHECK_COLOR[c.status] || "#8a8a9a", width: 10, flexShrink: 0 }}>{CHECK_ICON[c.status] || "•"}</span>
          <span>
            <span style={{ color: "#ddd" }}>{c.label}:</span>{" "}
            {c.used != null && <span>{t(locale, "fit.fit_used")} {c.used}</span>}
            {c.used != null && c.live != null && <span> · </span>}
            {c.live != null && (
              isUrl(c.liveSource)
                ? <a href={c.liveSource} target="_blank" rel="noopener noreferrer" style={{ color: "#8ec5ff", textDecoration: "none" }}>{t(locale, "fit.live")} {c.live} ↗</a>
                : <span>{t(locale, "fit.live")} {c.live}{c.liveSource ? ` (${c.liveSource})` : ""}</span>
            )}
            {c.used == null && c.live == null && <span style={{ color: "#6a6a7a" }}>not available</span>}
            {c.evidence && <div style={{ fontSize: 9, color: "#777", fontStyle: "italic" }}>{"“"}{c.evidence}{"”"}</div>}
          </span>
        </div>
      ))}
      {info.length > 0 && (
        <div style={{ fontSize: 9, color: "#8a8a9a", marginTop: 4, lineHeight: 1.5 }}>
          {info.map((c) => (
            <span key={c.field} style={{ marginRight: 8 }}>
              ℹ {c.label}: {isUrl(c.liveSource)
                ? <a href={c.liveSource} target="_blank" rel="noopener noreferrer" style={{ color: "#8ec5ff", textDecoration: "none" }}>{c.live}</a>
                : c.live}
            </span>
          ))}
        </div>
      )}
      {v.recomputed && (
        <div style={{ fontSize: 10, marginTop: 6, color: v.recomputed.labelChanged ? "#f6ad55" : "#9ae6b4" }}>
          {t(locale, "fit.recomputed")}: <strong>{v.recomputed.overallPositioningLabel}</strong>
          {v.recomputed.labelChanged ? ` (was ${v.original?.overallPositioningLabel})` : " (label unchanged)"}
        </div>
      )}
      {v.modelReview && v.modelReview.status && v.modelReview.status !== "ok" && (
        <div style={{ fontSize: 9, color: "#6a6a7a", marginTop: 4 }}>{t(locale, "fit.model_review")}: unavailable this time</div>
      )}
      {v.modelReview && v.modelReview.status === "ok" && (v.modelReview.summary || (v.modelReview.notes || []).length > 0) && (
        <div style={{ marginTop: 6, fontSize: 10, color: "#aaa", lineHeight: 1.5 }}>
          <div style={{ fontSize: 9, color: "#6a6a7a", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t(locale, "fit.model_review")}</div>
          {v.modelReview.summary && <div>{v.modelReview.summary}</div>}
          {(v.modelReview.notes || []).map((n, idx) => <div key={idx}>• {n}</div>)}
        </div>
      )}
      {v.officialSite?.status && v.officialSite.status !== "read" && (
        <div style={{ fontSize: 9, color: "#6a6a7a", marginTop: 4 }}>Official site: {String(v.officialSite.status).replace(/_/g, " ")}</div>
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

function ProfileComparison({ pc, locale }) {
  const rows = [];
  const tests = pc.tests;
  if (tests?.used) {
    const u = tests.used;
    const band = u.band ? `${u.band.low}–${u.band.high}` : null;
    const shown = u.convertedFrom ? `${u.test.toUpperCase()} ${u.score} (≈ ${u.equivalent})` : `${u.test.toUpperCase()} ${u.score}`;
    rows.push({ label: t(locale, "fit.cmp_tests"), value: band ? `${shown} · ${band} · ${t(locale, `fit.pos_${u.position}`)}` : shown, tone: u.position });
    for (const s of tests.sections || []) {
      rows.push({ label: s.label, value: `${s.value} · ${s.band.low}–${s.band.high} · ${t(locale, `fit.pos_${s.position}`)}`, tone: s.position, sub: true });
    }
    if (tests.distribution) rows.push({ value: fill(t(locale, "fit.cmp_distribution"), tests.distribution), tone: "unknown", sub: true });
    if (tests.advice === "withhold") rows.push({ value: t(locale, "fit.advice_withhold"), tone: "note", sub: true });
    else if (tests.advice === "borderline") rows.push({ value: t(locale, "fit.advice_borderline"), tone: "note", sub: true });
  } else if (tests) {
    rows.push({ label: t(locale, "fit.cmp_tests"), value: t(locale, tests.policy === "test_optional_or_deemphasized" ? "fit.cmp_no_tests_optional" : "fit.cmp_no_tests"), tone: "unknown" });
  }
  const g = pc.gpa;
  if (g && g.gpa != null) {
    const parts = [];
    // A weighted average (above 4.0) is compared with the weighted GPA.
    const weighted = g.averageScale === "weighted";
    if (g.average != null) parts.push(`${t(locale, "fit.cmp_average")} ${g.average}${weighted ? ` (${t(locale, "fit.cmp_weighted")})` : ""}`);
    if (g.band) parts.push(`${t(locale, "fit.cmp_band")} ${g.band.low}–${g.band.high}`);
    const shownGpa = weighted && g.comparedGpa != null && g.comparedGpa !== g.gpa ? `${g.gpa} (${t(locale, "fit.cmp_weighted")} ${g.comparedGpa})` : `${g.gpa}`;
    rows.push({ label: t(locale, "fit.cmp_gpa"), value: `${shownGpa}${parts.length ? ` · ${parts.join(", ")}` : ""}${g.position !== "unknown" ? ` · ${t(locale, `fit.pos_${g.position}`)}` : ""}`, tone: g.position });
    if (g.placement) rows.push({ value: fill(t(locale, "fit.cmp_gpa_placement"), { above: g.placement.shareAbove, band: g.placement.band }), tone: "unknown", sub: true });
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
    rows.push({ label: t(locale, "fit.cmp_ap"), value: `${a.count} ${t(locale, "fit.cmp_ap_exams")} · ${t(locale, "fit.cmp_average")} ${a.average}${relevant}`, tone: a.average >= 4 ? "above" : a.average >= 3 ? "within" : "below" });
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

export default function CalibratedFitCard({ collegeValues, positioning, loading, isTarget, onAddTarget, verification, verifying, onVerify, locale: appLocale }) {
  const locale = appLocale || collegeValues?.locale || "en-US";
  const hasPositioning = positioning && positioning.overallPositioningLabel;

  return (
    <div style={{ background: "rgba(104,211,145,0.05)", border: "1px solid rgba(104,211,145,0.15)", borderRadius: 8, padding: 10, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#cfe5d8" }}>{collegeValues.displayName}</div>
        {loading && <div style={{ fontSize: 10, color: "#8a8a9a" }}>…</div>}
        {!loading && onAddTarget && (
          isTarget
            ? <span style={{ fontSize: 9, color: "#9ce5b6", whiteSpace: "nowrap" }}>🎯 target</span>
            : <button onClick={onAddTarget} title="Add to your target schools" style={{ fontSize: 9, color: "#c4b5fd", background: "rgba(167,139,250,0.10)", border: "1px solid rgba(167,139,250,0.3)", borderRadius: 6, padding: "2px 6px", cursor: "pointer", whiteSpace: "nowrap" }}>➕ target</button>
        )}
      </div>

      {/* ── Calibrated band (preferred) ── */}
      {hasPositioning ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{
            display: "inline-block", fontSize: 12, fontWeight: 700,
            color: bandColor(positioning.overallPositioningLabel),
            background: `${bandColor(positioning.overallPositioningLabel)}1a`,
            border: `1px solid ${bandColor(positioning.overallPositioningLabel)}55`,
            borderRadius: 8, padding: "3px 10px", marginBottom: 8,
          }}>
            {positioning.overallPositioningLabel}
          </div>

          <SubBar label={t(locale, "fit.admissibility")} score={positioning.admissibility?.academicReadinessScore} range={positioning.scoreRanges?.admissibility} color="#63b3ed" />
          <SubBar label={t(locale, "fit.competitiveness")} score={positioning.competitiveness?.majorCompetitivenessScore} range={positioning.scoreRanges?.competitiveness} color="#f6ad55" />
          <SubBar label={t(locale, "fit.fitdim")} score={positioning.fit?.institutionalPriorityFitScore} range={positioning.scoreRanges?.fit} color="#68d391" />
          <SubBar label={t(locale, "fit.confidence_dim")} score={positioning.confidence?.evidenceConfidenceScore} color="#9f7aea" />

          {positioning.admissibility?.summary && (
            <div style={{ fontSize: 10, color: "#8a8a9a", marginTop: 4, lineHeight: 1.5 }}>
              {positioning.admissibility.summary}
            </div>
          )}

          {positioning.profileComparison && <ProfileComparison pc={positioning.profileComparison} locale={locale} />}

          {positioning.confidence?.evidenceConfidence && (
            <div style={{ fontSize: 10, marginTop: 6 }}>
              <span style={{ color: "#6a6a7a" }}>{t(locale, "fit.confidence")}: </span>
              <span style={{ color: confColor(positioning.confidence.evidenceConfidence), fontWeight: 600 }}>
                {positioning.confidence.evidenceConfidence}
              </span>
            </div>
          )}

          {/* ── Data provenance: where these numbers came from ── */}
          {positioning.dataProvenance && (() => {
            const p = positioning.dataProvenance;
            const isCds = p.kind === "cds_store" || p.kind === "cds_live" || p.kind === "cds_web";
            const bits = [];
            if (p.kind === "cds_web") bits.push("CDS · AI web-read");
            else if (isCds) bits.push(p.validated ? "CDS · validated" : "CDS · unverified");
            else if (p.kind === "baseline_only") bits.push("IPEDS baseline");
            if (p.yearLabel || p.year) bits.push(String(p.yearLabel || p.year));
            if (p.admitRatePercent != null) bits.push(`admit ${p.admitRatePercent}%`);
            // Admit rate specifically pulled from a web search (no CDS/IPEDS).
            if (p.admitRate?.source === "web" && p.admitRate.admitRatePercent != null) {
              bits.push(`admit ${p.admitRate.admitRatePercent}% (web${p.admitRate.season ? ` · ${p.admitRate.season}` : ""})`);
            }
            if (!bits.length) return null;
            return (
              <div style={{ fontSize: 9, marginTop: 4, color: "#6a8ab5" }}>
                <span style={{ color: "#55606e" }}>Source: </span>
                {p.sourceUrl
                  ? <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#6a8ab5", textDecoration: "none" }}>↗ {bits.join(" · ")}</a>
                  : <span>{bits.join(" · ")}</span>}
              </div>
            );
          })()}

          {Array.isArray(positioning.mainRedFlags) && positioning.mainRedFlags.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 9, color: "#fc8181", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>
                {t(locale, "fit.redflags")}
              </div>
              {positioning.mainRedFlags.slice(0, 3).map((f, i) => (
                <div key={i} style={{ fontSize: 10, color: "#cbb", lineHeight: 1.5 }}>• {f}</div>
              ))}
            </div>
          )}

          {positioning.recommendedPositioningStrategy && (
            <div style={{ marginTop: 8, fontSize: 10, color: "#9ae6b4", lineHeight: 1.5 }}>
              <span style={{ color: "#6a6a7a" }}>{t(locale, "fit.strategy")}: </span>
              {positioning.recommendedPositioningStrategy}
            </div>
          )}

          {/* ── Web double-check: live Scorecard + the school's own pages ── */}
          {onVerify && (
            <div style={{ marginTop: 8 }}>
              <button
                onClick={() => onVerify()}
                disabled={verifying}
                title="Re-check the numbers and policy behind this read against College Scorecard and the school's own admissions pages"
                style={{ fontSize: 10, color: verifying ? "#666" : "#8ec5ff", background: "rgba(142,197,255,0.08)", border: "1px solid rgba(142,197,255,0.25)", borderRadius: 6, padding: "3px 8px", cursor: verifying ? "default" : "pointer" }}
              >{verifying ? t(locale, "fit.verifying") : t(locale, "fit.verify")}</button>
              {verification?.error && <div style={{ fontSize: 10, color: "#fc8181", marginTop: 4 }}>{verification.error}</div>}
              {verification && !verification.error && <VerificationPanel v={verification} locale={locale} />}
            </div>
          )}
        </div>
      ) : (
        // ── Fallback: limited data → values coverage only, no fabricated band ──
        !loading && (
          <div style={{ fontSize: 10, color: "#fbd38d", marginBottom: 8, lineHeight: 1.5 }}>
            {t(locale, "fit.limited")}
            {collegeValues.fit && (
              <span style={{ color: "#68d391", marginLeft: 6 }}>{collegeValues.fit.overall}%</span>
            )}
          </div>
        )
      )}

      {collegeValues.sourceUrl && (
        <a href={collegeValues.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 9, color: "#6a8ab5", textDecoration: "none", display: "block", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>↗ {collegeValues.sourceUrl}</a>
      )}

      {/* ── Core values + per-value coverage (kept from the original view) ── */}
      {collegeValues.note && (
        <div style={{ fontSize: 9, color: "#f6ad55", background: "rgba(246,173,85,0.08)", border: "1px solid rgba(246,173,85,0.2)", borderRadius: 6, padding: "5px 8px", marginBottom: 8, lineHeight: 1.5 }}>
          {collegeValues.note}
        </div>
      )}
      <div data-testid="fit-matrix">
        <div style={{ fontSize: 10, color: "#6a6a7a", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{collegeValues.fallback === "cds_admission_factors" ? "Admission priorities (CDS)" : "Core values"}</div>
        {(collegeValues.values || []).map((v) => {
          const coverage = collegeValues.fit?.perValueCoverage?.find((p) => p.theme === v.theme);
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
      </div>
      {collegeValues.cached && <div style={{ fontSize: 9, color: "#555", marginTop: 4 }}>Cached {new Date(collegeValues.extractedAt).toLocaleDateString()}</div>}
      {collegeValues.refreshedAt && (
        <div data-testid="fit-refreshed" style={{ fontSize: 9, color: "#6a8ab5", marginTop: 4 }}>
          {t(locale, "fit.refreshed")} · {new Date(collegeValues.refreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
}
