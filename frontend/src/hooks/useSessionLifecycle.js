// hooks/useSessionLifecycle.js — what runs while a student is signed in: the
// re-auth listener and credentials, routing on mount, the auto-save and backend
// sync, the admissions-calendar refresh, the pull of server-side metrics and the
// inactivity timeout with its warning. Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useEffect, useRef, useState } from "react";
import { setReauthListener, setReauthCredentialProvider } from "../chat/chat-client.js";
import { clearSession, storageKeyFor, encrypt, buildVaultBlob, storageApi } from "../session/vault-storage.js";
import { S } from "../app-shared.js";
import { sessionTimer } from "../session/server-session.js";
import { describeSetAside, syncFailureMessage } from "../profile/sync-result.js";
import { baseFromPayload, buildSyncPayload, describeProfileConflict, isDirty, readServerProfile, reconcileProfile, vaultSyncRecord } from "../profile/profile-reconcile.js";

// A 409 is answered by joining the server's profile and sending again; a
// server that keeps refusing must not be retried in a loop every second.
const MAX_CONFLICT_RETRIES = 2;

export function useSessionLifecycle(ctx) {
  const {
    authedFetch, data, passphrase, reconcileWithBackendProfile, refreshCollegeFit, refreshThreadList,
    screen, setCalendarCtx, setData, setExpiryWarning,
    setOfflineMode, setReauthStatus, setScreen, setSyncNote, setSyncStatus,
    targetSchools, user,
    endSession, initialScreen, profileReady, setSyncBase, syncBase, syncInFlightRef,
  } = ctx;
  // The inactivity notice, shown as a toast in both the survey and the chat.
  const EXPIRY_NOTICE = "Still there? You'll be signed out in about a minute of inactivity — click or type to stay signed in.";

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
  // After a deleted account the fresh tree opens on account creation.
  useEffect(() => {
    clearSession();
    setScreen(initialScreen || S.LOGIN);
  }, []);

  // ─── AUTO-SAVE data + SYNC TO RAG BACKEND ───
  // The vault is written when the data or the sync base moved, and the
  // server is sent only what it has not received. The save used to fire a
  // second after every screen change too, so reaching the chat posted the
  // whole vault, and a day-old device posted its stale record over a newer
  // one before anything had compared the two. It now waits until this
  // session has joined its data with the server's (profileReady), and each
  // save carries the revision its data was based on.
  const lastVaultWriteRef = useRef({ data: null, base: null });
  const conflictRetriesRef = useRef(0);
  const conflictNoticeRef = useRef(false);
  useEffect(() => {
    if ((screen !== S.CHAT && screen !== S.SURVEY) || !user || !passphrase) return;
    const t = setTimeout(async () => {
      // 1. Save to encrypted localStorage (offline-first). Identity is written
      //    alongside the data — it is the only copy login can read back — and
      //    so is the sync base, so the next sign-in can tell edits from age.
      if (lastVaultWriteRef.current.data !== data || lastVaultWriteRef.current.base !== syncBase) {
        lastVaultWriteRef.current = { data, base: syncBase };
        const storageKey = await storageKeyFor(user.email);
        const e = await encrypt(buildVaultBlob(data, { name: user.name, grade: user.grade }, { sync: vaultSyncRecord(data, syncBase) }), passphrase, user.email);
        try { await storageApi.set(storageKey, e); } catch (err) { console.warn("Auto-save failed:", err?.message); }
      }

      // 2. Sync to RAG backend — persists grades/GPA/ECs server-side so
      //    they survive restarts AND are reachable from any device.
      //    Routed through authedFetch so a stale token (post-restart)
      //    is healed and the write actually lands instead of silently
      //    no-oping. Saves go one at a time (syncInFlightRef); the one
      //    that is out moves the base when it answers, which runs this
      //    effect again.
      if (!profileReady || !data.profile || !isDirty(data, syncBase)) return;
      if (syncInFlightRef?.current) return;
      const payload = buildSyncPayload(data, syncBase);
      if (syncInFlightRef) syncInFlightRef.current = true;
      try {
        const response = await authedFetch("/api/students/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, trigger: "auto_sync" }),
        });
        setOfflineMode(false); // the backend answered — it is reachable
        if (response?.status === 409) {
          const conflict = await response.json().catch(() => ({}));
          let server = readServerProfile(conflict);
          // A conflict answer without the profile is joined with a fresh read
          // of it, never sent again blind over the other device's save.
          if (conflict?.code === "profile_revision_conflict" && !server.exists) {
            const fresh = await authedFetch("/api/students/profile").catch(() => null);
            if (fresh?.ok) server = readServerProfile(await fresh.json().catch(() => ({})));
          }
          if (conflict?.code === "profile_revision_conflict" && server.exists && conflictRetriesRef.current < MAX_CONFLICT_RETRIES
              && !(server.revision != null && String(server.revision) === String(syncBase?.serverRevision))) {
            // Another device saved since this one's base. Join its profile:
            // this device's edits stay, the rest follows the other device,
            // and the new base runs this effect again to send what was kept.
            conflictRetriesRef.current += 1;
            const result = reconcileProfile({ local: data, server, base: syncBase });
            setData((prev) => reconcileProfile({ local: prev, server, base: syncBase }).data);
            setSyncBase(result.base);
            conflictNoticeRef.current = true;
            setSyncNote(describeProfileConflict(result) || "Your profile changed on another device; this device now shows the latest version.");
            setSyncStatus("partial");
            return;
          }
        }
        // authedFetch resolves on every HTTP status; a refused save (413,
        // 429, 500, 503) used to show as synced and refresh College Fit
        // against the old record.
        if (!response?.ok) {
          setSyncNote(syncFailureMessage(response?.status));
          setSyncStatus("failed");
          return;
        }
        conflictRetriesRef.current = 0;
        const body = await response.json().catch(() => ({}));
        // The server now holds what was sent: that is the next save's base.
        setSyncBase(baseFromPayload(payload, body?.revision ?? syncBase?.serverRevision ?? null));
        const setAsideNote = describeSetAside(body?.setAside);
        if (setAsideNote) {
          // Saved, but a field the server could not store was left out.
          conflictNoticeRef.current = false;
          setSyncNote(setAsideNote);
          setSyncStatus("partial");
        } else if (conflictNoticeRef.current) {
          // The save that follows a conflict leaves its notice up: the
          // student should still read what came from the other device.
          conflictNoticeRef.current = false;
        } else {
          setSyncStatus("ok");
          setSyncNote("");
          setTimeout(() => setSyncStatus((s) => (s === "ok" ? "idle" : s)), 2000);
        }
        // 3. The College Fit card follows the record: once the sync has
        //    landed (the server reads the profile it holds), re-read the
        //    shown school if a course, score, activity or major changed.
        refreshCollegeFit(data);
      } catch (err) {
        if (err?.name === "AbortError") return; // the session ended
        console.warn("RAG sync failed (non-blocking):", err?.message); setSyncNote(""); setSyncStatus("failed");
      } finally {
        if (syncInFlightRef) syncInFlightRef.current = false;
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [data, screen, user, passphrase, authedFetch, refreshCollegeFit, syncBase, profileReady]);

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
  // Joining with the server's profile when sign-in could not: the backend
  // was unreachable, or its profile read failed. Sign-in itself joins the
  // two before the chat opens, so this does nothing then. Until it succeeds
  // the auto-save holds this device's edits, and it is retried while the
  // chat is open so they go out once the server answers.
  const reconcileRef = useRef(reconcileWithBackendProfile);
  reconcileRef.current = reconcileWithBackendProfile;
  useEffect(() => {
    if (screen !== S.CHAT || !user || profileReady) return undefined;
    const attempt = () => { reconcileRef.current().catch(() => {}); };
    attempt();
    const retry = setInterval(attempt, 30000);
    return () => clearInterval(retry);
  }, [screen, user, profileReady]);
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
  // The expiry ends the session the way logging out does (endSession in
  // App.jsx): the server session is revoked with the token in hand, and the
  // student tree remounts empty with the notice on the login screen. It used
  // to reset five pieces of state, revoke nothing and leave the passphrase in
  // the login field.
  const endSessionRef = useRef(endSession);
  endSessionRef.current = endSession;
  useEffect(() => {
    if (screen !== S.CHAT && screen !== S.SURVEY) { sessionTimer.clear(); setExpiryWarning(false); return; }
    const expire = () => {
      setExpiryWarning(false);
      endSessionRef.current?.("expired");
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
  return {
    EXPIRY_NOTICE,
  };
}
