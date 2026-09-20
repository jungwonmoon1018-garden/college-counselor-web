// survey-handlers.js — finishing the survey, hydrating it from saved data,
// reconciling with the backend profile and editing an activity from the
// profile. App() keeps each hook and its dependency array and calls these with the
// render's bindings as `ctx`. Moved out of App.jsx on 2026-09-20.
import { normalizeClassRank, formToEntry, blankTestForm, entryToForm } from "./test-scores.js";
import { S } from "./app-shared.js";
import { storageApi, safeBtoa } from "./vault-storage.js";

// ─── COMPLETE SURVEY → build profile → go to chat ───
export async function handleSurveyComplete(ctx) {
  const {
    authedFetch, messages, sAPScores, sClassRank, sCourses, sECs,
    sGoals, sGpaUw, sGpaW, sMajorInterest, sNoGpaYet, sNoTestsYet,
    sTests, setData, setMessages, setScreen, setSurveyError, user,
  } = ctx;
  // Flatten per-year courses into one array with year tags
  const allCourses = [];
  for (const [year, courses] of Object.entries(sCourses)) {
    for (const c of courses) allCourses.push({ ...c, year });
  }
  const profile = {
    gpa: sNoGpaYet ? null : (sGpaUw ? { unweighted: parseFloat(sGpaUw), weighted: sGpaW ? parseFloat(sGpaW) : undefined } : null),
    gpaStatus: sNoGpaYet ? "pending" : undefined,
    classRank: normalizeClassRank(sClassRank) || undefined,
    courses: allCourses,
    apScores: sAPScores.map(a => ({ exam: a.subject, score: parseInt(a.score), year: parseInt(a.year) })),
    // Every test keeps its section scores (SAT and PSAT Reading & Writing
    // and Math, ACT English/Math/Reading/Science, TOEFL, IELTS, Duolingo).
    testScores: sTests.map(t => formToEntry(t)),
    testingStatus: sNoTestsYet ? "planned" : undefined,
    majorInterest: sMajorInterest || undefined
  };
  const activities = sECs.map(ec => ({ ...ec, hoursPerWeek: ec.hoursPerWeek ? parseFloat(ec.hoursPerWeek) : undefined, id: crypto.randomUUID() }));

  setData(prev => ({
    ...prev, profile, activities, surveyCompleted: true, goals: sGoals, majorInterest: sMajorInterest,
    documents: (prev.documents || []).filter(doc => doc?.source !== "survey_transcript"),
  }));

  const sum = [];
  if (profile.gpa) sum.push(`GPA: ${profile.gpa.unweighted}${profile.gpa.weighted ? ` / ${profile.gpa.weighted}w` : ""}`);
  else if (sNoGpaYet) sum.push("GPA: not yet available");
  if (allCourses.length) {
    const apCount = allCourses.filter(c => c.type === "ap").length;
    sum.push(`${allCourses.length} courses${apCount ? ` (${apCount} AP)` : ""}`);
  }
  if (profile.apScores.length) sum.push(`${profile.apScores.length} AP exam scores`);
  if (profile.testScores.length) sum.push(profile.testScores.map(t => `${t.test.toUpperCase()}${t.subject?` ${t.subject}`:""}: ${t.totalScore}`).join(", "));
  else if (sNoTestsYet) sum.push("Test scores: not taken yet");
  if (activities.length) sum.push(`${activities.length} activities`);

  // ── Link onboarding to the AI counselor ──
  // Persist the profile to the backend FIRST (blocking) so the counselor
  // actually has the student's data, and confirm the AI session is ready,
  // BEFORE entering chat. A failed sync keeps the student on the survey with
  // a retry message instead of dropping them into a chat the backend knows
  // nothing about. (Skipped entirely in offline/local-only mode.)
  const proxyUrl = window.__CC_PROXY_URL__;
  if (proxyUrl) {
    try {
      await authedFetch("/api/students/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, activities, goals: sGoals, majorInterest: sMajorInterest, trigger: "survey_complete" }),
      });
    } catch {
      setSurveyError("Couldn't save your profile to your counselor — check your connection and try again.");
      return; // stay on the survey; do NOT enter a chat the backend can't back
    }
  }

  // FIX P2: Only reset messages on FIRST setup. If editing from chat, append an update
  // summary instead of wiping the entire conversation history.
  const isEditFromChat = messages.length > 1; // If there's an existing conversation, this is an edit
  const updateMsg = {
    role: "assistant",
    content: isEditFromChat
      ? `Profile updated! Here's what changed:\n\n${sum.length ? sum.join("\n") : "No changes detected."}\n${sMajorInterest ? `\nInterested in: ${sMajorInterest}` : ""}${sGoals.length ? `\nGoals: ${sGoals.join(", ")}` : ""}\n\nWhat would you like to work on next?`
      : `✓ Connected to your AI counselor — your profile is saved and synced.\n\nHere's what I have:\n\n${sum.length ? sum.join("\n") : "No data entered yet — that's okay, we can add things as we go."}\n${sMajorInterest ? `\nInterested in: ${sMajorInterest}` : ""}${sGoals.length ? `\nGoals: ${sGoals.join(", ")}` : ""}\n\nBefore we dive in — tell me a bit about yourself. What drives you? What's a challenge you've worked through, or something you're genuinely proud of? This helps me understand you beyond the numbers.\n\nYou can also upload report cards or score reports with 📎.`
  };

  if (isEditFromChat) {
    // Preserve existing conversation, append update summary
    setMessages(prev => [...prev, updateMsg]);
  } else {
    // First-time setup: start fresh
    setMessages([updateMsg]);
  }

  if (user?.email) {
    // Cache a flag so the chat system knows to collect the student's story
    try { localStorage.setItem("cc_narrative_pending_" + user.email, "1"); } catch { /* ignore */ }
    // Survey is committed — drop the interrupted-draft autosave so it can't
    // rehydrate stale entries next time.
    storageApi.delete(`cc_draft_${safeBtoa(user.email).replace(/[^a-zA-Z0-9]/g, "")}`);
  }

  setScreen(S.CHAT);
}

// Hydrate the survey form fields from a `data`-shaped source. Defaults
// to the live `data` state, but callers can pass an explicit source
// (e.g. a freshly-pulled backend profile) to avoid a setState race.
export function hydrateSurveyFromCurrentData(ctx, src) {
  const {
    data, setSAPInput, setSAPScores, setSClassRank, setSCourseInput, setSCourseYear,
    setSCourses, setSECInput, setSECs, setSGoals, setSGpaUw, setSGpaW,
    setSNoGpaYet, setSNoTestsYet, setSTestCategory, setSTestInput, setSTests, setSurveyError,
    setsMajorInterest,
  } = ctx;
  const d = src || data;
  const groupedCourses = { freshman:[], sophomore:[], junior:[], senior:[] };
  for (const course of d.profile?.courses || []) {
    const year = groupedCourses[course.year] ? course.year : "freshman";
    groupedCourses[year].push({
      name: course.name || "",
      type: course.type || "regular",
      grade: course.grade === "In Progress" ? "IP" : (course.grade || "A"),
      semester: course.semester || "full_year"
    });
  }
  setSGpaUw(d.profile?.gpa?.unweighted != null ? String(d.profile.gpa.unweighted) : "");
  setSGpaW(d.profile?.gpa?.weighted != null ? String(d.profile.gpa.weighted) : "");
  setSNoGpaYet(Boolean(d.profile?.gpaStatus === "pending"));
  const rank = d.profile?.classRank || {};
  setSClassRank({
    rank: rank.rank != null ? String(rank.rank) : "",
    size: rank.size != null ? String(rank.size) : "",
    topPercent: rank.topPercent != null && rank.rank == null ? String(rank.topPercent) : "",
  });
  setSCourses(groupedCourses);
  setSCourseYear("freshman");
  setSCourseInput({ name:"", type:"regular", grade:"A", semester:"full_year" });
  setSTests((d.profile?.testScores || []).map(t => entryToForm(t)));
  setSNoTestsYet(Boolean(d.profile?.testingStatus === "planned"));
  setSTestCategory("sat");
  setSTestInput(blankTestForm("sat"));
  setSAPScores((d.profile?.apScores || []).map(a => ({
    subject: a.exam || a.subject || "",
    score: String(a.score ?? 5),
    year: String(a.year || new Date().getFullYear())
  })));
  setSAPInput({ subject:"", score:"5", year:String(new Date().getFullYear()) });
  setSECs((d.activities || []).map(a => ({
    name: a.name || "",
    category: a.category || "club",
    role: a.role || "",
    hoursPerWeek: a.hoursPerWeek != null ? String(a.hoursPerWeek) : "",
    weeksPerYear: a.weeksPerYear != null ? String(a.weeksPerYear) : "",
    description: a.description || "",
    grades: Array.isArray(a.grades) ? a.grades : [],
    timing: a.timing || "school_year",
  })));
  setSECInput({ name:"", category:"academic", role:"", hoursPerWeek:"", weeksPerYear:"", description:"", grades:[], timing:"school_year" });
  setSGoals([...(d.goals || [])]);
  setsMajorInterest(d.majorInterest || d.profile?.majorInterest || "");
  setSurveyError("");
}

// Pull the canonical profile from the backend and reconcile it with
// local `data`. The backend DB is the durable source of truth —
// grades/GPA/ECs live there and survive restarts + device changes.
// If the local vault is sparser than the backend (e.g. it was reset,
// or this is a different browser), adopt the backend's richer data so
// the student never sees an empty transcript when their courses are
// safely stored server-side. Local edits are preserved when local is
// the richer side. Returns the reconciled `data`-shaped object.
export async function reconcileWithBackendProfile(ctx, base = ctx.data) {
  const {
    authedFetch, data, setData,
  } = ctx;
  try {
    const r = await authedFetch("/api/students/profile");
    if (!r.ok) return base;
    const body = await r.json();
    const bp = body.profile || {};
    const localCourses = base.profile?.courses || [];
    const localEcs = base.activities || [];
    const beCourses = bp.courses || [];
    const beEcs = bp.activities || [];
    // Prefer whichever side has MORE entries (backend recovery when
    // local is empty; keep local when the student just added rows
    // that haven't synced yet).
    const courses = beCourses.length > localCourses.length ? beCourses : localCourses;
    const activities = beEcs.length > localEcs.length ? beEcs : localEcs;
    const merged = {
      ...base,
      profile: {
        ...(base.profile || {}),
        gpa: base.profile?.gpa?.unweighted != null ? base.profile.gpa : (bp.gpa || base.profile?.gpa),
        classRank: base.profile?.classRank || bp.classRank || null,
        courses,
        apScores: (base.profile?.apScores?.length ? base.profile.apScores : bp.apScores) || [],
        testScores: (base.profile?.testScores?.length ? base.profile.testScores : bp.testScores) || [],
        majorInterest: base.profile?.majorInterest || bp.majorInterest || "",
      },
      activities,
      goals: (base.goals?.length ? base.goals : bp.goals) || [],
      majorInterest: base.majorInterest || bp.majorInterest || "",
    };
    // Push the reconciled view back into app state so the chat
    // sidebar + auto-save reflect the recovered data too.
    if (courses.length !== localCourses.length || activities.length !== localEcs.length) {
      setData(merged);
      console.info(`[profile-recover] Adopted backend data — courses ${localCourses.length}→${courses.length}, ECs ${localEcs.length}→${activities.length}`);
    }
    return merged;
  } catch (err) {
    console.warn("[profile-recover] backend pull failed:", err?.message);
    return base;
  }
}

// Double-click an EC in the Profile sidebar → open the survey EC
// step (3) with that activity pre-loaded into the edit form, and
// removed from the saved list so re-adding doesn't duplicate it.
// The student tweaks any field and clicks "Add EC" to save.
export function editECFromProfile(ctx, activity) {
  const {
    hydrateSurveyFromCurrentData, setSECInput, setSECs, setScreen, setSidebarOpen, setSurveyStep,
  } = ctx;
  hydrateSurveyFromCurrentData();
  const key = a => `${(a?.name||"").toLowerCase().trim()}|${(a?.role||"").toLowerCase().trim()}`;
  const target = key(activity);
  // Pull the clicked activity into the input form…
  setSECInput({
    name: activity.name || "",
    category: activity.category || "club",
    role: activity.role || "",
    hoursPerWeek: activity.hoursPerWeek != null ? String(activity.hoursPerWeek) : "",
    weeksPerYear: activity.weeksPerYear != null ? String(activity.weeksPerYear) : "",
    description: activity.description || "",
    grades: Array.isArray(activity.grades) ? [...activity.grades] : [],
    timing: activity.timing || "school_year",
  });
  // …and drop it from the list hydrate just populated (runs after
  // hydrate's setSECs because both are queued in order).
  setSECs(prev => prev.filter(e => key(e) !== target));
  setSurveyStep(3);
  setScreen(S.SURVEY);
  setSidebarOpen(false);
  setTimeout(() => {
    const el = document.querySelector('input[placeholder="Activity name"]');
    if (el?.scrollIntoView) { el.scrollIntoView({ behavior:"smooth", block:"center" }); try { el.focus(); } catch {} }
  }, 60);
}
