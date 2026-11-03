// survey-handlers.js — finishing the survey, hydrating it from saved data,
// reconciling with the backend profile and editing an activity from the
// profile. App() keeps each hook and its dependency array and calls these with the
// render's bindings as `ctx`. Moved out of App.jsx on 2026-09-20.
import { normalizeClassRank, formToEntry, blankTestForm, entryToForm, entryLabel } from "../profile/test-scores.js";
import { describeSetAside, syncFailureMessage } from "../profile/sync-result.js";
import { setAsideRowsFrom } from "../profile/set-aside-rows.js";
import { S } from "../app-shared.js";
import { latestApScoreYear } from "../profile/ap-entry.js";
import { storageApi, safeBtoa } from "../session/vault-storage.js";
import { safeSet } from "../session/safe-storage.js";
import { formatGpa, hasGpa } from "../profile/gpa.js";
import { baseFromPayload, buildSyncPayload, describeProfileConflict, readServerProfile, reconcileProfile } from "../profile/profile-reconcile.js";

// The school years the survey has a tab for, and the bucket for a course
// saved without one of them. Such courses used to be filed as freshman on
// the way into the editor and saved that way on Finish, which moved them
// into 9th grade for the senior-rigor read.
export const SURVEY_YEAR_KEYS = ["freshman", "sophomore", "junior", "senior"];
export const UNPLACED_YEAR = "unplaced";

// What the editor holds for a value the record does not have is nothing:
// the editor used to fill a blank course grade with "A", a year-less AP exam
// with the current calendar year and a missing activity category with the
// legacy "club", and Finish saved them as the student's own record, where the
// profile-fidelity check then held the counselor to them.
const present = (value) => value != null && value !== "";

function apRowToEntry(row) {
  const score = parseInt(row.score, 10);
  const year = present(row.year) ? parseInt(row.year, 10) : NaN;
  return { exam: row.subject, score, ...(Number.isFinite(year) ? { year } : {}) };
}

function ecRowToActivity(ec) {
  const { category, timing, ...rest } = ec;
  return {
    ...rest,
    ...(present(category) ? { category } : {}),
    ...(present(timing) ? { timing } : {}),
    hoursPerWeek: ec.hoursPerWeek ? parseFloat(ec.hoursPerWeek) : undefined,
    // An activity keeps its id through the editor; only a new one gets one.
    id: ec.id || crypto.randomUUID(),
  };
}

// ─── COMPLETE SURVEY → build profile → go to chat ───
export async function handleSurveyComplete(ctx) {
  const {
    authedFetch, messages, sAPScores, sClassRank, sCourses, sECs,
    sGoals, sGpaUw, sGpaW, sMajorInterest, sNoGpaYet, sNoTestsYet,
    sTests, setData, setMessages, setScreen, setSurveyError, user,
    getSyncBase, setSyncBase, syncInFlightRef,
    locale, setSetAsideRows,
  } = ctx;
  // Flatten per-year courses into one array with year tags. A course in
  // the unplaced bucket keeps the year it came with (none, or one the
  // survey has no tab for).
  const allCourses = [];
  for (const [year, courses] of Object.entries(sCourses)) {
    for (const c of courses) {
      const { year: storedYear, ...course } = c;
      if (year !== UNPLACED_YEAR) allCourses.push({ ...course, year });
      else allCourses.push(present(storedYear) ? { ...course, year: storedYear } : course);
    }
  }
  const profile = {
    gpa: sNoGpaYet ? null : (sGpaUw ? { unweighted: parseFloat(sGpaUw), weighted: sGpaW ? parseFloat(sGpaW) : undefined } : null),
    gpaStatus: sNoGpaYet ? "pending" : undefined,
    classRank: normalizeClassRank(sClassRank) || undefined,
    courses: allCourses,
    apScores: sAPScores.map(apRowToEntry),
    // Every test keeps its section scores (SAT and PSAT Reading & Writing
    // and Math, ACT English/Math/Reading/Science, TOEFL, IELTS, Duolingo).
    testScores: sTests.map(t => formToEntry(t)),
    testingStatus: sNoTestsYet ? "planned" : undefined,
    majorInterest: sMajorInterest || undefined
  };
  const activities = sECs.map(ecRowToActivity);
  const edited = { profile, activities, goals: sGoals, majorInterest: sMajorInterest };

  setData(prev => ({
    ...prev, profile, activities, surveyCompleted: true, goals: sGoals, majorInterest: sMajorInterest,
    documents: (prev.documents || []).filter(doc => doc?.source !== "survey_transcript"),
  }));

  const sum = [];
  if (hasGpa(profile.gpa)) sum.push(`GPA: ${formatGpa(profile.gpa)}`);
  else if (sNoGpaYet) sum.push("GPA: not yet available");
  if (allCourses.length) {
    const apCount = allCourses.filter(c => c.type === "ap").length;
    sum.push(`${allCourses.length} courses${apCount ? ` (${apCount} AP)` : ""}`);
  }
  if (profile.apScores.length) sum.push(`${profile.apScores.length} AP exam scores`);
  // The catalog's own name for each entry, scale included ("PSAT 8/9",
  // "TOEFL (1-6 band)", "SAT Subject Test"): the test id upper-cased read
  // "SAT_SUBJECT" and gave a band 5 as "TOEFL: 5", a 5 out of 120.
  if (profile.testScores.length) sum.push(profile.testScores.map(t => `${entryLabel(t)}${t.subject?` ${t.subject}`:""}: ${t.totalScore}`).join(", "));
  else if (sNoTestsYet) sum.push("Test scores: not taken yet");
  if (activities.length) sum.push(`${activities.length} activities`);

  // ── Link onboarding to the AI counselor ──
  // Persist the profile to the backend FIRST (blocking) so the counselor
  // actually has the student's data, and confirm the AI session is ready,
  // BEFORE entering chat. A failed sync keeps the student on the survey with
  // a retry message instead of dropping them into a chat the backend knows
  // nothing about. (Skipped entirely in offline/local-only mode.)
  const proxyUrl = window.__CC_PROXY_URL__;
  // What the server could not store (a value out of range from an older
  // build); the rest of the save landed and the student hears which part.
  let setAsideNote = "";
  let conflictNote = "";
  if (proxyUrl) {
    let response;
    let base = getSyncBase ? getSyncBase() : null;
    let payload = buildSyncPayload(edited, base);
    const post = (body) => authedFetch("/api/students/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, trigger: "survey_complete" }),
    });
    // The auto-save waits while this save is out: two saves from one device
    // racing each other would read as a conflict with "another device".
    if (syncInFlightRef) syncInFlightRef.current = true;
    try {
      response = await post(payload);
      if (response?.status === 409) {
        const conflict = await response.json().catch(() => ({}));
        let server = readServerProfile(conflict);
        // A conflict answer without the profile is joined with a fresh read.
        if (conflict?.code === "profile_revision_conflict" && !server.exists) {
          const fresh = await authedFetch("/api/students/profile");
          if (fresh?.ok) server = readServerProfile(await fresh.json().catch(() => ({})));
        }
        if (conflict?.code === "profile_revision_conflict" && server.exists) {
          // Another device saved while this one was in the editor. What the
          // student changed here stays, the rest takes the other device's
          // save, and the joined record is sent once against its revision.
          const result = reconcileProfile({ local: edited, server, base });
          base = result.base;
          setSyncBase?.(base);
          conflictNote = describeProfileConflict(result);
          const joined = result.data;
          setData(prev => ({ ...prev, profile: joined.profile, activities: joined.activities, goals: joined.goals, majorInterest: joined.majorInterest }));
          payload = buildSyncPayload(joined, base);
          response = await post(payload);
        }
      }
    } catch {
      setSurveyError("Couldn't save your profile to your counselor — check your connection and try again.");
      return; // stay on the survey; do NOT enter a chat the backend can't back
    } finally {
      if (syncInFlightRef) syncInFlightRef.current = false;
    }
    // authedFetch resolves on every HTTP status. A refused save (413, 429,
    // 500, 503) used to pass as saved and drop the student into a chat that
    // knew nothing of the profile.
    if (!response?.ok) {
      setSurveyError(response?.status === 409
        ? "Your profile changed on another device while you were editing — press Finish again to save."
        : syncFailureMessage(response?.status));
      return;
    }
    const body = await response.json().catch(() => ({}));
    // The server now holds what was sent: that is the base the next save
    // is checked against.
    setSyncBase?.(baseFromPayload(payload, body?.revision ?? base?.serverRevision ?? null));
    setAsideNote = describeSetAside(body?.setAside, { locale });
    // The sidebar marks each score the server set aside, where it is.
    setSetAsideRows?.(setAsideRowsFrom(body?.setAside, payload.profile));
  }

  // FIX P2: Only reset messages on FIRST setup. If editing from chat, append an update
  // summary instead of wiping the entire conversation history.
  const isEditFromChat = messages.length > 1; // If there's an existing conversation, this is an edit
  const setAsideLine = [conflictNote, setAsideNote].filter(Boolean).map((note) => `\n\n${note}`).join("");
  const updateMsg = {
    role: "assistant",
    content: isEditFromChat
      ? `Profile updated! Here's what changed:\n\n${sum.length ? sum.join("\n") : "No changes detected."}\n${sMajorInterest ? `\nInterested in: ${sMajorInterest}` : ""}${sGoals.length ? `\nGoals: ${sGoals.join(", ")}` : ""}${setAsideLine}\n\nWhat would you like to work on next?`
      : `✓ Connected to your AI counselor — your profile is saved and synced.${setAsideLine}\n\nHere's what I have:\n\n${sum.length ? sum.join("\n") : "No data entered yet — that's okay, we can add things as we go."}\n${sMajorInterest ? `\nInterested in: ${sMajorInterest}` : ""}${sGoals.length ? `\nGoals: ${sGoals.join(", ")}` : ""}\n\nBefore we dive in — tell me a bit about yourself. What drives you? What's a challenge you've worked through, or something you're genuinely proud of? This helps me understand you beyond the numbers.\n\nYou can also upload report cards or score reports with 📎.`
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
    safeSet("cc_narrative_pending_" + user.email, "1");
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
  const groupedCourses = { freshman:[], sophomore:[], junior:[], senior:[], [UNPLACED_YEAR]:[] };
  for (const course of d.profile?.courses || []) {
    const { year, ...stored } = course || {};
    const row = {
      ...stored,
      name: course?.name || "",
      type: course?.type || "regular",
      // A course saved without a grade stays without one ("no grade
      // recorded"); "IP" would claim it is in progress.
      grade: course?.grade === "In Progress" ? "IP" : (course?.grade || ""),
      semester: course?.semester || "full_year",
    };
    if (SURVEY_YEAR_KEYS.includes(year)) groupedCourses[year].push(row);
    else groupedCourses[UNPLACED_YEAR].push(present(year) ? { ...row, year } : row);
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
  // An exam saved without a year (the sync drops a year no score can come
  // from and keeps the entry) stays without one, and the survey says so.
  setSAPScores((d.profile?.apScores || []).map(a => ({
    subject: a.exam || a.subject || "",
    score: present(a.score) ? String(a.score) : "",
    year: present(a.year) ? String(a.year) : "",
  })));
  setSAPInput({ subject:"", score:"5", year:String(latestApScoreYear()) });
  setSECs((d.activities || []).map(a => ({
    ...a,
    name: a.name || "",
    category: a.category || "",
    role: a.role || "",
    hoursPerWeek: a.hoursPerWeek != null ? String(a.hoursPerWeek) : "",
    weeksPerYear: a.weeksPerYear != null ? String(a.weeksPerYear) : "",
    description: a.description || "",
    grades: Array.isArray(a.grades) ? a.grades : [],
    timing: a.timing || "",
  })));
  setSECInput({ name:"", category:"academic", role:"", hoursPerWeek:"", weeksPerYear:"", description:"", grades:[], timing:"school_year" });
  setSGoals([...(d.goals || [])]);
  setsMajorInterest(d.majorInterest || d.profile?.majorInterest || "");
  setSurveyError("");
}

// Pull the profile the server holds and join it with local `data` through
// the one merge rule (profile/profile-reconcile.js): fields this device
// edited since its sync base stay, everything else takes the server's
// value. The editor calls this before it opens, and the chat calls it when
// sign-in could not reach the server. Returns the joined `data`.
export async function reconcileWithBackendProfile(ctx, local = ctx.data) {
  const {
    authedFetch, setData, getSyncBase, setSyncBase, setProfileReady, setSyncNote, setSyncStatus,
  } = ctx;
  const startBase = getSyncBase ? getSyncBase() : null;
  try {
    const r = await authedFetch("/api/students/profile");
    if (!r.ok) return local;
    const body = await r.json();
    // A save that landed while this read was out is newer than what the
    // read returned; merging it would put the older record back.
    if (getSyncBase && getSyncBase() !== startBase) return local;
    const server = readServerProfile(body);
    const result = reconcileProfile({ local, server, base: startBase });
    setSyncBase?.(result.base);
    setProfileReady?.(true);
    if (result.changed) {
      // The updater merges onto whatever the state holds by now, so an edit
      // made while the read was out is kept as an edit.
      setData(prev => reconcileProfile({ local: prev, server, base: startBase }).data);
      console.info(`[profile-recover] Took the server's ${result.adopted.join(", ") || "profile"}; kept local edits to ${result.kept.join(", ") || "nothing"}.`);
    }
    if (result.conflicts.length && setSyncNote) {
      setSyncNote(describeProfileConflict(result));
      setSyncStatus?.("partial");
    }
    return result.data;
  } catch (err) {
    console.warn("[profile-recover] backend pull failed:", err?.message);
    return local;
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
  // Pull the clicked activity into the input form, as it is saved: a missing
  // category or timing stays missing rather than becoming "club" or the
  // school year, and the id goes with it so re-adding keeps the activity's
  // identity.
  setSECInput({
    ...(activity.id ? { id: activity.id } : {}),
    name: activity.name || "",
    category: activity.category || "",
    role: activity.role || "",
    hoursPerWeek: activity.hoursPerWeek != null ? String(activity.hoursPerWeek) : "",
    weeksPerYear: activity.weeksPerYear != null ? String(activity.weeksPerYear) : "",
    description: activity.description || "",
    grades: Array.isArray(activity.grades) ? [...activity.grades] : [],
    timing: activity.timing || "",
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
