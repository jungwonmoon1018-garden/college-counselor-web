import { useState, useEffect, useRef, useCallback } from "react";
import "./components/NarrativeEditor.jsx";
import "./components/DriftBanner.jsx";
import CloseButton from "./components/CloseButton.jsx";
import "./components/SidebarSection.jsx";
import "./chat/chat-documents.js";
import "./components/CandidateRanker.jsx";
import DeadlineTracker from "./components/DeadlineTracker.jsx";
import "./components/PrestigeCard.jsx";
import "./components/EcEvidence.jsx";
import "./components/SpikeFinder.jsx";
import "./components/CalibratedFitCard.jsx";
import "./components/CourseSequencer.jsx";
import "./components/TranscriptImportCard.jsx";
import { mergeImportedCourses, currentYearKey } from "./profile/transcript-utils.js";
import DisclosurePanel from "./components/DisclosurePanel.jsx";
import MethodologyPanel from "./components/MethodologyPanel.jsx";
import { detectLocale, t as tt } from "./i18n.js";
import { fitReadIsStale } from "./profile/fit-refresh.js";
import { serverDateToISO } from "./profile/dates.js";
import { TEST_SCORE_LIMITS, validateTestEntry, blankTestForm, entryToForm, formToEntry } from "./profile/test-scores.js";
import "./profile/strategy-council.js";
import Sidebar from "./screens/Sidebar.jsx";
import { AP_EXAM_LIST, GRADE_SCALE } from "./app-shared.js";
import SurveyScreen from "./screens/SurveyScreen.jsx";
import { BG, FONT, GLOBAL_CSS, inputStyle } from "./app-shared.js";
import LoginScreen from "./screens/LoginScreen.jsx";
import { S, dots } from "./app-shared.js";
import CreateAccountScreen from "./screens/CreateAccountScreen.jsx";
import { encrypt, storageApi, safeBtoa, storageKeyFor, clearSession, buildVaultBlob } from "./session/vault-storage.js";
import { ONBOARDING_CONSENT_TYPES, grantOnboardingConsents, sessionTimer } from "./session/server-session.js";
import "./profile/profile-analysis.js";
import { MAX_SCHOOL_FILE_SIZE_BYTES, resolveUploadMimeType, getSchoolFileValidationError } from "./chat/chat-files.js";
import { rateLimiter, setReauthListener, setReauthCredentialProvider, _tryReAuth } from "./chat/chat-client.js";
import "./chat/markdown.jsx";
import "./chat/chat-orchestrator.js";
import ChatScreen from "./screens/ChatScreen.jsx";
import { send as sendImpl, handleChatFilesSelect as handleChatFilesSelectImpl, openThread as openThreadImpl, persistTurn as persistTurnImpl } from "./handlers/chat-send.js";
import { handleLogin as handleLoginImpl, handleCreate as handleCreateImpl, handleStudentRecovery as handleStudentRecoveryImpl } from "./handlers/auth-handlers.js";
import { handleSurveyComplete as handleSurveyCompleteImpl, hydrateSurveyFromCurrentData as hydrateSurveyFromCurrentDataImpl, reconcileWithBackendProfile as reconcileWithBackendProfileImpl, editECFromProfile as editECFromProfileImpl } from "./handlers/survey-handlers.js";
import { createDeadlinesForSchool as createDeadlinesForSchoolImpl, lookupCollege as lookupCollegeImpl, removeTargetSchool as removeTargetSchoolImpl, conveneStrategyCouncil as conveneStrategyCouncilImpl } from "./handlers/school-handlers.js";


const SURVEY_YEARS = ["freshman","sophomore","junior","senior"];


function getPassphraseStrength(passphrase) {
  if (!passphrase) return { label:"Too short", color:"#555", fill:"0%" };
  let score = 0;
  if (passphrase.length >= 8) score++;
  if (passphrase.length >= 12) score++;
  if (/\s/.test(passphrase)) score++;
  if (/[A-Z]/.test(passphrase) && /[a-z]/.test(passphrase)) score++;
  if (/\d/.test(passphrase) || /[^A-Za-z\s]/.test(passphrase)) score++;
  if (score <= 1) return { label:"Weak", color:"#f56565", fill:"33%" };
  if (score <= 3) return { label:"Fair", color:"#f6ad55", fill:"66%" };
  return { label:"Strong", color:"#68d391", fill:"100%" };
}

function makeExportFilename(user) {
  const safeName = (user?.name || "college_vault").replace(/[^a-z0-9]+/gi,"_").replace(/^_+|_+$/g,"") || "college_vault";
  const stamp = new Date().toISOString().slice(0, 10);
  return `${safeName}_vault_${stamp}.enc.json`;
}

function formatUserFacingError(error) {
  const msg = String(error?.message || "").toLowerCase();
  if (msg.includes("api 429") || msg.includes("rate limit")) return "The system is busy right now. Please try again in a minute.";
  if (msg.includes("api 413") || msg.includes("too large")) return "Your message was too long. Try a shorter question or smaller file.";
  if (msg.includes("timed out") || msg.includes("took too long")) return "The counselor took too long to respond, so the request was stopped. Please try again.";
  if (msg.includes("failed to fetch") || msg.includes("network")) return "Check your internet connection and try again.";
  if (/no api key|not configured|missing .*api key/i.test(msg)) return "Chat isn't configured yet. Ask this device's administrator to configure OpenRouter.";
  return "Something went wrong while answering that. Please try again.";
}


export default function App() {
  const [screen, setScreen] = useState(S.LOADING);

  // Create account fields
  // Name is collected as first + last (browser autofill via autoComplete
  // given-name/family-name); cName stays as the combined value the rest of
  // the app and the backend already expect.
  const [cFirst, setCFirst] = useState("");
  const [cLast, setCLast] = useState("");
  const cName = `${cFirst} ${cLast}`.replace(/\s+/g, " ").trim();
  const [cEmail, setCEmail] = useState("");
  const [cGrade, setCGrade] = useState("");
  const [cPass, setCPass] = useState("");
  const [cPass2, setCPass2] = useState("");
  const [cAgeAttest, setCAgeAttest] = useState(false);
  const [cConsentAI, setCConsentAI] = useState(false);
  const [cConsentData, setCConsentData] = useState(false);
  const [cError, setCError] = useState("");
  const [showCreatePass, setShowCreatePass] = useState(false);
  const [showCreatePass2, setShowCreatePass2] = useState(false);

  // Survey state
  const [surveyStep, setSurveyStep] = useState(0); // 0=GPA, 1=courses, 2=tests, 3=ECs, 4=goals, 5=parent
  const [surveyError, setSurveyError] = useState("");
  // Step 0: GPA
  const [sGpaUw, setSGpaUw] = useState("");
  const [sGpaW, setSGpaW] = useState("");
  const [sNoGpaYet, setSNoGpaYet] = useState(false);
  // Class rank: a rank in a class of a known size, or the top share.
  const [sClassRank, setSClassRank] = useState({ rank:"", size:"", topPercent:"" });
  // Courses organized by school year
  const [sCourseYear, setSCourseYear] = useState("freshman"); // which year tab is active
  const [sCourses, setSCourses] = useState({ freshman:[], sophomore:[], junior:[], senior:[] });
  const [sCourseInput, setSCourseInput] = useState({ name:"", type:"regular", grade:"A", semester:"full_year" });
  // Transcript import (PDF / image / DOCX → parsed course list for review)
  const [sImportBusy, setSImportBusy] = useState(false);
  const [sImportNote, setSImportNote] = useState("");
  // Tests — expanded categories
  const [sTests, setSTests] = useState([]);
  const [sTestCategory, setSTestCategory] = useState("sat"); // which test type tab
  const [sTestInput, setSTestInput] = useState(() => blankTestForm("sat"));
  const [sNoTestsYet, setSNoTestsYet] = useState(false);
  // AP exam scores (separate from test scores for clarity)
  const [sAPScores, setSAPScores] = useState([]); // [{subject,score,year}]
  const [sAPInput, setSAPInput] = useState({ subject:"", score:"5", year:"2025" });
  // ECs
  const [sECs, setSECs] = useState([]);
  // The default category must be a value the dropdown actually offers. It
  // used to be the legacy "club", which the select could not display (so it
  // showed the first option, "Academic") but which saved through the
  // migration shim as "Other Club/Activity".
  const [sECInput, setSECInput] = useState({
    name: "",
    category: "academic",
    role: "",
    hoursPerWeek: "",
    weeksPerYear: "",
    description: "",
    grades: [],            // ["freshman","sophomore","junior","senior"] — Common App checkboxes
    timing: "school_year", // "school_year" | "school_break" | "both"
  });
  // Goals
  const [sGoals, setSGoals] = useState([]);
  const [sMajorInterest, setsMajorInterest] = useState("");
  // Login fields
  const [lEmail, setLEmail] = useState("");
  const [lPass, setLPass] = useState("");
  const [lError, setLError] = useState("");
  const [showLoginPass, setShowLoginPass] = useState(false);
  const [studentRecoveryOpen, setStudentRecoveryOpen] = useState(false);
  const [studentRecoveryInput, setStudentRecoveryInput] = useState("");
  const [studentRecoveryPassword, setStudentRecoveryPassword] = useState("");
  const [studentRecoveryBusy, setStudentRecoveryBusy] = useState(false);
  const [studentRecoveryMessage, setStudentRecoveryMessage] = useState(null);
  const [studentRecoveryCode, setStudentRecoveryCode] = useState("");

  // Chat state
  const [user, setUser] = useState(null); // { name, email, grade }
  const [passphrase, setPassphrase] = useState("");

  // Drafts are intentionally memory-only until encrypted vault persistence is
  // available. This avoids storing GPA, activities, and family contact data as
  // plaintext in localStorage.
  const [data, setData] = useState({ profile:null, activities:[], studyNotes:[], documents:[] });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState({ active:null, phase:"" });
  const [budgetStatus, setBudgetStatus] = useState(null);
  // Null means ordinary chat. Any value is a one-message, explicitly selected
  // Strategy Council mode and is cleared as soon as that request starts.
  const [councilDecisionType, setCouncilDecisionType] = useState(null);
  const councilTurnSequenceRef = useRef(0);

  // ─── Chat thread history ───
  // threadList = sidebar entries (id, title, updated_at, message_count).
  // activeThreadId = which thread the open `messages` belong to.
  const [threadList, setThreadList] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [threadSearchQ, setThreadSearchQ] = useState("");
  const [threadSearchResults, setThreadSearchResults] = useState([]);
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
  // Inline double-click editing in the sidebar: chat-thread rename + profile
  // fields (GPA, test scores, courses). `editingField` is a key like
  // "gpa" | "test:2" | "course:0"; drafts hold the in-progress values.
  const [renamingThreadId, setRenamingThreadId] = useState(null);
  const [threadDraft, setThreadDraft] = useState("");
  const [editingField, setEditingField] = useState(null);
  const [draftA, setDraftA] = useState("");
  const [draftB, setDraftB] = useState("");
  // Expand/collapse the sidebar Courses & ECs lists (capped previews by default).
  const [showAllCourses, setShowAllCourses] = useState(false);
  const [showAllECs, setShowAllECs] = useState(false);
  // Admissions-calendar context (today + cycle phase + typical deadlines +
  // per-target-school deadlines). Refetched whenever the target list changes
  // so the consultant agent stays date-aware. `today` is re-stamped fresh on
  // every send (see buildCalendarPreamble), so it's correct each day.
  const [calendarCtx, setCalendarCtx] = useState(null);
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

  // ─── Auth-resilient fetch ───────────────────────────────────────
  // Every backend read/write goes through here so a stale or missing
  // session token (the classic post-restart case) is transparently
  // healed instead of silently dropping the request. Without this,
  // chat history wouldn't reload and profile/chat writes would no-op
  // after a backend restart — making it look like data was lost when
  // it's actually safe in the DB, just unreachable without a token.
  //   1. If no token, re-auth before the request.
  //   2. On 401, re-auth ONCE and retry.
  const authedFetch = useCallback(async (path, opts = {}) => {
    const proxyUrl = window.__CC_PROXY_URL__ || "/api/chat";
    const doFetch = (tok) => fetch(path, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
    });
    let token = window.__CC_SESSION_TOKEN__;
    if (!token) {
      await _tryReAuth(proxyUrl);
      token = window.__CC_SESSION_TOKEN__;
    }
    let r = await doFetch(token);
    if (r.status === 401) {
      const ok = await _tryReAuth(proxyUrl);
      if (ok) r = await doFetch(window.__CC_SESSION_TOKEN__);
    }
    return r;
  }, []);
  authedFetchRef.current = authedFetch;

  const refreshBudget = useCallback(async () => {
    try {
      const response = await authedFetch("/api/students/budget");
      if (response.ok) setBudgetStatus(await response.json());
    } catch { /* budget display is non-blocking */ }
  }, [authedFetch]);

  useEffect(() => {
    if (screen !== S.CHAT || !user) return undefined;
    refreshBudget();
    const timer = setInterval(refreshBudget, 60000);
    return () => clearInterval(timer);
  }, [screen, user, refreshBudget]);

  // Fetch the student's threads (called after auth lands).
  const refreshThreadList = useCallback(async () => {
    try {
      const r = await authedFetch("/api/students/threads");
      if (r.ok) {
        const data = await r.json();
        // Normalize SQLite timestamps to ISO so Safari can parse them and so
        // the updated_at sort compares consistently with client-stamped ISO.
        setThreadList((data.threads || []).map(t => ({ ...t, updated_at: serverDateToISO(t.updated_at) })));
      }
    } catch (err) { console.warn("[CHAT] refreshThreadList failed:", err?.message); }
  }, [authedFetch]);

  // Create a new thread server-side and switch to it. Clears current
  // in-memory messages so the new thread starts blank.
  const newThread = useCallback(async (initialTitle, preserveMessages = false) => {
    try {
      const r = await authedFetch("/api/students/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: initialTitle }),
      });
      if (!r.ok) return null;
      const data = await r.json();
      setActiveThreadId(data.id);
      if (!preserveMessages) setMessages([]);
      refreshThreadList();
      return data.id;
    } catch { return null; }
  }, [authedFetch, refreshThreadList]);

  const openThread = useCallback((...args) => openThreadImpl({
      authedFetch, refreshThreadList, setActiveThreadId, setMessages,
    }, ...args), [authedFetch, refreshThreadList]);

  const persistTurn = useCallback((...args) => persistTurnImpl({
      authedFetch, refreshThreadList, setSyncNote, setSyncStatus, setThreadList,
    }, ...args), [authedFetch, refreshThreadList]);

  // Delete a thread (soft archive by default).
  const deleteThread = useCallback(async (threadId, hard = false) => {
    const token = window.__CC_SESSION_TOKEN__;
    if (!token) return;
    try {
      await fetch(`/api/students/threads/${threadId}${hard ? "?hard=1" : ""}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
        setMessages([]);
      }
      refreshThreadList();
    } catch (err) { console.warn("[CHAT] deleteThread failed:", err?.message); }
  }, [activeThreadId, refreshThreadList]);

  // Search across all threads (substring on message content).
  const searchThreads = useCallback(async (q) => {
    setThreadSearchQ(q);
    if (!q || q.length < 2) { setThreadSearchResults([]); return; }
    const token = window.__CC_SESSION_TOKEN__;
    if (!token) return;
    try {
      const r = await fetch(`/api/students/threads-search?q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const data = await r.json();
        setThreadSearchResults(data.results || []);
      }
    } catch (err) { console.warn("[CHAT] search failed:", err?.message); }
  }, []);

  // locale drives both static frontend strings AND the locale param sent to
  // the backend (so server-side friendlyMessage / friendlyLegendI18n come
  // back in the right language). Persisted to localStorage so reloads stick.
  // Declared here, ahead of the fit lookups that send it.
  const [locale, setLocaleState] = useState(detectLocale());

  const lookupCollege = useCallback((...args) => lookupCollegeImpl({
      data, fitFingerprintRef, locale, setCollegePositioning, setCollegePositioningLoading, setCollegeValues,
      setCollegeValuesLoading, setCollegeVerification,
    }, ...args), [data, locale]);
  lookupCollegeRef.current = lookupCollege;

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

  // ─── Transcript → profile, from the chat ───
  // Parse the attached transcript's text with the same deterministic route
  // the profile editor uses (grades copied as written, never guessed) and
  // merge the courses into the profile; the auto-save effect syncs it.
  const parseTranscriptText = useCallback(async (file) => {
    const post = () => authedFetch("/api/students/transcript-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: file.text, filename: file.name || "transcript" }),
    });
    let r = await post();
    let body = await r.json().catch(() => ({}));
    if (r.status === 403 && body.code === "consent_required") {
      const missing = (Array.isArray(body.missing) ? body.missing : []).filter((type) => ONBOARDING_CONSENT_TYPES.includes(type));
      await grantOnboardingConsents(missing.length ? missing : undefined);
      r = await post();
      body = await r.json().catch(() => ({}));
    }
    if (!r.ok) throw new Error(body.error || `Import failed (HTTP ${r.status})`);
    return body;
  }, [authedFetch, grantOnboardingConsents]);
  const importParsedTranscript = useCallback((parsed) => {
    let outcome = { added: 0, skipped: 0, unplaced: 0 };
    setData(prev => {
      const profile = { ...(prev.profile || {}) };
      const merged = mergeImportedCourses(profile.courses || [], parsed?.courses || {}, { fallbackYear: currentYearKey(user?.grade) });
      outcome = { added: merged.added, skipped: merged.skipped, unplaced: merged.unplaced };
      profile.courses = merged.courses;
      if (parsed?.gpa != null && !profile.gpa) { profile.gpa = { unweighted: parsed.gpa }; profile.gpaStatus = undefined; }
      return { ...prev, profile };
    });
    return outcome;
  }, [user?.grade]);

  // ─── Inline chat tools ───
  // The four student tools (narrative, candidate ranker, spike finder,
  // course plan) render INLINE in the conversation as ephemeral cards.
  // They carry role:"tool" so buildHistoryMsgs() skips them (never sent to
  // the model) and persistTurn() never stores them (no backend round-trip).
  // Switching threads clears them, which is the intended ephemeral behavior.
  const toolSeq = useRef(0);
  // The open tool cards, for openTool: a second click on a tool's button
  // used to append a second card, and each card fetched (Spike Finder's
  // fetch is a model re-rank), so three clicks meant three panels and
  // three re-ranks. An open card is brought into view instead.
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const openTool = useCallback((toolName) => {
    const existing = (messagesRef.current || []).find((m) => m?.role === "tool" && m.tool === toolName && m.id);
    if (existing) {
      setTimeout(() => { try { document.getElementById(existing.id)?.scrollIntoView?.({ behavior: "smooth", block: "start" }); } catch { /* ignore */ } }, 0);
      return;
    }
    toolSeq.current += 1;
    const id = `tool-${toolName}-${toolSeq.current}`;
    setMessages(prev => [...prev, { role: "tool", tool: toolName, id }]);
  }, []);
  const dismissTool = useCallback((id) => {
    setMessages(prev => prev.filter(m => !(m.role === "tool" && m.id === id)));
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState(null); // legacy single-file (PDF/image OCR survey path)
  // Multi-file / folder chat attachments. Each entry is the parsed
  // shape returned by readChatFile: { kind, name, path, size, ... }.
  // Read once on selection, kept in memory until the user sends the
  // next turn or removes them.
  const [chatFiles, setChatFiles] = useState([]); // Array<ChatFile>
  // Whether the collapsed folder-chip's expanded list is showing.
  // Auto-collapses again on send via setChatFiles([]) clearing state.
  const [chatFilesExpanded, setChatFilesExpanded] = useState(false);
  const conveneStrategyCouncil = useCallback((...args) => conveneStrategyCouncilImpl({
      authedFetch, locale, setAgentStatus,
    }, ...args), [authedFetch, locale]);
  // Lightweight modal panel selector: "narrative" | "candidates" | "deadlines" | null.
  // The modal renders over CHAT so the student doesn't lose chat context.
  const [activePanel, setActivePanel] = useState(null);
  const modalRef = useRef(null);
  // Survey step 3 = personal narrative (new). Stored separately from the
  // encrypted blob because the backend owns it and the bundle pulls the
  // active row server-side.
  const [sNarrative, setSNarrative] = useState("");
  const [sNarrativeSaved, setSNarrativeSaved] = useState(false);
  // Bumped on every narrative save so the chat-top drift banner re-reads
  // its status instead of keeping a stale "no saved story" warning.
  const [narrativeVersion, setNarrativeVersion] = useState(0);
  // Which EC row is showing its PrestigeCard expansion. Stored as the EC's
  // index in the sidebar list, or null. Click toggles; only one open at once
  // (the prestige rationale can be long, multiple open turns the sidebar
  // into a wall of text).
  const [expandedEC, setExpandedEC] = useState(null);
  // Bumped when chat uploads are read into activities, so an expanded EC's
  // prestige card and evidence list fetch again.
  const [evidenceVersion, setEvidenceVersion] = useState(0);
  // Switch locale + persist + reload-not-needed (components subscribe).
  const setLocale = useCallback((next) => {
    setLocaleState(next);
    try { localStorage.setItem("cc_locale", next); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === "ko" ? "ko" : "en";
  }, [locale]);
  // Chat uploads read into activities change the strength vectors the
  // matrix sharpens its activity reads with; re-read the shown school.
  useEffect(() => {
    if (evidenceVersion > 0) refreshCollegeFit(null);
  }, [evidenceVersion, refreshCollegeFit]);

  useEffect(() => {
    if (!activePanel) return undefined;
    const previous = document.activeElement;
    const focusableSelector = "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
    const focusFirst = () => modalRef.current?.querySelector(focusableSelector)?.focus();
    const frame = requestAnimationFrame(focusFirst);
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); setActivePanel(null); return; }
      if (event.key !== "Tab" || !modalRef.current) return;
      const items = Array.from(modalRef.current.querySelectorAll(focusableSelector));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [activePanel]);
  const chatEnd = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const chatTextareaRef = useRef(null);
  const createPassStrength = getPassphraseStrength(cPass);
  const isFreshman = user?.grade === "Freshman";

  const hydrateSurveyFromCurrentData = useCallback((...args) => hydrateSurveyFromCurrentDataImpl({
      data, setSAPInput, setSAPScores, setSClassRank, setSCourseInput, setSCourseYear,
      setSCourses, setSECInput, setSECs, setSGoals, setSGpaUw, setSGpaW,
      setSNoGpaYet, setSNoTestsYet, setSTestCategory, setSTestInput, setSTests, setSurveyError,
      setsMajorInterest,
    }, ...args), [data]);

  const reconcileWithBackendProfile = useCallback((...args) => reconcileWithBackendProfileImpl({
      authedFetch, data, setData,
    }, ...args), [data, authedFetch]);

  const openProfileEditor = useCallback(async (step=0) => {
    // Pull the canonical backend profile first so the editor shows the
    // student's real courses/GPA/ECs even when the local vault is empty.
    const merged = await reconcileWithBackendProfile(data);
    hydrateSurveyFromCurrentData(merged);
    setSurveyStep(step);
    setScreen(S.SURVEY);
    setSidebarOpen(false);
  }, [reconcileWithBackendProfile, hydrateSurveyFromCurrentData, data]);

  const editECFromProfile = useCallback((...args) => editECFromProfileImpl({
      hydrateSurveyFromCurrentData, setSECInput, setSECs, setScreen, setSidebarOpen, setSurveyStep,
    }, ...args), [hydrateSurveyFromCurrentData]);

  // ─── Inline sidebar editing ───
  // Rename a chat thread (double-click its title). Persists via PATCH; the
  // backend only accepts a non-empty title.
  const renameThreadTitle = useCallback(async (threadId, title) => {
    const t = String(title || "").trim();
    setRenamingThreadId(null);
    if (!threadId || !t) return;
    setThreadList(prev => prev.map(x => x.id === threadId ? { ...x, title: t } : x));
    try {
      await authedFetch(`/api/students/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
    } catch (err) { console.warn("[CHAT] rename failed:", err?.message); refreshThreadList(); }
  }, [authedFetch, refreshThreadList]);

  const createDeadlinesForSchool = useCallback((...args) => createDeadlinesForSchoolImpl({
      authedFetch,
    }, ...args), [authedFetch]);
  createDeadlinesRef.current = createDeadlinesForSchool;

  // Mutate the local profile; the auto-save effect syncs it to the backend
  // (which re-runs EC-strength / directionality / auto-narrative).
  const commitProfile = useCallback((mutator) => {
    setData(prev => {
      const profile = { ...(prev.profile || {}) };
      mutator(profile);
      return { ...prev, profile };
    });
    setEditingField(null);
  }, []);

  const beginEdit = useCallback((key, a = "", b = "") => {
    setEditingField(key); setDraftA(String(a)); setDraftB(String(b));
  }, []);

  const cancelPendingRequest = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(()=>{chatEnd.current?.scrollIntoView({behavior:"smooth"});},[messages]);

  // ─── FILE UPLOAD HANDLER ───
  const handleFileSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validationError = getSchoolFileValidationError(file);
    if (validationError) { alert(validationError); return; }
    const mimeType = resolveUploadMimeType(file);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      setPendingFile({ name: file.name, type: mimeType, size: file.size, base64, mediaType: mimeType });
    };
    reader.readAsDataURL(file);
    e.target.value = ""; // reset so same file can be selected again
  }, []);

  const handleChatFilesSelect = useCallback((...args) => handleChatFilesSelectImpl({
      chatFiles, setChatFiles, setMessages,
    }, ...args), [chatFiles]);

  const removeChatFile = useCallback((idx) => {
    setChatFiles(prev => prev.filter((_, i) => i !== idx));
  }, []);
  const clearChatFiles = useCallback(() => setChatFiles([]), []);

  // Observable session health: re-auth + background-sync status for non-blocking toasts.
  const [reauthStatus, setReauthStatus] = useState("idle"); // idle | attempting | ok | failed
  const [syncStatus, setSyncStatus] = useState("idle");     // idle | ok | failed
  const [syncNote, setSyncNote] = useState("");             // overrides the default "didn't sync" toast text
  // True during the last minute before the inactivity sign-out — rendered as a
  // prominent toast so the auto-lock never silently eats a drafted message.
  const [expiryWarning, setExpiryWarning] = useState(false);
  // The inactivity notice, shown as a toast in both the survey and the chat.
  const EXPIRY_NOTICE = "Still there? You'll be signed out in about a minute of inactivity — click or type to stay signed in.";
  // The session notice the student closed with its ×: that exact notice
  // stays hidden, a different one shows again.
  const [dismissedNotice, setDismissedNotice] = useState("");
  // Offline-first: true when the vault unlocked locally but the backend was
  // unreachable at sign-in. The student keeps full access to their on-device
  // data; server features (chat, sync) resume when the backend returns. Cleared
  // on the next successful server contact.
  const [offlineMode, setOfflineMode] = useState(false);

  // Register the module-level re-auth notifier so the silent token-recovery
  // path becomes visible to the student instead of a confusing dead end.
  useEffect(() => {
    setReauthListener((status) => {
      setReauthStatus(status);
      if (status === "ok") setTimeout(() => setReauthStatus("idle"), 2500);
    });
    return () => setReauthListener(null);
  }, []);

  useEffect(() => {
    setReauthCredentialProvider(() => user?.email && passphrase
      ? { email: user.email, password: passphrase }
      : null);
    return () => setReauthCredentialProvider(null);
  }, [user?.email, passphrase]);

  // ─── ROUTE ON MOUNT ───
  // There is no local account registry and no persisted session: the backend
  // owns identity, and sessions are memory-only. So there is nothing to
  // rehydrate — start at login and let a first-time student take the "Create
  // account" link. Routing by "do any accounts exist" is deliberately gone:
  // it would disclose account existence before authentication, which the
  // backend's uniform invalid-credentials response is designed to avoid.
  useEffect(() => {
    clearSession();
    setScreen(S.LOGIN);
  }, []);

  // ─── AUTO-SAVE data + SYNC TO RAG BACKEND ───
  useEffect(() => {
    if ((screen !== S.CHAT && screen !== S.SURVEY) || !user || !passphrase) return;
    const t = setTimeout(async () => {
      // 1. Save to encrypted localStorage (offline-first). Identity is written
      //    alongside the data — it is the only copy login can read back.
      const storageKey = await storageKeyFor(user.email);
      const e = await encrypt(buildVaultBlob(data, { name: user.name, grade: user.grade }), passphrase, user.email);
      try { await storageApi.set(storageKey, e); } catch (err) { console.warn("Auto-save failed:", err?.message); }

      // 2. Sync to RAG backend — persists grades/GPA/ECs server-side so
      //    they survive restarts AND are reachable from any device.
      //    Routed through authedFetch so a stale token (post-restart)
      //    is healed and the write actually lands instead of silently
      //    no-oping.
      if (data.profile) {
        try {
          await authedFetch("/api/students/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              profile: data.profile,
              activities: data.activities || [],
              goals: data.goals || [],
              majorInterest: data.majorInterest || "",
              trigger: "auto_sync"
            })
          });
          setSyncStatus("ok");
          setSyncNote("");
          setOfflineMode(false); // a sync landed — backend is reachable again
          setTimeout(() => setSyncStatus((s) => (s === "ok" ? "idle" : s)), 2000);
          // 3. The College Fit card follows the record: once the sync has
          //    landed (the server reads the profile it holds), re-read the
          //    shown school if a course, score, activity or major changed.
          refreshCollegeFit(data);
        } catch (err) { console.warn("RAG sync failed (non-blocking):", err?.message); setSyncNote(""); setSyncStatus("failed"); }
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [data, screen, user, passphrase, authedFetch, refreshCollegeFit]);

  // ─── Admissions-calendar refresh ───
  // Pull today + cycle calendar + per-target-school deadlines whenever the
  // target-schools list changes (or on entering chat). "Redone for every edit
  // to target schools." Best-effort; failures leave today-only awareness.
  const calTargetsKey = targetSchools.join("|");
  // The list the last calendar read was tuned for, as the server reports
  // it. The target list loads from storage after sign-in, so the first
  // read went out bare and a second followed when the list arrived; the
  // server resolves the saved schools itself when none are sent, so when
  // its answer already names the list, nothing is fetched again.
  const calendarTunedForRef = useRef(null);
  useEffect(() => {
    if (screen !== S.CHAT || !user) return;
    if (calendarTunedForRef.current != null && calendarTunedForRef.current === calTargetsKey) return;
    let alive = true;
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await authedFetch("/api/calendar/context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetSchools }),
          signal: ctrl.signal,
        });
        if (!r.ok) return;
        const body = await r.json();
        if (!alive) return;
        calendarTunedForRef.current = Array.isArray(body?.targetSchools) ? body.targetSchools.join("|") : calTargetsKey;
        setCalendarCtx(body);
      } catch (err) { if (alive) console.warn("[CALENDAR] fetch failed:", err?.message); }
    })();
    return () => { alive = false; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calTargetsKey, screen, user?.email]);

  // ─── SPONTANEOUS BACKEND → FRONTEND PULL ───
  // Poll /api/students/profile every 30s while on CHAT to surface server-side updates
  // (percentile recalculations, milestone awards, and freshly synced metrics).
  // Writes to `serverMetrics` — NEVER overwrites local profile to avoid clobbering edits.
  const [serverMetrics, setServerMetrics] = useState(null);
  // One-shot backend-profile recovery per chat-screen entry. If the
  // local vault is sparser than the backend (vault reset, new browser,
  // post-restart), adopt the durable backend data so courses/GPA/ECs
  // reappear in the sidebar without needing to open the editor.
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (screen !== S.CHAT || !user) { recoveredRef.current = false; return; }
    if (recoveredRef.current) return;
    recoveredRef.current = true;
    reconcileWithBackendProfile(data).catch(() => {});
  }, [screen, user, reconcileWithBackendProfile, data]);
  useEffect(() => {
    if (screen !== S.CHAT || !user) return;
    // Pull the student's saved chat threads whenever the chat screen
    // becomes active (auto-login restore, post-survey, login, etc.).
    refreshThreadList();
    const proxyUrl = window.__CC_PROXY_URL__;
    if (!proxyUrl) return;
    let cancelled = false;
    const pullFromServer = async () => {
      const token = window.__CC_SESSION_TOKEN__;
      if (!token) return;
      try {
        const base = proxyUrl.replace(/\/chat\/?$/,"");
        const r = await fetch(`${base}/students/profile`, {
          headers: { "Authorization": `Bearer ${token}` }
        });
        if (!r.ok || cancelled) return;
        const body = await r.json();
        if (cancelled) return;
        setServerMetrics({
          metrics: body.metrics || [],
          milestoneCount: body.milestoneCount || 0,
          lastUpdated: body.profile?.lastUpdated || null,
          pulledAt: Date.now(),
        });
        setOfflineMode(false); // reached the backend — we're back online
      } catch (err) {
        // Non-fatal — server may be offline, session may have expired
        console.warn("[sync-pull] Profile poll failed:", err?.message);
      }
    };
    // Pull immediately on mount, then every 30s
    pullFromServer();
    const iv = setInterval(pullFromServer, 30000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [screen, user]);

  // ─── SESSION TIMEOUT — auto-logout after 15min inactivity ───
  useEffect(() => {
    if (screen !== S.CHAT && screen !== S.SURVEY) { sessionTimer.clear(); setExpiryWarning(false); return; }
    const expire = () => {
      setExpiryWarning(false);
      clearSession();
      setUser(null);
      setPassphrase("");
      setData({ profile:null, activities:[], studyNotes:[], documents:[] });
      setMessages([]);
      setScreen(S.LOGIN);
      setLError("Session expired due to inactivity. Please sign in again.");
    };
    sessionTimer.reset(expire, setExpiryWarning);
    const activityEvents = ["mousedown","keydown","touchstart","scroll"];
    const onActivity = () => sessionTimer.reset();
    activityEvents.forEach(ev => window.addEventListener(ev, onActivity, { passive: true }));
    return () => {
      sessionTimer.clear();
      activityEvents.forEach(ev => window.removeEventListener(ev, onActivity));
    };
  }, [screen]);

  // One auth action at a time. PBKDF2 + the server round-trips make sign-in /
  // account creation take seconds (more on a cold backend), and the submit
  // buttons gave no feedback in that window — students double-clicked, which
  // ran two interleaved logins. The ref (not just state) blocks re-entry even
  // before React re-renders with the disabled button.
  const authBusyRef = useRef(false);
  const [authBusy, setAuthBusy] = useState(false);
  const runAuthGuarded = useCallback(async (fn, setErr) => {
    if (authBusyRef.current) return;
    authBusyRef.current = true;
    setAuthBusy(true);
    try { await fn(); }
    catch (err) {
      console.error("[auth] unexpected failure:", err);
      setErr("Something unexpected went wrong. Please try again.");
    }
    finally { authBusyRef.current = false; setAuthBusy(false); }
  }, []);

  const handleCreate = useCallback((...args) => handleCreateImpl({
      cAgeAttest, cConsentAI, cConsentData, cEmail, cFirst, cGrade,
      cLast, cName, cPass, cPass2, setCError, setLEmail,
      setPassphrase, setScreen, setStudentRecoveryCode, setSurveyStep, setUser,
    }, ...args), [cFirst, cLast, cEmail, cGrade, cPass, cPass2, cAgeAttest, cConsentAI, cConsentData]);

  // ─── LOGIN ───
  const [loginAttempts, setLoginAttempts] = useState({});
  const handleLogin = useCallback((...args) => handleLoginImpl({
      lEmail, lPass, loginAttempts, setData, setLError, setLoginAttempts,
      setMessages, setOfflineMode, setPassphrase, setScreen, setSurveyStep, setUser,
    }, ...args), [lEmail, lPass, loginAttempts]);

  const handleStudentRecovery = useCallback((...args) => handleStudentRecoveryImpl({
      lEmail, setLPass, setStudentRecoveryBusy, setStudentRecoveryInput, setStudentRecoveryMessage, setStudentRecoveryOpen,
      setStudentRecoveryPassword, studentRecoveryInput, studentRecoveryPassword,
    }, ...args), [lEmail, studentRecoveryInput, studentRecoveryPassword]);

  // ─── LOGOUT ───
  const handleLogout = useCallback(async () => {
    try { await authedFetch("/api/students/logout", { method: "POST" }); } catch { /* local logout still proceeds */ }
    await clearSession();
    sessionTimer.clear();
    rateLimiter.reset();
    window.__CC_SESSION_TOKEN__ = null;
    setUser(null);
    setPassphrase("");
    setData({ profile:null, activities:[], studyNotes:[], documents:[] });
    setMessages([]);
    setScreen(S.LOGIN);
  }, [authedFetch]);

  const handleExportData = useCallback(async () => {
    try {
      const response = await authedFetch("/api/students/export");
      if (!response.ok) throw new Error("Export failed");
      const body = await response.json();
      const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = makeExportFilename(user);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      window.alert(error?.message || "Export failed. Please try again.");
    }
  }, [authedFetch, user]);

  const handleDeleteAccount = useCallback(async () => {
    if (!window.confirm("Delete your account and all local and server data? This cannot be undone.")) return;
    const email = user?.email;
    if (!email) return;
    try {
      const response = await authedFetch("/api/students", { method: "DELETE" });
      if (!response.ok) throw new Error("The server did not confirm complete deletion.");
      await storageApi.delete(await storageKeyFor(email));
      await storageApi.delete(`cc_draft_${safeBtoa(email).replace(/[^a-zA-Z0-9]/g, "")}`);
      try { localStorage.removeItem(`cc_targets_${email}`); } catch {}
      await clearSession();
      sessionTimer.clear();
      rateLimiter.reset();
      window.__CC_SESSION_TOKEN__ = null;
      setUser(null);
      setPassphrase("");
      setData({ profile:null, activities:[], studyNotes:[], documents:[] });
      setMessages([]);
      setScreen(S.CREATE);
    } catch (error) {
      window.alert(error?.message || "Deletion failed. No local data was removed.");
    }
  }, [authedFetch, user?.email]);

  const handleSurveyComplete = useCallback((...args) => handleSurveyCompleteImpl({
      authedFetch, messages, sAPScores, sClassRank, sCourses, sECs,
      sGoals, sGpaUw, sGpaW, sMajorInterest, sNoGpaYet, sNoTestsYet,
      sTests, setData, setMessages, setScreen, setSurveyError, user,
    }, ...args), [sGpaUw, sGpaW, sNoGpaYet, sCourses, sAPScores, sTests, sNoTestsYet, sECs, sGoals, sMajorInterest, user, messages, authedFetch]);

  const send = useCallback((...args) => sendImpl({
      abortRef, activeThreadId, authedFetch, calendarCtx, chatFiles, chatTextareaRef,
      conveneStrategyCouncil, councilDecisionType, councilTurnSequenceRef, data, formatUserFacingError, input,
      inputRef, loading, locale, messages, newThread, pendingFile,
      persistTurn, refreshBudget, refreshThreadList, setAgentStatus, setChatFiles, setChatFilesExpanded,
      setCouncilDecisionType, setData, setInput, setLoading, setMessages, setPendingFile,
      targetSchools, toolSeq,
    }, ...args), [input, loading, data, pendingFile, chatFiles, messages, activeThreadId, newThread, persistTurn, calendarCtx, targetSchools, refreshBudget, authedFetch, refreshThreadList, councilDecisionType, conveneStrategyCouncil, locale]);

  const profile = data.profile || {};
  const activities = data.activities || [];

  // ═══════════════════════════════════════════════════════════
  // LOADING SCREEN
  // ═══════════════════════════════════════════════════════════
  if (screen === S.LOADING) {
    return (
      <main style={{ minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:BG,fontFamily:FONT,padding:"20px 0" }}>
        <div style={{ textAlign:"center" }}>
          <div style={{ display:"flex",justifyContent:"center",gap:6,marginBottom:16 }}>
            {dots.map((c,i)=>(<div key={i} style={{width:10,height:10,borderRadius:"50%",background:c,animation:`pulse2 1.4s ease-in-out ${i*0.12}s infinite`}} />))}
          </div>
          <div style={{ fontSize:14,color:"#6a6a7a" }}>Loading your vault...</div>
        </div>
        <style>{GLOBAL_CSS}</style>
      </main>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // CREATE ACCOUNT SCREEN
  // ═══════════════════════════════════════════════════════════
  if (screen === S.CREATE) {
    // Everything CreateAccountScreen reads from this component (see CreateAccountScreen.jsx).
    const createAccountProps = {
      authBusy, cAgeAttest, cConsentAI, cConsentData, cEmail, cError, cFirst, cGrade, cLast, cPass, cPass2, createPassStrength, handleCreate, runAuthGuarded, setCAgeAttest, setCConsentAI, setCConsentData, setCEmail, setCError, setCFirst, setCGrade, setCLast, setCPass, setCPass2, setScreen, setShowCreatePass, setShowCreatePass2, showCreatePass, showCreatePass2,
    };
    return (
      <CreateAccountScreen {...createAccountProps} />
    );
  }

  if (screen === S.SURVEY) {
    const STEPS = [
      { title:"GPA", sub:"What\'s your current GPA?", req:true },
      { title:"Transcript", sub:"Add courses by school year", req:true },
      { title:"Test scores & AP exams", sub:"Standardized tests and AP exam scores", req:true },
      { title:"Extracurriculars", sub:"Clubs, sports, volunteering, work, research", req:false },
      { title:"Goals", sub:"What are you aiming for?", req:true },
    ];
    const st = STEPS[surveyStep]||STEPS[0];
    const total = STEPS.length;

    const AP_COURSES = AP_EXAM_LIST;
    const RIGOR = { regular:"Standard",elective:"Elective (graduation requirement)",honors:"Honors (+0.5w)",ap:"AP (+1.0w, College-level)",ib:"IB (+1.0w)",dual_enrollment:"Dual Enrollment (+1.0w)" };
    const YEARS = SURVEY_YEARS;
    const ylbl = y => y.charAt(0).toUpperCase()+y.slice(1);
    const scoreHint = {sat:"400-1600",act:"1-36",psat:"320-1520",toefl:"0-120",ielts:"0-9.0",sat_subject:"200-800",duolingo:"10-160",clep:"20-80"};
    const testLimit = TEST_SCORE_LIMITS[sTestInput.test];
    const COURSE_GRADES = GRADE_SCALE.map(e => e.grade);

    const isFreshman = user?.grade === "Freshman" || user?.grade === "9th";
    const stepRequired = st.req && !(isFreshman && surveyStep <= 2);
    const formatApLabel = value => {
      const clean = String(value || "").trim();
      if (!clean) return "";
      return /^ap\s+/i.test(clean) ? clean : `AP ${clean}`;
    };
    const canProceed = () => {
      setSurveyError("");
      if (surveyStep===0 && !sNoGpaYet && !sGpaUw) { setSurveyError("Enter your GPA, or choose \"I don't have a GPA yet.\""); return false; }
      if (surveyStep===1 && Object.values(sCourses).flat().length===0) { setSurveyError("Add at least one course."); return false; }
      if (surveyStep===2 && !sNoTestsYet && sTests.length===0 && sAPScores.length===0) { setSurveyError("Add a test score, an AP exam score, or choose \"I haven't taken standardized tests yet.\""); return false; }
      if (surveyStep===4 && sGoals.length===0) { setSurveyError("Select at least one goal"); return false; }
      return true;
    };
    const nxt = () => { if (stepRequired && !canProceed()) return; setSurveyError(""); if (surveyStep<total-1) setSurveyStep(surveyStep+1); else handleSurveyComplete(); };
    const prv = () => { setSurveyError(""); if (surveyStep>0) setSurveyStep(surveyStep-1); };

    const MAX_ITEMS = 50; // prevent storage abuse
    const addCourse = () => {
      if (!sCourseInput.name.trim() || sCourseInput.name.length > 100) return;
      if (Object.values(sCourses).flat().length >= MAX_ITEMS) return;
      setSurveyError("");
      setSCourses(p=>({...p,[sCourseYear]:[...p[sCourseYear],{...sCourseInput,name:sCourseInput.name.trim().slice(0,100)}]}));
      setSCourseInput({name:"",type:sCourseInput.type,grade:"A",semester:sCourseInput.semester||"full_year"});
    };
    // Import a transcript file (PDF / image / DOCX): the backend extracts text
    // locally, parses courses on the small model tier, and returns them for
    // review here — nothing is saved until the student finishes the survey.
    // Courses whose grade couldn't be read arrive as "IP" so nothing is
    // fabricated; the note below tells the student to fix them.
    const importTranscript = async (file) => {
      if (!file || sImportBusy) return;
      setSurveyError(""); setSImportNote("");
      if (file.size > MAX_SCHOOL_FILE_SIZE_BYTES) { setSurveyError("File too large. Maximum 4MB."); return; }
      setSImportBusy(true);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        const postImport = () => authedFetch("/api/students/transcript-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64: btoa(binary), mimeType: file.type || "", filename: file.name || "transcript" }),
        });
        let r = await postImport();
        let body = await r.json().catch(() => ({}));
        // Accounts from older signup builds are missing the cross-border
        // consent row the backend requires before AI parsing. Re-grant the
        // onboarding consents the student accepted at signup, then retry once.
        if (r.status === 403 && body.code === "consent_required") {
          const missing = (Array.isArray(body.missing) ? body.missing : [])
            .filter((type) => ONBOARDING_CONSENT_TYPES.includes(type));
          await grantOnboardingConsents(missing.length ? missing : undefined);
          r = await postImport();
          body = await r.json().catch(() => ({}));
        }
        if (!r.ok) { setSurveyError(body.error || `Import failed (HTTP ${r.status})`); return; }

        // Merge outside the state updater (StrictMode double-invokes updaters).
        const merged = { ...sCourses };
        const existing = new Set(SURVEY_YEARS.flatMap(y => (merged[y] || []).map(c => y + ":" + c.name.toLowerCase())));
        let total = Object.values(merged).flat().length;
        let added = 0, skipped = 0;
        for (const [year, list] of Object.entries(body.courses || {})) {
          const targetYear = SURVEY_YEARS.includes(year) ? year : sCourseYear;
          for (const c of (Array.isArray(list) ? list : [])) {
            const name = String(c?.name || "").trim().slice(0, 100);
            const key = targetYear + ":" + name.toLowerCase();
            if (!name || existing.has(key) || total >= MAX_ITEMS) { skipped += 1; continue; }
            existing.add(key);
            merged[targetYear] = [...(merged[targetYear] || []), {
              name,
              type: c.type || "regular",
              grade: c.grade || "IP",
              semester: c.semester || "full_year",
            }];
            total += 1; added += 1;
          }
        }
        setSCourses(merged);
        if (body.gpa != null && !sGpaUw) setSGpaUw(String(body.gpa));

        const notes = [`Imported ${added} course${added === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped — duplicates or over the ${MAX_ITEMS}-course cap)` : ""}.`];
        if (body.gpa != null) notes.push(`Transcript GPA: ${body.gpa}.`);
        if (Array.isArray(body.warnings) && body.warnings.length) notes.push(body.warnings.join(" "));
        notes.push("Double-click any course chip to fix its name, rigor, or grade before continuing.");
        setSImportNote(notes.join(" "));
      } catch (err) {
        setSurveyError(err?.message || "Transcript import failed");
      } finally {
        setSImportBusy(false);
      }
    };
    // The catalog validates the total's range and step, each section's
    // range and step, and that the sections agree with the total (SAT
    // sections add up; ACT sections average to the composite).
    const addTest = () => {
      if (!sTestInput.totalScore || sTests.length >= MAX_ITEMS) return;
      const entry = formToEntry(sTestInput);
      const check = validateTestEntry(entry);
      if (!check.ok) { setSurveyError(check.errors[0]); return; }
      setSurveyError("");
      setSNoTestsYet(false);
      setSTests(p=>[...p, entryToForm(entry)]);
      setSTestInput(blankTestForm(sTestInput.test));
    };
    const addAP = () => { if (!sAPInput.subject || sAPScores.length >= MAX_ITEMS) return; setSAPScores(p=>[...p,{...sAPInput}]); setSAPInput({subject:"",score:"5",year:sAPInput.year}); };

    const addEC = () => {
      if (!sECInput.name.trim() || !sECInput.role.trim()) return;
      if (sECInput.name.length > 100 || sECInput.role.length > 100) return;
      if (sECs.length >= MAX_ITEMS) return;
      setSECs(p => [...p, {
        ...sECInput,
        name: sECInput.name.trim().slice(0, 100),
        role: sECInput.role.trim().slice(0, 100),
        // Mirror the Common App's Activities section: 150-char hard cap.
        description: (sECInput.description || "").trim().slice(0, 150),
      }]);
      setSECInput({ name:"", category:"academic", role:"", hoursPerWeek:"", weeksPerYear:"", description:"", grades:[], timing:"school_year" });
    };

    const chip = (s,fn,l) => (<button key={typeof l === "string" ? l : undefined} onClick={fn} style={{padding:"8px 14px",borderRadius:20,border:`1px solid ${s?"rgba(55,138,221,0.5)":"rgba(255,255,255,0.08)"}`,background:s?"rgba(55,138,221,0.12)":"rgba(255,255,255,0.02)",color:s?"#63b3ed":"#8a8a9a",fontSize:12,fontWeight:s?600:400,cursor:"pointer",transition:"all 0.15s"}}>{l}</button>);
    const pill = (t,rm,bg) => (<div key={typeof t === "string" ? t : undefined} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:8,background:bg||"rgba(55,138,221,0.08)",border:`1px solid ${bg?"rgba(255,255,255,0.08)":"rgba(55,138,221,0.15)"}`,fontSize:11,color:bg?"#e8e6e3":"#63b3ed",margin:"0 5px 5px 0"}}>{t}<button onClick={rm} style={{background:"none",border:"none",color:bg?"#aaa":"#6a8ab5",cursor:"pointer",fontSize:12,padding:0}}>{"\u2715"}</button></div>);
    // System-theme-matched <select> styling. `appearance: none` strips the
    // OS chevron so we can paint our own (SVG data URI in the rgba dark
    // palette). `colorScheme: "dark"` tells the browser to render the
    // OPEN popup list using the dark scheme — Chrome / Firefox / Safari
    // all honor this, which is the cleanest cross-browser way to dark-
    // mode the native popup without a custom dropdown component.
    const sl = {
      ...inputStyle,
      cursor: "pointer",
      colorScheme: "dark",
      appearance: "none",
      WebkitAppearance: "none",
      MozAppearance: "none",
      paddingRight: 32,
      backgroundImage:
        "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1L6 6L11 1' stroke='%236a8ab5' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "right 12px center",
      backgroundSize: "10px 6px",
    };
    const tab = (a,fn,l,cnt) => (<button key={typeof l === "string" ? l : undefined} onClick={fn} style={{padding:"8px 14px",borderRadius:"8px 8px 0 0",border:"none",borderBottom:a?"2px solid #378ADD":"2px solid transparent",background:a?"rgba(55,138,221,0.08)":"transparent",color:a?"#63b3ed":"#6a6a7a",fontSize:12,fontWeight:a?600:400,cursor:"pointer"}}>{l}{cnt!==undefined?` (${cnt})`:""}</button>);

    // Everything SurveyScreen reads from this component (see SurveyScreen.jsx).
    const surveyProps = {
      AP_COURSES, COURSE_GRADES, EXPIRY_NOTICE, RIGOR, STEPS, YEARS, addAP, addCourse, addEC, addTest, chip, dismissedNotice, expiryWarning, formatApLabel, importTranscript, isFreshman, locale, nxt, pill, prv, sAPInput, sAPScores, sClassRank, sCourseInput, sCourseYear, sCourses, sECInput, sECs, sGoals, sGpaUw, sGpaW, sImportBusy, sImportNote, sMajorInterest, sNoGpaYet, sNoTestsYet, sTestCategory, sTestInput, sTests, scoreHint, setDismissedNotice, setSAPInput, setSAPScores, setSClassRank, setSCourseInput, setSCourseYear, setSCourses, setSECInput, setSECs, setSGoals, setSGpaUw, setSGpaW, setSNoGpaYet, setSNoTestsYet, setSTestCategory, setSTestInput, setSTests, setStudentRecoveryCode, setSurveyError, setSurveyStep, setsMajorInterest, sl, st, stepRequired, studentRecoveryCode, surveyError, surveyStep, tab, testLimit, total, user, ylbl,
    };
    return (
      <SurveyScreen {...surveyProps} />
    );
  }

  // ═══════════════════════════════════════════════════════════
  // LOGIN SCREEN
  // ═══════════════════════════════════════════════════════════
  if (screen === S.LOGIN) {
    // Everything LoginScreen reads from this component (see LoginScreen.jsx).
    const loginProps = {
      authBusy, handleLogin, handleStudentRecovery, lEmail, lError, lPass, runAuthGuarded, setLEmail, setLError, setLPass, setScreen, setShowLoginPass, setStudentRecoveryInput, setStudentRecoveryMessage, setStudentRecoveryOpen, setStudentRecoveryPassword, showLoginPass, studentRecoveryBusy, studentRecoveryInput, studentRecoveryMessage, studentRecoveryOpen, studentRecoveryPassword,
    };
    return (
      <LoginScreen {...loginProps} />
    );
  }

  // ═══════════════════════════════════════════════════════════
  // CHAT SCREEN
  // ═══════════════════════════════════════════════════════════
  // Everything the sidebar reads from this component (see Sidebar.jsx).
  const sidebarProps = {
    activeThreadId, activities, addTargetSchool, beginEdit, budgetStatus, collegePositioning, collegePositioningLoading, collegeValues, collegeValuesHint, collegeValuesLoading, collegeValuesQuery, collegeVerification, collegeVerifying, commitProfile, data, deleteThread, draftA, draftB, editECFromProfile, editingField, evidenceVersion, expandedEC, handleDeleteAccount, handleLogout, locale, lookupCollege, newThread, openProfileEditor, openThread, profile, removeTargetSchool, renameThreadTitle, renamingThreadId, searchThreads, setActivePanel, setCollegeValues, setCollegeValuesHint, setCollegeValuesQuery, setData, setDraftA, setDraftB, setEditingField, setEvidenceVersion, setExpandedEC, setLocale, setRenamingThreadId, setShowAllCourses, setShowAllECs, setTargetSchoolInput, setThreadSearchQ, setThreadSearchResults, showAllCourses, showAllECs, setSidebarOpen, sidebarOpen, targetSchoolInput, targetSchools, threadList, threadSearchQ, threadSearchResults, user, verifyCollegeFit,
  };
  // Everything ChatScreen reads from this component (see ChatScreen.jsx).
  const chatProps = {
    agentStatus, budgetStatus, cancelPendingRequest, chatEnd, chatFiles, chatFilesExpanded, chatTextareaRef, clearChatFiles, councilDecisionType, deadlineRefreshKey, dismissTool, fileInputRef, folderInputRef, handleChatFilesSelect, handleExportData, importParsedTranscript, input, inputRef, loading, locale, messages, narrativeVersion, openTool, parseTranscriptText, pendingFile, removeChatFile, send, setChatFilesExpanded, setCouncilDecisionType, setInput, setNarrativeVersion, setPendingFile, setSNarrativeSaved, setSidebarOpen, sidebarOpen, targetSchools, user,
  };
  return (
    <div style={{ display:"flex",height:"100dvh",fontFamily:FONT,background:BG,color:"#e8e6e3" }}>
      {/* Non-blocking session-health toast (offline / re-auth / background-sync status). */}
      {/* Its × hides the current notice only; a different notice still shows.       */}
      {(() => {
        const notice = expiryWarning ? EXPIRY_NOTICE
          : reauthStatus === "attempting" ? "Reconnecting to your counselor…"
          : reauthStatus === "failed" ? "Session expired — sign out and sign in again."
          : offlineMode ? "Offline — your data is safe on this device. Counseling features resume when you reconnect."
          : syncStatus === "failed" ? (syncNote || "Last change didn't sync — will retry.")
          : null;
        if (!notice || notice === dismissedNotice) return null;
        return (
        <div role="status" aria-live="polite" style={{
          position:"fixed", top:12, left:"50%", transform:"translateX(-50%)", zIndex:9999,
          padding:"8px 14px", borderRadius:10, fontSize:12, fontWeight:600, boxShadow:"0 4px 16px rgba(0,0,0,0.3)",
          background: expiryWarning ? "rgba(246,173,85,0.22)" : reauthStatus==="failed" ? "rgba(245,101,101,0.15)" : (offlineMode || syncStatus==="failed") ? "rgba(246,173,85,0.15)" : "rgba(99,179,237,0.15)",
          border:`1px solid ${expiryWarning ? "rgba(246,173,85,0.55)" : reauthStatus==="failed" ? "rgba(245,101,101,0.4)" : (offlineMode || syncStatus==="failed") ? "rgba(246,173,85,0.4)" : "rgba(99,179,237,0.4)"}`,
          color: expiryWarning ? "#fbd38d" : reauthStatus==="failed" ? "#fc8181" : (offlineMode || syncStatus==="failed") ? "#f6ad55" : "#63b3ed",
          display:"flex", alignItems:"center", gap:10,
        }}>
          <span>{notice}</span>
          <CloseButton label={tt(locale, "chat.modal.close")} onClick={() => setDismissedNotice(notice)} size={22} style={{ marginRight:-6 }} />
        </div>
        );
      })()}
      {/* Sidebar */}
      <Sidebar {...sidebarProps} />

      {/* Main */}
      <ChatScreen {...chatProps} />

      {/* ─── Round 1-5 modal panels ───────────────────────────────────── */}
      {/* Single overlay slot rendered when activePanel is set. The panel  */}
      {/* itself is just a centered card; backdrop click + close button    */}
      {/* both clear activePanel. The components do their own data fetch / */}
      {/* save calls — we just provide the locale and a navigation handler.*/}
      {activePanel && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setActivePanel(null); }}
          style={{
            position:"fixed", inset:0, zIndex:1100,
            background:"rgba(5,8,14,0.78)",
            display:"flex", alignItems:"center", justifyContent:"center",
            padding:20,
          }}
        >
          <div ref={modalRef} role="dialog" aria-modal="true" aria-label={activePanel} style={{
            width:"min(720px, 100%)",
            maxHeight:"min(86vh, 900px)",
            overflowY:"auto",
            padding:24,
            borderRadius:16,
            background:"#101522",
            border:"1px solid rgba(255,255,255,0.08)",
            display:"flex", flexDirection:"column", gap:14,
          }}>
            <div style={{ display:"flex", justifyContent:"flex-end", margin:"-8px -8px 0 0" }}>
              <CloseButton label={tt(locale, "chat.modal.close")} onClick={() => setActivePanel(null)} />
            </div>
            {/* narrative / candidates / spike / courses now render INLINE in */}
            {/* the chat (role:"tool" cards). Only deadlines here. */}
            {activePanel === "deadlines" && (
              <DeadlineTracker locale={locale} refreshKey={deadlineRefreshKey} />
            )}
            {activePanel === "disclosure" && (
              <DisclosurePanel locale={locale} />
            )}
            {activePanel === "methodology" && (
              <MethodologyPanel embedded locale={locale} />
            )}
          </div>
        </div>
      )}

      <style>{GLOBAL_CSS}</style>
    </div>
  );
}
