// hooks/useAuthHandlers.js — one auth action at a time, and the handlers behind
// the account screens: create, sign in, recover, log out, export, delete. Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useRef, useState, useCallback } from "react";
import { handleCreate as handleCreateImpl, handleLogin as handleLoginImpl, handleStudentRecovery as handleStudentRecoveryImpl } from "../handlers/auth-handlers.js";
import { endSessionReauth, rateLimiter } from "../chat/chat-client.js";
import { clearSession, storageApi, storageKeyFor, safeBtoa } from "../session/vault-storage.js";
import { sessionTimer } from "../session/server-session.js";
import { S } from "../app-shared.js";

export function useAuthHandlers(ctx) {
  const {
    authedFetch, cAgeAttest, cConsentAI, cConsentData, cEmail, cFirst,
    cGrade, cLast, cName, cPass, cPass2, lEmail,
    lPass, makeExportFilename, setCError, setData, setLEmail, setLError,
    setLPass, setMessages, setOfflineMode, setPassphrase, setScreen, setStudentRecoveryBusy,
    setStudentRecoveryCode, setStudentRecoveryInput, setStudentRecoveryMessage, setStudentRecoveryOpen, setStudentRecoveryPassword, setSurveyStep,
    setUser, studentRecoveryInput, studentRecoveryPassword, user,
  } = ctx;
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
    // From here on no background request may sign the student back in, and a
    // 401 on the logout call itself must not re-authenticate either.
    endSessionReauth();
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
      endSessionReauth();
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
  return {
    authBusy, handleCreate, handleDeleteAccount, handleExportData, handleLogin, handleLogout,
    handleStudentRecovery, runAuthGuarded,
  };
}
