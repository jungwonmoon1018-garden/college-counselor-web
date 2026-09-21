// hooks/useCollegeFit.js — College Fit and the target schools: the values read,
// the positioning and its double-check, the per-account target list on the
// device, and the lookup, refresh and verify callbacks.
// Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useState, useRef, useEffect, useCallback } from "react";
import { removeTargetSchool as removeTargetSchoolImpl, lookupCollege as lookupCollegeImpl } from "../handlers/school-handlers.js";
import { fitReadIsStale } from "../profile/fit-refresh.js";

export function useCollegeFit(ctx) {
  const {
    data, locale, user,
  } = ctx;
  const [collegeValues, setCollegeValues] = useState(null); // { displayName, values, fit, ... }
  // The record the shown fit read was computed from (fit-refresh.js), and
  // refs the sync effect reads without re-running on every lookup.
  const fitFingerprintRef = useRef("");
  const collegeValuesRef = useRef(null);
  collegeValuesRef.current = collegeValues;
  const lookupCollegeRef = useRef(null);
  const [collegeValuesLoading, setCollegeValuesLoading] = useState(false);
  const [collegeValuesQuery, setCollegeValuesQuery] = useState("");
  const [collegeValuesHint, setCollegeValuesHint] = useState(""); // optional official page URL
  // Calibrated positioning for the looked-up college (reach/target/safety).
  const [collegePositioning, setCollegePositioning] = useState(null);
  const [collegePositioningLoading, setCollegePositioningLoading] = useState(false);
  // Web double-check of the fit read (live Scorecard + official pages).
  const [collegeVerification, setCollegeVerification] = useState(null);
  const [collegeVerifying, setCollegeVerifying] = useState(false);
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
  const addTargetSchool = useCallback((name) => {
    const n = String(name || "").trim();
    if (!n) return;
    // Compute "is this new?" SYNCHRONOUSLY from current state — do NOT rely on
    // a flag set inside the setState updater (React runs that later, so the
    // deadline trigger below would always see false → silent no-op).
    const already = targetSchools.some((s) => s.toLowerCase() === n.toLowerCase());
    setTargetSchoolInput("");
    if (already) return;
    const next = [...targetSchools, n].slice(0, 8);
    setTargetSchools(next);
    saveTargets(next, user?.email);
    // Populate the Deadlines tab with this school's EA/ED, RD, financial-aid,
    // and commit-by dates (advanced-model web search → auto-add). Via ref
    // because the creator is defined later in the component.
    createDeadlinesRef.current?.(n);
  }, [user?.email, targetSchools]);
  const removeTargetSchool = useCallback((...args) => removeTargetSchoolImpl({
      authedFetchRef, saveTargets, setDeadlineRefreshKey, setTargetSchools, user,
    }, ...args), [user?.email]);
  const lookupCollege = useCallback((...args) => lookupCollegeImpl({
      data, fitFingerprintRef, locale, setCollegePositioning, setCollegePositioningLoading, setCollegeValues,
      setCollegeValuesLoading, setCollegeVerification,
    }, ...args), [data, locale]);
  // Re-read the shown school when the record it was read from has moved.
  const refreshCollegeFit = useCallback((nextData) => {
    const shown = collegeValuesRef.current;
    if (!shown?.displayName || shown.error) return;
    if (nextData && !fitReadIsStale(fitFingerprintRef.current, nextData)) return;
    lookupCollegeRef.current?.(shown.displayName, undefined, { refresh: true });
  }, []);
  // Double-check the fit read against the live web: College Scorecard, the
  // school's own admissions pages (deterministic parse), and a second,
  // quote-verified read of those pages by the medium-tier model.
  const verifyCollegeFit = useCallback(async (schoolName, force = false) => {
    const token = window.__CC_SESSION_TOKEN__;
    if (!token || !schoolName) return;
    setCollegeVerifying(true);
    try {
      const major = (data?.majorInterest || data?.profile?.majorInterest || null);
      const r = await fetch("/api/positioning/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ schoolName, force, ...(major ? { major } : {}) }),
      });
      const body = await r.json().catch(() => ({}));
      setCollegeVerification(r.ok ? body : { error: body.error || `HTTP ${r.status}` });
    } catch (err) {
      setCollegeVerification({ error: err?.message || "verification failed" });
    } finally {
      setCollegeVerifying(false);
    }
  }, [data]);
  return {
    addTargetSchool, authedFetchRef, collegePositioning, collegePositioningLoading, collegeValues, collegeValuesHint,
    collegeValuesLoading, collegeValuesQuery, collegeVerification, collegeVerifying, createDeadlinesRef, deadlineRefreshKey,
    lookupCollege, lookupCollegeRef, refreshCollegeFit, removeTargetSchool, setCollegeValues, setCollegeValuesHint,
    setCollegeValuesQuery, setTargetSchoolInput, targetSchoolInput, targetSchools, verifyCollegeFit,
  };
}
