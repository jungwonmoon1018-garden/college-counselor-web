// school-handlers.js — target-school handlers: deadline creation, the college
// lookup, removing a target and convening the Strategy Council. App() keeps each hook and its dependency array and calls these with the
// render's bindings as `ctx`. Moved out of App.jsx on 2026-09-20.
import { resolveTargetUnitId } from "./profile-analysis.js";
import { clientTypicalISO } from "./chat-orchestrator.js";
import { fitProfileFingerprint } from "./fit-refresh.js";
import { createCouncilPayload, formatCouncilResult, councilErrorMessage } from "./strategy-council.js";

// When a school is added to the target list, create its key deadlines in
// the Deadlines tab: Early (EA/ED), Regular Decision, Financial aid, and
// Commit-by. Dates come from the per-school web lookup when available, else
// the typical-cycle ISO fallbacks — so every added school gets dated
// deadlines. Skips rounds with no parseable date and de-dupes by title.
export async function createDeadlinesForSchool(ctx, school) {
  const {
    authedFetch,
  } = ctx;
  const name = String(school || "").trim();
  if (!name) return;
  const unitId = resolveTargetUnitId(name);
  // Try the calendar/web lookup (advanced model researches real dates), but
  // never block deadline creation on it — fall back to client typical dates
  // so deadlines are added even if the web call is rate-limited/unavailable.
  let iso = clientTypicalISO();
  let sd = {};       // per-school dates: read from the school's pages, or its Common Data Set
  let srcUrl = null; // source URL when read from the school's pages
  let cdsLabel = null; // set when the dates come from the school's Common Data Set (previous cycle, rolled forward)
  try {
    const r = await authedFetch("/api/calendar/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // research: true → the backend reads this school's own admissions
      // pages (scout snapshot, on-demand read, then model research) so the
      // created deadlines carry the school's actual dates; failing that,
      // the closing dates its Common Data Set reported; only then the
      // typical-cycle fallbacks.
      body: JSON.stringify({ targetSchools: [name], research: true }),
    });
    if (r.ok) {
      const body = await r.json();
      if (body?.calendar?.typicalISO) iso = body.calendar.typicalISO;
      const entry = (body?.schools || []).find(s => String(s.school).toLowerCase() === name.toLowerCase());
      sd = entry?.deadlines || {};
      if (entry?.source === "cds") cdsLabel = entry.sourceLabel || "its Common Data Set";
      else if (entry?.source && entry.source !== "typical") srcUrl = entry.source;
    }
  } catch (err) { console.warn("[DEADLINES] calendar lookup failed, using typical dates:", err?.message); }

  const toISO = (...cands) => {
    for (const c of cands) {
      if (!c) continue;
      const ts = Date.parse(c);
      if (Number.isFinite(ts)) return new Date(ts).toISOString();
    }
    return null;
  };
  // Two kinds of entry, never confused: a date read from the school's own
  // pages is the school's deadline and says where it came from; a date
  // from the typical-cycle table is an approximate planning window and is
  // labeled as such in the title itself, so a reminder can never present
  // "January 1" as a school's deadline (Johns Hopkins lists January 2 and
  // January 15; the generic fallbacks said January 1 and February 1).
  const webNote = srcUrl
    ? `${name}'s published date, read from ${srcUrl}. Re-check the page before you rely on it.`
    : `${name}'s published date for the current cycle. Re-check ${name}'s official site before you rely on it.`;
  const typicalNote = `Approximate planning window from typical US cycle dates — NOT ${name}'s verified deadline. Look up the exact date on ${name}'s official admissions or financial-aid page and edit this entry.`;
  const cdsNote = `Closing date ${name} reported in ${cdsLabel} for its previous cycle, rolled forward to this cycle. Institutional, but confirm this year's date on ${name}'s admissions page.`;
  const mk = (round, schoolVal, typicalVal, category) => {
    const fromSchool = Boolean(schoolVal && Number.isFinite(Date.parse(schoolVal)));
    const date = toISO(schoolVal, typicalVal);
    if (!date) return null;
    const title = fromSchool
      ? (cdsLabel ? `${name} — ${round} (from Common Data Set — confirm)` : `${name} — ${round}`)
      : `${name} — ${round} (approximate — verify)`;
    return {
      title,
      dueAt: date,
      category,
      notes: fromSchool ? (cdsLabel ? cdsNote : webNote) : typicalNote,
      ...(unitId ? { collegeIds: [unitId] } : {}),
    };
  };
  // Early Decision II has no typical-cycle stand-in: it exists only when
  // the school's pages or its Common Data Set state a second round.
  const items = [
    mk("Early (EA/ED)", sd.ea || sd.ed, iso.earlyEaEd, "admissions"),
    mk("Early Decision II", sd.edII, null, "admissions"),
    mk("Regular Decision", sd.rd, iso.regularDecision, "admissions"),
    mk("Financial aid", sd.financialAid, iso.financialAidPriority, "financial_aid"),
    mk("Commit by", sd.commitBy, iso.nationalDepositDeadline, "admissions"),
  ].filter(Boolean);
  if (!items.length) return;
  // ONE bulk request (server de-dupes by title) — avoids the multi-POST
  // burst that was tripping the rate limiter (HTTP 429).
  try {
    await authedFetch("/api/students/deadlines/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
  } catch (err) { console.warn("[DEADLINES] bulk create failed:", err?.message); }
}

// ─── College values + fit ───
// Look up a college's published core values and compute how the
// student's profile maps onto them. Both calls carry the app's locale:
// without the header the server localized from the browser's
// Accept-Language, and a Korean-locale browser showing the app in
// English got Korean placement words on the fit card.
// `refresh` re-reads the school already shown after the profile changed:
// the old card stays up until the new read lands, a failed re-read keeps
// it, and the body is stamped so the card can say it was re-read.
export async function lookupCollege(ctx, collegeName, hintUrl, { refresh = false } = {}) {
  const {
    data, fitFingerprintRef, locale, setCollegePositioning, setCollegePositioningLoading, setCollegeValues,
    setCollegeValuesLoading, setCollegeVerification,
  } = ctx;
  const token = window.__CC_SESSION_TOKEN__;
  if (!token || !collegeName) return;
  fitFingerprintRef.current = fitProfileFingerprint(data);
  setCollegeValuesLoading(true);
  if (!refresh) setCollegePositioning(null);
  setCollegeVerification(null);
  try {
    const r = await fetch("/api/colleges/values", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-CollegeApp-Locale": locale },
      body: JSON.stringify({ collegeName, hintUrl }),
    });
    const body = await r.json();
    if (r.ok) setCollegeValues(refresh ? { ...body, refreshedAt: new Date().toISOString() } : body);
    else if (!refresh) setCollegeValues({ error: body.error || `HTTP ${r.status}` });
  } catch (err) {
    if (!refresh) setCollegeValues({ error: err.message || "lookup failed" });
  } finally {
    setCollegeValuesLoading(false);
  }

  // Calibrated fit (reach/target/safety) — separate, non-blocking call.
  // Positioning depends on CDS resolution which can miss for obscure
  // schools; CalibratedFitCard falls back to values-coverage when absent.
  setCollegePositioningLoading(true);
  try {
    const major = (data?.majorInterest || data?.profile?.majorInterest || null);
    const pr = await fetch("/api/positioning/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-CollegeApp-Locale": locale },
      body: JSON.stringify({ targets: [{ schoolName: collegeName }], ...(major ? { major } : {}) }),
    });
    const pbody = await pr.json().catch(() => ({}));
    if (pr.ok && Array.isArray(pbody.targets) && pbody.targets.length > 0) {
      setCollegePositioning(pbody.targets[0]);
    } else if (!refresh) {
      setCollegePositioning(null);
    }
  } catch {
    if (!refresh) setCollegePositioning(null);
  } finally {
    setCollegePositioningLoading(false);
  }
}

export function removeTargetSchool(ctx, name) {
  const {
    authedFetchRef, saveTargets, setDeadlineRefreshKey, setTargetSchools, user,
  } = ctx;
  setTargetSchools((prev) => {
    const next = prev.filter((s) => s !== name);
    saveTargets(next, user?.email);
    return next;
  });
  // Cascade: delete everything about this school from the schedule/Deadline
  // tabs (its auto-created EA/ED/RD/aid/commit rows + anything naming it).
  // Use the re-authenticating request path so a stale desktop session does
  // not silently leave orphaned deadlines behind.
  const request = authedFetchRef.current;
  if (request && name) {
    const unitId = resolveTargetUnitId(name);
    request("/api/students/deadlines/by-school", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schoolName: name, ...(unitId ? { unitId } : {}) }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setDeadlineRefreshKey((k) => k + 1);
      })
      .catch((err) => console.warn("[targets] deadline cascade failed:", err?.message));
  }
}

// ─── Round 1-5 frontend wiring ───
// (`locale` is declared above the college-fit lookups, which send it.)
export async function conveneStrategyCouncil(ctx, question, decisionType, signal) {
  const {
    authedFetch, locale, setAgentStatus,
  } = ctx;
  const payload = createCouncilPayload(question, decisionType);
  setAgentStatus({
    active: "strategy_council",
    phase: locale === "ko"
      ? "전략 위원회가 결정을 검토하고 있습니다..."
      : "Strategy Council is reviewing your decision...",
  });
  const response = await authedFetch("/api/council/convene", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": locale,
      "X-CollegeApp-Locale": locale,
    },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(councilErrorMessage(response.status, body, locale));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  const formatted = formatCouncilResult(body, locale);
  return formatted;
}
