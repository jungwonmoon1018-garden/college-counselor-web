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
import "./profile/fit-refresh.js";
import "./profile/dates.js";
import { TEST_SCORE_LIMITS, validateTestEntry, blankTestForm, entryToForm, formToEntry } from "./profile/test-scores.js";
import "./profile/strategy-council.js";
import Sidebar from "./screens/Sidebar.jsx";
import { AP_EXAM_LIST, GRADE_SCALE } from "./app-shared.js";
import SurveyScreen from "./screens/SurveyScreen.jsx";
import { BG, FONT, GLOBAL_CSS, inputStyle } from "./app-shared.js";
import LoginScreen from "./screens/LoginScreen.jsx";
import { S, dots } from "./app-shared.js";
import CreateAccountScreen from "./screens/CreateAccountScreen.jsx";
import "./session/vault-storage.js";
import { ONBOARDING_CONSENT_TYPES, grantOnboardingConsents } from "./session/server-session.js";
import "./profile/profile-analysis.js";
import { MAX_SCHOOL_FILE_SIZE_BYTES } from "./chat/chat-files.js";
import { _tryReAuth } from "./chat/chat-client.js";
import "./chat/markdown.jsx";
import "./chat/chat-orchestrator.js";
import ChatScreen from "./screens/ChatScreen.jsx";
import { send as sendImpl } from "./handlers/chat-send.js";
import "./handlers/auth-handlers.js";
import { handleSurveyComplete as handleSurveyCompleteImpl, hydrateSurveyFromCurrentData as hydrateSurveyFromCurrentDataImpl, reconcileWithBackendProfile as reconcileWithBackendProfileImpl, editECFromProfile as editECFromProfileImpl } from "./handlers/survey-handlers.js";
import { createDeadlinesForSchool as createDeadlinesForSchoolImpl, conveneStrategyCouncil as conveneStrategyCouncilImpl } from "./handlers/school-handlers.js";
import { useCreateAccountForm } from "./hooks/useCreateAccountForm.js";
import { useSurveyForm } from "./hooks/useSurveyForm.js";
import { useLoginForm } from "./hooks/useLoginForm.js";
import { useChatThreads } from "./hooks/useChatThreads.js";
import { useCollegeFit } from "./hooks/useCollegeFit.js";
import { useSessionLifecycle } from "./hooks/useSessionLifecycle.js";
import { useChatTools } from "./hooks/useChatTools.js";
import { useAuthHandlers } from "./hooks/useAuthHandlers.js";
import { useChatFiles } from "./hooks/useChatFiles.js";


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

  const {
    cAgeAttest, cConsentAI, cConsentData, cEmail, cError, cFirst,
    cGrade, cLast, cName, cPass, cPass2, setCAgeAttest,
    setCConsentAI, setCConsentData, setCEmail, setCError, setCFirst, setCGrade,
    setCLast, setCPass, setCPass2, setShowCreatePass, setShowCreatePass2, showCreatePass,
    showCreatePass2,
  } = useCreateAccountForm();

  const {
    sAPInput, sAPScores, sClassRank, sCourseInput, sCourseYear, sCourses,
    sECInput, sECs, sGoals, sGpaUw, sGpaW, sImportBusy,
    sImportNote, sMajorInterest, sNoGpaYet, sNoTestsYet, sTestCategory, sTestInput,
    sTests, setSAPInput, setSAPScores, setSClassRank, setSCourseInput, setSCourseYear,
    setSCourses, setSECInput, setSECs, setSGoals, setSGpaUw, setSGpaW,
    setSImportBusy, setSImportNote, setSNoGpaYet, setSNoTestsYet, setSTestCategory, setSTestInput,
    setSTests, setSurveyError, setSurveyStep, setsMajorInterest, surveyError, surveyStep,
  } = useSurveyForm();
  const {
    lEmail, lError, lPass, setLEmail, setLError, setLPass,
    setShowLoginPass, setStudentRecoveryBusy, setStudentRecoveryCode, setStudentRecoveryInput, setStudentRecoveryMessage, setStudentRecoveryOpen,
    setStudentRecoveryPassword, showLoginPass, studentRecoveryBusy, studentRecoveryCode, studentRecoveryInput, studentRecoveryMessage,
    studentRecoveryOpen, studentRecoveryPassword,
  } = useLoginForm();

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
  // Observable session health: re-auth + background-sync status for non-blocking toasts.
  const [reauthStatus, setReauthStatus] = useState("idle"); // idle | attempting | ok | failed
  const [syncStatus, setSyncStatus] = useState("idle");     // idle | ok | failed
  const [syncNote, setSyncNote] = useState("");             // overrides the default "didn't sync" toast text
  // True during the last minute before the inactivity sign-out — rendered as a
  // prominent toast so the auto-lock never silently eats a drafted message.
  const [expiryWarning, setExpiryWarning] = useState(false);
  // The session notice the student closed with its ×: that exact notice
  // stays hidden, a different one shows again.
  const [dismissedNotice, setDismissedNotice] = useState("");
  // Offline-first: true when the vault unlocked locally but the backend was
  // unreachable at sign-in. The student keeps full access to their on-device
  // data; server features (chat, sync) resume when the backend returns. Cleared
  // on the next successful server contact.
  const [offlineMode, setOfflineMode] = useState(false);

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
  // locale drives both static frontend strings AND the locale param sent to
  // the backend (so server-side friendlyMessage / friendlyLegendI18n come
  // back in the right language). Persisted to localStorage so reloads stick.
  // Declared here, ahead of the fit lookups that send it.
  const [locale, setLocaleState] = useState(detectLocale());
  const {
    addTargetSchool, authedFetchRef, collegePositioning, collegePositioningLoading, collegeValues, collegeValuesHint,
    collegeValuesLoading, collegeValuesQuery, collegeVerification, collegeVerifying, createDeadlinesRef, deadlineRefreshKey,
    lookupCollege, lookupCollegeRef, refreshCollegeFit, removeTargetSchool, setCollegeValues, setCollegeValuesHint,
    setCollegeValuesQuery, setTargetSchoolInput, targetSchoolInput, targetSchools, verifyCollegeFit,
  } = useCollegeFit({
    data, locale, user,
  });

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

  const {
    activeThreadId, deleteThread, newThread, openThread, persistTurn, refreshThreadList,
    renameThreadTitle, renamingThreadId, searchThreads, setRenamingThreadId, setThreadSearchQ, setThreadSearchResults,
    threadList, threadSearchQ, threadSearchResults,
  } = useChatThreads({
    authedFetch, setMessages, setSyncNote, setSyncStatus,
  });


  lookupCollegeRef.current = lookupCollege;



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

  const {
    dismissTool, openTool, toolSeq,
  } = useChatTools({
    messages, setMessages,
  });

  const [sidebarOpen, setSidebarOpen] = useState(false);
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

  const {
    chatFiles, chatFilesExpanded, clearChatFiles, handleChatFilesSelect, pendingFile, removeChatFile,
    setChatFiles, setChatFilesExpanded, setPendingFile,
  } = useChatFiles({
    setMessages,
  });

  const {
    EXPIRY_NOTICE,
  } = useSessionLifecycle({
    authedFetch, data, passphrase, reconcileWithBackendProfile, refreshCollegeFit, refreshThreadList,
    screen, setCalendarCtx, setData, setExpiryWarning, setLError, setMessages,
    setOfflineMode, setPassphrase, setReauthStatus, setScreen, setSyncNote, setSyncStatus,
    setUser, targetSchools, user,
  });

  const {
    authBusy, handleCreate, handleDeleteAccount, handleExportData, handleLogin, handleLogout,
    handleStudentRecovery, runAuthGuarded,
  } = useAuthHandlers({
    authedFetch, cAgeAttest, cConsentAI, cConsentData, cEmail, cFirst,
    cGrade, cLast, cName, cPass, cPass2, lEmail,
    lPass, makeExportFilename, setCError, setData, setLEmail, setLError,
    setLPass, setMessages, setOfflineMode, setPassphrase, setScreen, setStudentRecoveryBusy,
    setStudentRecoveryCode, setStudentRecoveryInput, setStudentRecoveryMessage, setStudentRecoveryOpen, setStudentRecoveryPassword, setSurveyStep,
    setUser, studentRecoveryInput, studentRecoveryPassword, user,
  });

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
