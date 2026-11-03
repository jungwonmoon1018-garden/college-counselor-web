// hooks/useCollegeFit.js — College Fit and the target schools: the values read,
// the positioning and its double-check, the per-account target list on the
// device, and the lookup, refresh and verify callbacks.
// Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useState, useRef, useEffect, useCallback } from "react";
import { removeTargetSchool as removeTargetSchoolImpl, lookupCollege as lookupCollegeImpl, cancelLookup } from "../handlers/school-handlers.js";
import { fitReadIsStale } from "../profile/fit-refresh.js";
import { MAX_TARGET_SCHOOLS, targetListHas } from "../profile/target-schools.js";

export function useCollegeFit(ctx) {
  const {
    data, locale, user,
  } = ctx;
  const [collegeValues, setCollegeValuesState] = useState(null); // { displayName, values, fit, ... }
  // The record the shown fit read was computed from (fit-refresh.js), and
  // refs the sync effect reads without re-running on every lookup.
  const fitFingerprintRef = useRef("");
  const collegeValuesRef = useRef(null);
  collegeValuesRef.current = collegeValues;
  const lookupCollegeRef = useRef(null);
  // The lookup sequence (school-handlers.js beginLookup): only the newest
  // lookup paints the card, and a double-check answers only for the read it
  // was started on.
  const lookupStateRef = useRef({ seq: 0, controller: null, pending: null, lastRequest: null });
  const verifySeqRef = useRef(0);
  const [collegeValuesLoading, setCollegeValuesLoading] = useState(false);
  const [collegeValuesQuery, setCollegeValuesQuery] = useState("");
  const [collegeValuesHint, setCollegeValuesHint] = useState(""); // optional official page URL
  // Calibrated positioning for the looked-up college (reach/target/safety).
  const [collegePositioning, setCollegePositioning] = useState(null);
  const collegePositioningRef = useRef(null);
  collegePositioningRef.current = collegePositioning;
  const [collegePositioningLoading, setCollegePositioningLoading] = useState(false);
  // Web double-check of the fit read (live Scorecard + official pages).
  const [collegeVerification, setCollegeVerification] = useState(null);
  const [collegeVerifying, setCollegeVerifying] = useState(false);
  // What the sidebar calls to clear the card (typing a new query, ✕, the
  // cache clear). Clearing clears the whole read: the card also stands on a
  // positioning read alone when the values part failed (fit-7), and a
  // lookup still in flight would otherwise paint the school just cleared.
  const setCollegeValues = useCallback((next) => {
    if (next == null) {
      cancelLookup(lookupStateRef);
      verifySeqRef.current += 1;
      setCollegePositioning(null);
      setCollegeVerification(null);
      setCollegeValuesLoading(false);
      setCollegePositioningLoading(false);
      setCollegeVerifying(false);
    }
    setCollegeValuesState(next);
  }, []);
  // Shared "I'm targeting…" list of specific universities. Read by Rank EC
  // ideas, Edit your story, and Course plan so their output is tailored to
  // these schools. Persisted to localStorage (the survey only captures
  // college TYPES, not named schools, so this is where named targets live).
  const [targetSchools, setTargetSchools] = useState([]);
  const [targetSchoolInput, setTargetSchoolInput] = useState("");
  // Bumped when a school is removed so the Deadline tracker reloads and drops
  // that school's (now-deleted) deadlines.
  const [deadlineRefreshKey, setDeadlineRefreshKey] = useState(0);
  // Load the saved target schools when the signed-in user is known.
  useEffect(() => {
    if (!user?.email) return;
    try {
      const raw = window.localStorage?.getItem?.(`cc_targets_${user.email}`);
      setTargetSchools(raw ? JSON.parse(raw) : []);
    } catch { setTargetSchools([]); }
  }, [user?.email]);
  const saveTargets = (arr, email) => {
    try { if (email) window.localStorage?.setItem?.(`cc_targets_${email}`, JSON.stringify(arr)); } catch { /* ignore */ }
  };
  // Holds the (later-defined) deadline creator so addTargetSchool can call it
  // without a forward-reference TDZ in its dependency array.
  const createDeadlinesRef = useRef(null);
  const authedFetchRef = useRef(null);
  // Returns what happened ("added", "duplicate", "full", "empty"), for the
  // callers and tests that need to know.
  const addTargetSchool = useCallback((name) => {
    const n = String(name || "").trim();
    if (!n) return "empty";
    // Compute "is this new?" SYNCHRONOUSLY from current state — do NOT rely on
    // a flag set inside the setState updater (React runs that later, so the
    // deadline trigger below would always see false → silent no-op).
    if (targetListHas(targetSchools, n)) {
      setTargetSchoolInput("");
      return "duplicate";
    }
    // A full list takes nothing: the input keeps the name and the sidebar
    // says the list is full (profile/target-schools.js on why the cap is
    // checked here and not by trimming the list afterwards).
    if (targetSchools.length >= MAX_TARGET_SCHOOLS) return "full";
    setTargetSchoolInput("");
    const next = [...targetSchools, n];
    setTargetSchools(next);
    saveTargets(next, user?.email);
    // Populate the Deadlines tab with this school's EA/ED, RD, financial-aid,
    // and commit-by dates (advanced-model web search → auto-add). Via ref
    // because the creator is defined later in the component. The list goes
    // with it so the creator can refuse a school that is not on it.
    createDeadlinesRef.current?.(n, { targetSchools: next });
    return "added";
  }, [user?.email, targetSchools]);
  const removeTargetSchool = useCallback((...args) => removeTargetSchoolImpl({
      authedFetchRef, saveTargets, setDeadlineRefreshKey, setTargetSchools, user,
    }, ...args), [user?.email]);
  const lookupCollege = useCallback((...args) => lookupCollegeImpl({
      data, fitFingerprintRef, locale, lookupStateRef, setCollegePositioning, setCollegePositioningLoading,
      setCollegeValues: setCollegeValuesState, setCollegeValuesLoading, setCollegeVerification, setCollegeVerifying,
    }, ...args), [data, locale]);
  // Re-read the shown school when the record it was read from has moved.
  const refreshCollegeFit = useCallback((nextData) => {
    if (nextData && !fitReadIsStale(fitFingerprintRef.current, nextData)) return;
    // A lookup the student started is still in flight, on the record as it
    // was: start it again on the newer one. Re-reading the card it is about
    // to replace, as this did, superseded the student's lookup with the
    // previous school.
    const pending = lookupStateRef.current.pending;
    if (pending) {
      lookupCollegeRef.current?.(pending.collegeName, pending.hintUrl);
      return;
    }
    const shown = collegeValuesRef.current;
    if (shown?.displayName && !shown.error) {
      lookupCollegeRef.current?.(shown.displayName, undefined, { refresh: true });
      return;
    }
    // A card standing on the fit read alone (the values part failed) is
    // re-read by the name the student looked up; the values error stays.
    const last = lookupStateRef.current.lastRequest;
    if (collegePositioningRef.current && last?.collegeName) {
      lookupCollegeRef.current?.(last.collegeName, last.hintUrl, { refresh: true });
    }
  }, []);
  // Double-check the fit read against the live web: College Scorecard, the
  // school's own admissions pages (deterministic parse), and a second,
  // quote-verified read of those pages by the medium-tier model. The answer
  // applies only while the read it was started on is still the one shown
  // and no newer double-check has been started.
  const verifyCollegeFit = useCallback(async (schoolName, force = false) => {
    const token = window.__CC_SESSION_TOKEN__;
    if (!token || !schoolName) return;
    const seq = verifySeqRef.current + 1;
    verifySeqRef.current = seq;
    const lookupAt = lookupStateRef.current.seq;
    const current = () => verifySeqRef.current === seq && lookupStateRef.current.seq === lookupAt;
    setCollegeVerifying(true);
    try {
      const major = (data?.majorInterest || data?.profile?.majorInterest || null);
      const r = await fetch("/api/positioning/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ schoolName, force, ...(major ? { major } : {}) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!current()) return;
      setCollegeVerification(r.ok ? body : { error: body.error || `HTTP ${r.status}` });
    } catch (err) {
      if (current()) setCollegeVerification({ error: err?.message || "verification failed" });
    } finally {
      if (current()) setCollegeVerifying(false);
    }
  }, [data]);
  return {
    addTargetSchool, authedFetchRef, collegePositioning, collegePositioningLoading, collegeValues, collegeValuesHint,
    collegeValuesLoading, collegeValuesQuery, collegeVerification, collegeVerifying, createDeadlinesRef, deadlineRefreshKey,
    lookupCollege, lookupCollegeRef, refreshCollegeFit, removeTargetSchool, setCollegeValues, setCollegeValuesHint,
    setCollegeValuesQuery, setTargetSchoolInput, targetSchoolInput, targetSchools, verifyCollegeFit,
  };
}
