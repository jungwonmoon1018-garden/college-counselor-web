// hooks/useSessionLifecycle.js — what runs while a student is signed in: the
// re-auth listener and credentials, routing on mount, the auto-save and backend
// sync, the admissions-calendar refresh, the pull of server-side metrics and the
// inactivity timeout with its warning. Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useEffect, useRef, useState } from "react";
import { setReauthListener, setReauthCredentialProvider } from "../chat/chat-client.js";
import { clearSession, storageKeyFor, encrypt, buildVaultBlob, storageApi } from "../session/vault-storage.js";
import { S } from "../app-shared.js";
import { sessionTimer } from "../session/server-session.js";

export function useSessionLifecycle(ctx) {
  const {
    authedFetch, data, passphrase, reconcileWithBackendProfile, refreshCollegeFit, refreshThreadList,
    screen, setCalendarCtx, setData, setExpiryWarning, setLError, setMessages,
    setOfflineMode, setPassphrase, setReauthStatus, setScreen, setSyncNote, setSyncStatus,
    setUser, targetSchools, user,
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
  return {
    EXPIRY_NOTICE,
  };
}
