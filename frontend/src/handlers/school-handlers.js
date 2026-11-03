// school-handlers.js — target-school handlers: deadline creation, the college
// lookup, removing a target and convening the Strategy Council. App() keeps each hook and its dependency array and calls these with the
// render's bindings as `ctx`. Moved out of App.jsx on 2026-09-20.
import { resolveTargetUnitId } from "../profile/profile-analysis.js";
import { clientTypicalISO, cycleLabel, cycleStartYearOf, planningCycleStartYear, shiftDateToCycle, typicalDeadlineDates } from "../profile/admissions-cycle.js";
import { calendarDateOf, daysUntilDue } from "../profile/dates.js";
import { fitProfileFingerprint } from "../profile/fit-refresh.js";
import { createCouncilPayload, formatCouncilResult, councilErrorMessage } from "../profile/strategy-council.js";
import { targetListHas } from "../profile/target-schools.js";

// When a school is added to the target list, create its key deadlines in
// the Deadlines tab: Early (EA/ED), Regular Decision, Financial aid, and
// Commit-by. Dates come from the per-school web lookup when available, else
// the typical-cycle fallbacks — so every added school gets dated
// deadlines. Skips rounds with no parseable date.
// `targetSchools` is the list the school was just added to. A school that
// is not on it gets no deadlines: a ninth school used to be cut from a full
// list while its four or five deadlines (and the model-backed calendar read
// behind them) were still created, and the only cascade that removes them
// is removing the school from the list, which the student could not do.
// Called without the list, the creator runs as it always has.
//
// The reminders are for the student's own application cycle (the server's
// `studentCycle`, from their class year), not the senior cycle the calendar
// outlines: a sophomore who added Harvard on Nov 3 got this year's Early
// date, overdue the day it was made, and RD for an application she files
// two years later. A school's published date for an earlier cycle is
// carried to hers on the same month and day and labeled approximate, a
// round whose date has already passed is skipped, and the student is told
// what was added and what was not (ctx.notify, when the caller passes one;
// the result is returned either way).
export async function createDeadlinesForSchool(ctx, school, { targetSchools, now = new Date() } = {}) {
  const {
    authedFetch, locale = "en-US", notify,
  } = ctx;
  const name = String(school || "").trim();
  if (!name) return null;
  if (Array.isArray(targetSchools) && !targetListHas(targetSchools, name)) return null;
  const unitId = resolveTargetUnitId(name);
  // Try the calendar/web lookup (advanced model researches real dates), but
  // never block deadline creation on it — fall back to client typical dates
  // so deadlines are added even if the web call is rate-limited/unavailable.
  const planningStart = planningCycleStartYear(now);
  let ownStart = planningStart; // the student's cycle; the planning cycle until the server says
  let iso = clientTypicalISO(now);
  let sd = {};       // per-school dates: read from the school's pages, or its Common Data Set
  let schoolStart = null; // the cycle those dates are for
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
      const own = body?.studentCycle;
      if (Number.isInteger(own?.startYear)) {
        ownStart = own.startYear;
        iso = own.typicalISO || typicalDeadlineDates(ownStart);
      } else if (body?.calendar?.typicalISO) {
        iso = body.calendar.typicalISO;
      }
      const entry = (body?.schools || []).find(s => String(s.school).toLowerCase() === name.toLowerCase());
      sd = entry?.deadlines || {};
      schoolStart = cycleStartYearOf(entry?.cycle) ?? planningStart;
      if (entry?.source === "cds") cdsLabel = entry.sourceLabel || "its Common Data Set";
      else if (entry?.source && entry.source !== "typical") srcUrl = entry.source;
    }
  } catch (err) { console.warn("[DEADLINES] calendar lookup failed, using typical dates:", err?.message); }

  const entryYear = ownStart + 1;
  // Typical dates for a cycle after the planning one are a projection too.
  const projectedTypical = ownStart > planningStart;
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
  const carriedNote = `${name}'s ${schoolStart != null ? cycleLabel(schoolStart) : "current"} date carried forward to your cycle (applying in fall ${ownStart} for Fall ${entryYear} entry). ${name} has not published that cycle's dates yet; check its admissions page when it does and edit this entry.`;
  const approxTitle = (round) => `${name} — ${round} (approximate — for Fall ${entryYear} entry)`;
  const past = [];
  const mk = (round, schoolVal, typicalVal, category) => {
    // The school's date when it is for this student's cycle, or carried
    // forward to it from an earlier one; a later cycle's date is not hers.
    let date = null;
    let kind = "typical";
    const schoolDate = calendarDateOf(schoolVal);
    if (schoolDate && schoolStart != null && schoolStart <= ownStart) {
      date = schoolStart === ownStart ? schoolDate : shiftDateToCycle(schoolDate, schoolStart, ownStart);
      kind = schoolStart === ownStart ? "school" : "carried";
    }
    if (!date) date = calendarDateOf(typicalVal);
    if (!date) return null;
    // A round already over for this cycle gets no reminder (and no typical
    // stand-in either: the real date has passed).
    if (daysUntilDue(date, now) < 0) { past.push(round); return null; }
    let title;
    let notes;
    if (kind === "school") {
      title = cdsLabel ? `${name} — ${round} (from Common Data Set — confirm)` : `${name} — ${round}`;
      notes = cdsLabel ? cdsNote : webNote;
    } else if (kind === "carried") {
      title = approxTitle(round);
      notes = carriedNote;
    } else {
      title = projectedTypical ? approxTitle(round) : `${name} — ${round} (approximate — verify)`;
      notes = typicalNote;
    }
    return {
      title,
      dueAt: date, // the calendar date itself (profile/dates.js)
      category,
      notes,
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
  const result = { school: name, cycleEntryYear: entryYear, created: 0, past, duplicates: 0, message: "" };
  if (items.length) {
    // ONE bulk request (the server de-dupes by title within a cycle and
    // skips what is already past) — avoids the multi-POST burst that was
    // tripping the rate limiter (HTTP 429).
    try {
      const r = await authedFetch("/api/students/deadlines/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const body = r?.ok && typeof r.json === "function" ? await r.json().catch(() => null) : null;
      if (body) {
        result.created = Number(body.createdCount ?? body.created?.length ?? 0) || 0;
        for (const skipped of Array.isArray(body.skippedItems) ? body.skippedItems : []) {
          if (skipped?.reason === "duplicate") result.duplicates += 1;
          else if (skipped?.reason === "past") past.push(String(skipped.title || "").replace(`${name} — `, ""));
        }
      }
    } catch (err) { console.warn("[DEADLINES] bulk create failed:", err?.message); }
  }
  result.message = deadlineCreationMessage(result, locale);
  if (result.message && typeof notify === "function") notify(result.message);
  return result;
}

// What the student is told after a school's reminders are made: how many
// were added, which rounds were skipped because their date had passed, and
// how many were already on the list. Nothing to tell, nothing said.
export function deadlineCreationMessage({ school, created = 0, past = [], duplicates = 0, cycleEntryYear }, locale = "en-US") {
  if (!created && !past.length && !duplicates) return "";
  const ko = String(locale || "").toLowerCase().startsWith("ko");
  const parts = [];
  if (ko) {
    if (created) parts.push(`${school}: Fall ${cycleEntryYear} 입학 기준 마감일 ${created}개를 마감일 목록에 추가했어요.`);
    if (past.length) parts.push(`${past.join(", ")} 마감일은 이미 지나서 추가하지 않았어요.`);
    if (duplicates) parts.push(`${duplicates}개는 이미 목록에 있어요.`);
    return created ? parts.join(" ") : `${school}: ${parts.join(" ")}`;
  }
  if (created) parts.push(`${school}: added ${created} deadline${created === 1 ? "" : "s"} for Fall ${cycleEntryYear} entry to your Deadlines list.`);
  if (past.length) parts.push(`Skipped ${past.join(", ")}: that date has already passed.`);
  if (duplicates) parts.push(`${duplicates} ${duplicates === 1 ? "was" : "were"} already on your list.`);
  return created ? parts.join(" ") : `${school}: ${parts.join(" ")}`;
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
//
// Only the newest lookup may paint the card. Both calls take seconds (the
// values read is a model call over the school's pages, and positioning can
// wait on a live Common Data Set read), the Look up button re-enables as
// soon as the values land, and the target chips and Enter key start a
// lookup with no loading check at all. A student who opened Harvard and then
// Ohio State saw Harvard's late "High reach" land under Ohio State's values,
// and the double-check then verified a different school from the one whose
// label was shown (fit-11). `lookupStateRef` (useCollegeFit) carries a
// sequence number: each lookup takes the next one and aborts the one before,
// and a response whose number is no longer current is dropped, along with
// its loading flags, which belong to the lookup that replaced it.
export async function lookupCollege(ctx, collegeName, hintUrl, { refresh = false } = {}) {
  const {
    data, fitFingerprintRef, locale, lookupStateRef, setCollegePositioning, setCollegePositioningLoading, setCollegeValues,
    setCollegeValuesLoading, setCollegeVerification, setCollegeVerifying,
  } = ctx;
  const token = window.__CC_SESSION_TOKEN__;
  if (!token || !collegeName) return;
  const lookup = beginLookup(lookupStateRef, { collegeName, hintUrl, refresh });
  fitFingerprintRef.current = fitProfileFingerprint(data);
  setCollegeValuesLoading(true);
  // A new school clears the card at once. Clearing only the positioning
  // left the previous school's values up under the new lookup, the first
  // half of one card painted from two schools.
  if (!refresh) {
    setCollegeValues(null);
    setCollegePositioning(null);
  }
  setCollegeVerification(null);
  // A double-check still running belongs to the read being replaced.
  setCollegeVerifying?.(false);
  try {
    const r = await fetch("/api/colleges/values", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-CollegeApp-Locale": locale },
      body: JSON.stringify({ collegeName, hintUrl }),
      signal: lookup.signal,
    });
    const body = await r.json().catch(() => null);
    if (!lookup.current()) return;
    if (r.ok && body) setCollegeValues(refresh ? { ...body, refreshedAt: new Date().toISOString() } : body);
    // The code and status travel with the message so the card can say, in
    // the student's language, why the values part is missing (402 budget,
    // 403 consent, 404 unreadable site) while the fit read still shows.
    else if (!refresh) setCollegeValues({ error: body?.error || `HTTP ${r.status}`, code: body?.code || null, status: r.status });
  } catch (err) {
    if (!lookup.current()) return;
    if (!refresh) setCollegeValues({ error: err.message || "lookup failed", code: "network_error", status: 0 });
  } finally {
    if (lookup.current()) setCollegeValuesLoading(false);
  }

  // Calibrated fit (reach/target/safety) — separate, non-blocking call.
  // Positioning depends on CDS resolution which can miss for obscure
  // schools; CalibratedFitCard falls back to values-coverage when absent.
  // It runs whatever the values read answered: the read is deterministic,
  // needs no AI consent or budget, and the server keeps it for the chat,
  // so the card shows it even when the values part failed (fit-7).
  setCollegePositioningLoading(true);
  try {
    const major = (data?.majorInterest || data?.profile?.majorInterest || null);
    const pr = await fetch("/api/positioning/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-CollegeApp-Locale": locale },
      body: JSON.stringify({ targets: [{ schoolName: collegeName }], ...(major ? { major } : {}) }),
      signal: lookup.signal,
    });
    const pbody = await pr.json().catch(() => ({}));
    if (!lookup.current()) return;
    if (pr.ok && Array.isArray(pbody.targets) && pbody.targets.length > 0) {
      // `degraded` is the payload's, not the target's: a source failed while
      // the read was built (it is not cached server-side). The card says so
      // only when the flag rides on the read it is given.
      setCollegePositioning(pbody.degraded ? { ...pbody.targets[0], degraded: true } : pbody.targets[0]);
    } else if (!refresh) {
      setCollegePositioning(null);
    }
  } catch {
    if (lookup.current() && !refresh) setCollegePositioning(null);
  } finally {
    if (lookup.current()) {
      setCollegePositioningLoading(false);
      lookup.finish();
    }
  }
}

// The sequence a lookup runs under. `stateRef.current` holds the newest
// sequence number, the controller that can abort it, the fresh lookup still
// in flight (`pending`, which a profile refresh restarts instead of
// re-reading the card it is about to replace) and the last fresh request
// (`lastRequest`, the name a positioning-only card is refreshed by). Without
// a state ref every response applies, as before.
function beginLookup(stateRef, { collegeName, hintUrl, refresh }) {
  const state = stateRef?.current;
  if (!state) return { signal: undefined, current: () => true, finish: () => {} };
  try { state.controller?.abort(); } catch { /* an abort never blocks the next lookup */ }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const seq = (state.seq || 0) + 1;
  state.seq = seq;
  state.controller = controller;
  state.pending = refresh ? null : { collegeName, hintUrl };
  if (!refresh) state.lastRequest = { collegeName, hintUrl };
  return {
    signal: controller?.signal,
    current: () => state.seq === seq,
    finish: () => {
      if (state.seq !== seq) return;
      state.controller = null;
      state.pending = null;
    },
  };
}

// Drops whatever lookup is in flight: the student cleared the card, so
// nothing from before may paint it.
export function cancelLookup(stateRef) {
  const state = stateRef?.current;
  if (!state) return;
  try { state.controller?.abort(); } catch { /* ignore */ }
  state.seq = (state.seq || 0) + 1;
  state.controller = null;
  state.pending = null;
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
// `signal` is the turn's: send() joins the Cancel button and the Council's
// five-minute deadline into it, and authedFetch hands it to fetch, so either
// one closes the request and the route's own signal (tied to the response
// closing) stops the run between seats and releases what was reserved. The
// error keeps the route's code, so callers can tell a provider outage from
// a refused key or a used-up budget without reading the copy.
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
    const error = new Error(councilErrorMessage(response.status, body, locale, response.headers));
    error.status = response.status;
    if (body?.code) error.code = String(body.code);
    if (body?.councilCode) error.councilCode = String(body.councilCode);
    if (body?.blocked === true) error.blocked = true;
    error.body = body;
    throw error;
  }
  const formatted = formatCouncilResult(body, locale);
  return formatted;
}
