// auth-handlers.js — sign-in (vault decrypt, server session, consent heal,
// profile reconcile), account creation and student recovery. App() keeps each hook and its dependency array and calls these with the
// render's bindings as `ctx`. Moved out of App.jsx on 2026-09-20.
import { storageKeyFor, storageApi, decrypt, readVaultIdentity, readVaultData, encrypt, buildVaultBlob } from "./vault-storage.js";
import { establishServerSession, healMissingConsents, fetchServerIdentity, grantOnboardingConsents } from "./server-session.js";
import { S } from "./app-shared.js";

export async function handleLogin(ctx) {
  const {
    lEmail, lPass, loginAttempts, setData, setLError, setLoginAttempts,
    setMessages, setOfflineMode, setPassphrase, setScreen, setSurveyStep, setUser,
  } = ctx;
  setLError("");
  const email = lEmail.toLowerCase().trim();
  if (!email) { setLError("Email is required"); return; }
  if (!lPass) { setLError("Passphrase is required"); return; }

  // Brute-force protection: lock after 5 failed attempts for 5 minutes
  const now = Date.now();
  const attempts = loginAttempts[email] || { count: 0, lastFail: 0 };
  if (attempts.count >= 5 && now - attempts.lastFail < 5 * 60 * 1000) {
    const mins = Math.ceil((5 * 60 * 1000 - (now - attempts.lastFail)) / 60000);
    setLError(`Too many failed attempts. Try again in ${mins} minute${mins > 1 ? "s" : ""}.`);
    return;
  }
  // Reset counter if lockout period has passed (immutable — don't mutate state directly)
  if (attempts.count >= 5 && now - attempts.lastFail >= 5 * 60 * 1000) {
    setLoginAttempts(prev => ({ ...prev, [email]: { count: 0, lastFail: 0 } }));
  }
  // The on-device vault verifies the passphrase offline and carries the
  // student's identity + data when present. It is a CACHE, not the
  // credential authority — the backend owns the credential. A missing vault
  // (new device or browser, cleared site data, a browser that wipes storage
  // on close) must NOT dead-end the student: fall through to server
  // authentication and re-seed the vault from the session. The old hard
  // stop here ("create a new account") combined with the backend's
  // duplicate-email rejection to lock returning students out entirely.
  const storageKey = await storageKeyFor(email);
  let identity = null;
  let vaultData = null;
  let vaultMissing = false;
  try {
    const saved = await storageApi.get(storageKey);
    if (!saved?.value) {
      vaultMissing = true; // verify against the server below
    } else {
      const d = await decrypt(saved.value, lPass, email);
      if (!d) {
        setLoginAttempts(prev => ({ ...prev, [email]: { count: (prev[email]?.count || 0) + 1, lastFail: Date.now() } }));
        setLError("Wrong passphrase. Your data is encrypted — only the correct passphrase can unlock it.");
        return;
      }
      identity = readVaultIdentity(d);
      // A verifier-only vault has no student data to restore yet.
      if (!d._verifier) { vaultData = readVaultData(d); setData(vaultData); }
    }
  } catch (err) {
    console.warn("Login decryption error:", err?.message);
    setLError("Couldn't unlock your data. Please try again.");
    return;
  }

  // Clear failed login counter on success
  setLoginAttempts(prev => { const next = { ...prev }; delete next[email]; return next; });

  // ── Establish the backend session BEFORE entering the app — otherwise the
  //    survey-sync / chat steps fail with "Not authenticated".
  const sess = await establishServerSession({ email, password: lPass, mode: "login" });
  // A reachable backend that rejects the credentials is authoritative: stop.
  // (The local vault opening only proves the passphrase decrypts on-device.)
  if (!sess.ok && !sess.offline) {
    setLoginAttempts(prev => ({ ...prev, [email]: { count: (prev[email]?.count || 0) + 1, lastFail: Date.now() } }));
    setLError(sess.reason || "Invalid email or password.");
    return;
  }
  // No vault on this device AND no reachable server: nothing can verify the
  // passphrase, so we can't open anything yet. (With a vault present,
  // offline mode proceeds on the on-device data below.)
  if (vaultMissing && !sess.ok) {
    setLError("Couldn't reach the server, and there's no data saved on this device yet. Reconnect and sign in again.");
    return;
  }
  // Offline-first: the vault already decrypted above, so an unreachable
  // backend must NOT lock the student out of their own on-device data (that
  // made it look like the account was wiped). Enter in a degraded "offline"
  // mode instead of blocking — server features resume when the backend
  // returns; authedFetch re-auths lazily on the next call.
  setOfflineMode(!!sess.offline);

  // Heal onboarding consents for accounts created by older signup builds,
  // which recorded only two of the three required rows — the missing
  // cross_border_transfer consent 403'd every AI feature (chat, auto-naming,
  // transcript parsing). The signup UI has always required accepting the AI
  // and data-processing terms to create the account.
  if (sess.ok) await healMissingConsents();

  // A vault written by a passphrase reset carries no identity. Rebuild it
  // from the session we just established, then persist it so later logins
  // read it locally again.
  if (!identity && sess.ok) {
    identity = await fetchServerIdentity(window.__CC_SESSION_TOKEN__);
    if (identity) {
      await storageApi.set(storageKey, await encrypt(buildVaultBlob({}, identity, { verifier: true }), lPass, email));
    }
  }
  if (!identity) {
    setLError("Account data is incomplete. Reconnect to the server and sign in again to restore it.");
    return;
  }

  const u = { name: identity.name, email, grade: identity.grade };
  setUser(u);
  setPassphrase(lPass);

  // ─── Backend profile recovery ───
  // The backend DB is the durable source of truth for grades/GPA/ECs.
  // If the local vault is empty/sparse (vault reset, new browser, or a
  // backend-restart hiccup) BUT the backend has a populated profile,
  // adopt it now — so the student sees their real transcript instead
  // of an empty survey, and isn't forced to re-do onboarding.
  let backendHasProfile = false;
  // Same convention as api.js: __CC_PROXY_URL__ is the chat endpoint, and
  // the same-origin default keeps this working on the deployed website.
  // (`proxyUrl` was previously read here without ever being declared — the
  // second dangling reference that crashed every returning login.)
  const proxyUrl = window.__CC_PROXY_URL__ || "/api/chat";
  if (window.__CC_SESSION_TOKEN__ && proxyUrl) {
    try {
      const base = proxyUrl.replace(/\/chat\/?$/,"");
      const pr = await fetch(`${base}/students/profile`, { headers: { Authorization: `Bearer ${window.__CC_SESSION_TOKEN__}` } });
      if (pr.ok) {
        const pb = await pr.json();
        const beCourses = pb.profile?.courses || [];
        const beEcs = pb.profile?.activities || [];
        if (beCourses.length > 0 || beEcs.length > 0) {
          backendHasProfile = true;
          setData(prev => {
            const base2 = prev || {};
            const localCourses = base2.profile?.courses || [];
            const localEcs = base2.activities || [];
            return {
              ...base2,
              profile: {
                ...(base2.profile || {}),
                gpa: base2.profile?.gpa?.unweighted != null ? base2.profile.gpa : (pb.profile?.gpa || base2.profile?.gpa),
                classRank: base2.profile?.classRank || pb.profile?.classRank || null,
                courses: beCourses.length > localCourses.length ? beCourses : localCourses,
                apScores: (base2.profile?.apScores?.length ? base2.profile.apScores : pb.profile?.apScores) || [],
                testScores: (base2.profile?.testScores?.length ? base2.profile.testScores : pb.profile?.testScores) || [],
                majorInterest: base2.profile?.majorInterest || pb.profile?.majorInterest || "",
              },
              activities: beEcs.length > localEcs.length ? beEcs : localEcs,
              goals: (base2.goals?.length ? base2.goals : pb.profile?.goals) || [],
              majorInterest: base2.majorInterest || pb.profile?.majorInterest || "",
            };
          });
          console.info(`[login-recover] Adopted backend profile: ${beCourses.length} courses, ${beEcs.length} ECs.`);
        }
      }
    } catch (err) { console.warn("[login-recover] failed:", err?.message); }
  }

  // Offline: skip the server-gated API-key check (it can't run without the
  // backend and would otherwise strand the student on the API-key screen).
  // Land them directly on their local data — CHAT if onboarding is done,
  // else the (local) survey.
  // NOTE: this tail previously referenced `serverUnreachable` and `acct` —
  // leftovers from the removed account registry that no longer existed
  // anywhere. Every returning login threw a ReferenceError right after the
  // server session was established, so the screen never advanced past LOGIN
  // and the deployed site appeared to lock users out after their first
  // visit. Route on `sess.offline` and the decrypted vault data instead.
  const surveyCompleted = Boolean(vaultData?.surveyCompleted);
  if (sess.offline) {
    if (surveyCompleted) {
      setMessages([{ role:"assistant", content:`Hey ${identity.name}! You're offline right now — your data is here and safe. Chat resumes once your connection's back.` }]);
      setScreen(S.CHAT);
    } else {
      setSurveyStep(0);
      setScreen(S.SURVEY);
    }
    return;
  }

  // If the backend already has a populated profile, the survey is
  // effectively done — go straight to chat (recovered data shows in
  // the sidebar, and "Edit profile" re-pulls it). Otherwise honor the
  // local surveyCompleted flag.
  if (!backendHasProfile && !surveyCompleted) {
    setSurveyStep(0);
    setScreen(S.SURVEY);
    return;
  }

  setMessages([{ role:"assistant", content:`Hey ${identity.name}! What would you like to work on?` }]);
  setScreen(S.CHAT);
}

// ─── CREATE ACCOUNT ───
export async function handleCreate(ctx) {
  const {
    cAgeAttest, cConsentAI, cConsentData, cEmail, cFirst, cGrade,
    cLast, cName, cPass, cPass2, setCError, setLEmail,
    setPassphrase, setScreen, setStudentRecoveryCode, setSurveyStep, setUser,
  } = ctx;
  setCError("");
  if (!cFirst.trim()) { setCError("First name is required"); return; }
  if (!cLast.trim()) { setCError("Last name is required"); return; }
  if (!cEmail.trim()) { setCError("Email is required"); return; }
  if (!cEmail.includes("@") || !cEmail.includes(".")) { setCError("Please enter a valid email address."); return; }
  if (!cGrade) { setCError("Select your grade"); return; }
  if (cPass.length < 12) { setCError("Passphrase must be at least 12 characters."); return; }
  if (cPass !== cPass2) { setCError("Passphrases don't match"); return; }
  if (!cAgeAttest) { setCError("You must confirm you are a high school student (ages 14-18) or have parental consent"); return; }
  if (!cConsentAI) { setCError("You must acknowledge that this is an AI system before continuing"); return; }
  if (!cConsentData) { setCError("You must consent to data processing before continuing"); return; }
  const email = cEmail.toLowerCase().trim();

  // ── Establish the server account FIRST — it is authoritative. We must NOT
  //    create local state or advance into the survey unless the backend
  //    confirmed the account. A silent backend failure here is exactly what
  //    used to strand users with no session ("Not authenticated"). Duplicate
  //    emails are detected by the backend (409 → sess.existing), not by a
  //    local registry.
  const sess = await establishServerSession({ email, password: cPass, name: cName.trim(), grade: cGrade, mode: "create" });
  // Existing email must not silently drop the user into someone else's
  // data (their profile and chat threads). Route to LOGIN instead.
  if (sess.existing) {
    setCError("An account with this email already exists. Sign in instead.");
    setLEmail(email);
    setScreen(S.LOGIN);
    return;
  }
  // Registration didn't complete — stop here with an actionable error rather
  // than entering an unauthenticated state. Unlike login, create cannot fall
  // back to offline: the backend is what stores the credential.
  if (!sess.ok) {
    setCError(sess.offline
      ? "Couldn't reach the server to finish creating your account. Make sure the backend is running, then try again."
      : (sess.reason || "Couldn't create your account. Please try again."));
    return;
  }

  // Server confirmed → seed the on-device vault. Identity lives inside the
  // passphrase-encrypted blob (never a plaintext registry), so login can both
  // verify the passphrase and recover the student's name/grade offline.
  const identity = { name: cName.trim(), grade: cGrade };
  const storageKey = await storageKeyFor(email);
  const verifier = await encrypt(buildVaultBlob({}, identity, { verifier: true }), cPass, email);
  await storageApi.set(storageKey, verifier);

  const u = { name: identity.name, email, grade: identity.grade };
  setUser(u);
  setPassphrase(cPass);
  setStudentRecoveryCode(sess.recoveryCode || "");

  // Grant onboarding consents now that we hold a verified server session.
  // All three are required by the backend for any AI operation — granting
  // only data_processing + ai_interaction (as older builds did) left
  // cross_border_transfer missing and 403'd every AI feature.
  await grantOnboardingConsents();

  setSurveyStep(0);
  setScreen(S.SURVEY);
}

export async function handleStudentRecovery(ctx, event) {
  const {
    lEmail, setLPass, setStudentRecoveryBusy, setStudentRecoveryInput, setStudentRecoveryMessage, setStudentRecoveryOpen,
    setStudentRecoveryPassword, studentRecoveryInput, studentRecoveryPassword,
  } = ctx;
  event.preventDefault();
  setStudentRecoveryMessage(null);
  const email = lEmail.toLowerCase().trim();
  if (!email || !studentRecoveryInput.trim()) { setStudentRecoveryMessage({ type:"error", text:"Enter your email and recovery code." }); return; }
  if (studentRecoveryPassword.length < 12) { setStudentRecoveryMessage({ type:"error", text:"New passphrase must be at least 12 characters." }); return; }
  setStudentRecoveryBusy(true);
  try {
    const response = await fetch("/api/students/recover", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ email, recoveryCode:studentRecoveryInput.trim(), newPassword:studentRecoveryPassword }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Recovery failed.");
    // The old local vault cannot be decrypted without its passphrase. Start a
    // new encrypted verifier; identity and server-synced profile data are
    // restored on the next successful login (see fetchServerIdentity).
    await storageApi.set(await storageKeyFor(email), await encrypt({ _verifier:true }, studentRecoveryPassword, email));
    setLPass(studentRecoveryPassword);
    setStudentRecoveryInput("");
    setStudentRecoveryPassword("");
    setStudentRecoveryOpen(false);
    setStudentRecoveryMessage({ type:"success", text:"Passphrase reset. Sign in to restore server-synced data." });
  } catch (error) {
    setStudentRecoveryMessage({ type:"error", text:error?.message || "Recovery failed." });
  } finally {
    setStudentRecoveryBusy(false);
  }
}
