import { useEffect, useMemo, useState } from "react";

const COPY = {
  en: {
    brand: "College Counselor Administrator",
    student: "Student app",
    title: "Counselor administrator",
    lede: "Configure the three secrets used by this installation. The administrator cannot inspect student profiles, chats, or application records.",
    loading: "Loading administrator status...",
    createTitle: "Create administrator account",
    loginTitle: "Administrator sign in",
    password: "Password",
    passwordHint: "Use at least 12 characters. This password is separate from student accounts.",
    confirm: "Confirm password",
    create: "Create administrator",
    signIn: "Sign in",
    recover: "Use recovery code",
    recoveryCode: "Recovery code",
    newPassword: "New password",
    reset: "Reset password",
    back: "Back to sign in",
    recoverySave: "Store this recovery code offline. It is shown only once.",
    logout: "Sign out",
    secretsTitle: "Installation secrets",
    encryption: "Vault encryption key",
    encryptionDesc: "Enter a 64-character hexadecimal key once. It encrypts student vault data and cannot be viewed or replaced after setup.",
    openrouter: "OpenRouter API key",
    openrouterDesc: "Used for all model requests. Students never enter or receive this key.",
    scorecard: "IPEDS / College Scorecard API key",
    scorecardDesc: "Used only with the official College Scorecard data service.",
    configured: "Configured",
    missing: "Not configured",
    replace: "Replace",
    add: "Add",
    clear: "Clear",
    cancel: "Cancel",
    save: "Save and restart",
    value: "New secret value",
    restarting: "Saving securely and restarting the local service...",
    setupRequired: "This administrator endpoint requires the website launcher.",
    safeNote: "Secret values are sent only to this website's same-origin backend and stored in an AES-256-GCM encrypted server file. They are never stored in browser storage or returned by the API.",
    genericError: "The request could not be completed.",
    mismatch: "Passwords do not match.",
    shortPassword: "Password must be at least 12 characters.",
    cleared: "Secret cleared.",
    saved: "Secret saved. The local service restarted.",
    clearConfirm: "Clear this secret? Related features will stop working.",
    webTitle: "Counselor administrator",
    webLede: "Complete secure website setup and choose the OpenRouter models used for each workload tier. Secret values are never shown after saving.",
    setupToken: "Website setup token",
    setupTokenHint: "Enter the WEB_ADMIN_BOOTSTRAP_TOKEN supplied by the person who deployed this website.",
    encryptionDescWeb: "Enter a 64-character hexadecimal key once. It encrypts student vault data and cannot be viewed or replaced after setup.",
    webSafeNote: "Secret values are sent only to this website's same-origin backend and stored in an AES-256-GCM encrypted server file. They are never stored in browser storage or returned by the API.",
    modelsTitle: "OpenRouter models",
    modelsLede: "Choose a reviewed, currently listed OpenRouter model for each workload tier.",
    smallTier: "Small · routine coaching",
    mediumTier: "Medium · synthesis and strategy",
    largeTier: "Large · complex review",
    saveModels: "Save models and restart",
    modelsSaved: "Model choices saved. The website service restarted.",
    unavailable: "currently unavailable",
    setupIncomplete: "Student access stays closed until all three secrets are configured.",
  },
  ko: {
    brand: "College Counselor 관리자",
    student: "학생 앱",
    title: "상담사 관리자",
    lede: "이 설치에서 사용하는 세 가지 비밀 키를 설정합니다. 관리자는 학생 프로필, 대화 또는 지원 기록을 볼 수 없습니다.",
    loading: "관리자 상태를 불러오는 중...",
    createTitle: "관리자 계정 만들기",
    loginTitle: "관리자 로그인",
    password: "비밀번호",
    passwordHint: "12자 이상을 사용하세요. 학생 계정 비밀번호와는 별개입니다.",
    confirm: "비밀번호 확인",
    create: "관리자 만들기",
    signIn: "로그인",
    recover: "복구 코드 사용",
    recoveryCode: "복구 코드",
    newPassword: "새 비밀번호",
    reset: "비밀번호 재설정",
    back: "로그인으로 돌아가기",
    recoverySave: "이 복구 코드를 오프라인에 보관하세요. 한 번만 표시됩니다.",
    logout: "로그아웃",
    secretsTitle: "설치 비밀 키",
    encryption: "보관함 암호화 키",
    encryptionDesc: "64자의 16진수 키를 한 번 입력하세요. 학생 보관함 데이터를 암호화하며 설정 후에는 확인하거나 교체할 수 없습니다.",
    openrouter: "OpenRouter API 키",
    openrouterDesc: "모든 모델 요청에 사용됩니다. 학생은 이 키를 입력하거나 볼 수 없습니다.",
    scorecard: "IPEDS / College Scorecard API 키",
    scorecardDesc: "공식 College Scorecard 데이터 서비스에만 사용됩니다.",
    configured: "설정됨",
    missing: "설정 안 됨",
    replace: "교체",
    add: "추가",
    clear: "삭제",
    cancel: "취소",
    save: "저장 후 재시작",
    value: "새 비밀 키 값",
    restarting: "안전하게 저장하고 로컬 서비스를 재시작하는 중...",
    setupRequired: "이 관리자 화면에는 웹사이트 런처가 필요합니다.",
    safeNote: "비밀 키 값은 이 웹사이트의 동일 출처 백엔드로만 전송되고 AES-256-GCM 암호화 서버 파일에 저장됩니다. 브라우저 저장소에 저장되거나 API 응답으로 반환되지 않습니다.",
    genericError: "요청을 완료하지 못했습니다.",
    mismatch: "비밀번호가 일치하지 않습니다.",
    shortPassword: "비밀번호는 12자 이상이어야 합니다.",
    cleared: "비밀 키를 삭제했습니다.",
    saved: "비밀 키를 저장하고 로컬 서비스를 재시작했습니다.",
    clearConfirm: "이 비밀 키를 삭제할까요? 관련 기능이 중지됩니다.",
  },
};

async function jsonRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || "Request failed");
  return body;
}

export default function AdminApp() {
  const [locale, setLocale] = useState(() => navigator.language?.toLowerCase().startsWith("ko") ? "ko" : "en");
  const [bootstrapped, setBootstrapped] = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [csrfToken, setCsrfToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [oneTimeRecovery, setOneTimeRecovery] = useState("");
  const [secrets, setSecrets] = useState(null);
  const [webDeployment, setWebDeployment] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const [models, setModels] = useState(null);
  const [modelOptions, setModelOptions] = useState([]);
  const [editing, setEditing] = useState(null);
  const [secretValue, setSecretValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const c = useMemo(() => ({ ...COPY.en, ...COPY[locale] }), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale === "ko" ? "ko" : "en";
  }, [locale]);

  useEffect(() => {
    jsonRequest("/api/admin/status")
      .then((body) => {
        setBootstrapped(Boolean(body.bootstrapped));
        setWebDeployment(Boolean(body.webDeployment));
      })
      .catch((error) => { setBootstrapped(false); setMessage({ type: "error", text: error.message }); });
  }, []);

  const normalizedSecrets = useMemo(() => {
    if (!secrets) return {};
    return secrets.secrets || secrets;
  }, [secrets]);

  async function refreshSecrets() {
    const status = await jsonRequest("/api/admin/secrets/status");
    setSecrets(status);
    return status;
  }

  async function refreshModels() {
    if (!webDeployment) return null;
    const status = await jsonRequest("/api/admin/models");
    setModels(status.models || null);
    setModelOptions(status.options || []);
    return status;
  }

  async function refreshAfterRestart() {
    let lastError;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      try {
        const status = await refreshSecrets();
        if (webDeployment) await refreshModels();
        return status;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(c.genericError);
  }

  async function authenticate(event) {
    event.preventDefault();
    setMessage(null);
    if (password.length < 12) { setMessage({ type: "error", text: c.shortPassword }); return; }
    if (!bootstrapped && password !== confirmPassword) { setMessage({ type: "error", text: c.mismatch }); return; }
    setBusy(true);
    try {
      const body = bootstrapped
        ? await jsonRequest("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) })
        : await jsonRequest("/api/admin/bootstrap", {
          method: "POST",
          headers: { "X-Web-Setup-Token": setupToken },
          body: JSON.stringify({ password }),
        });
      if (!body) throw new Error(c.setupRequired);
      setAuthenticated(true);
      setCsrfToken(body.csrfToken || "");
      setBootstrapped(true);
      setOneTimeRecovery(body.recoveryCode || "");
      setPassword("");
      setConfirmPassword("");
      setSetupToken("");
      await refreshSecrets();
      if (webDeployment) await refreshModels();
    } catch (error) {
      setMessage({ type: "error", text: error.message || c.genericError });
    } finally {
      setBusy(false);
    }
  }

  async function recover(event) {
    event.preventDefault();
    setMessage(null);
    if (newPassword.length < 12) { setMessage({ type: "error", text: c.shortPassword }); return; }
    setBusy(true);
    try {
      const body = await jsonRequest("/api/admin/recover", {
        method: "POST",
        body: JSON.stringify({ recoveryCode: recoveryCode.trim(), newPassword }),
      });
      if (!body) throw new Error(c.setupRequired);
      setAuthenticated(true);
      setCsrfToken(body.csrfToken || "");
      setOneTimeRecovery(body.recoveryCode || "");
      setRecoveryCode("");
      setNewPassword("");
      setRecoveryMode(false);
      await refreshSecrets();
      if (webDeployment) await refreshModels();
    } catch (error) {
      setMessage({ type: "error", text: error.message || c.genericError });
    } finally {
      setBusy(false);
    }
  }

  async function saveSecret(event) {
    event.preventDefault();
    if (!editing || !secretValue.trim()) return;
    setBusy(true);
    setMessage({ type: "success", text: c.restarting });
    try {
      await jsonRequest(`/api/admin/secrets/${editing}`, {
        method: "PUT",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ value: secretValue }),
      });
      setSecretValue("");
      setEditing(null);
      if (webDeployment) await refreshAfterRestart();
      else await refreshSecrets();
      setMessage({ type: "success", text: c.saved });
    } catch (error) {
      setMessage({ type: "error", text: error.message || c.genericError });
    } finally {
      setBusy(false);
    }
  }

  async function clearSecret(name) {
    if (!window.confirm(c.clearConfirm)) return;
    setBusy(true);
    setMessage({ type: "success", text: c.restarting });
    try {
      await jsonRequest(`/api/admin/secrets/${name}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrfToken },
      });
      await refreshAfterRestart();
      setMessage({ type: "success", text: c.cleared });
    } catch (error) {
      setMessage({ type: "error", text: error.message || c.genericError });
    } finally {
      setBusy(false);
    }
  }

  async function saveModels(event) {
    event.preventDefault();
    if (!models) return;
    setBusy(true);
    setMessage({ type: "success", text: c.restarting });
    try {
      await jsonRequest("/api/admin/models", {
        method: "PUT",
        headers: { "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ models }),
      });
      await refreshAfterRestart();
      setMessage({ type: "success", text: c.modelsSaved });
    } catch (error) {
      setMessage({ type: "error", text: error.message || c.genericError });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await jsonRequest("/api/admin/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
    } catch {}
    setAuthenticated(false);
    setCsrfToken("");
    setSecrets(null);
    setModels(null);
    setModelOptions([]);
    setOneTimeRecovery("");
    setMessage(null);
  }

  const secretRows = [
    { name: "encryption", title: c.encryption, description: webDeployment ? c.encryptionDescWeb : c.encryptionDesc, mutable: webDeployment && normalizedSecrets.encryption?.mutable !== false },
    { name: "openrouter", title: c.openrouter, description: c.openrouterDesc, mutable: true },
    { name: "scorecard", title: c.scorecard, description: c.scorecardDesc, mutable: true },
  ];

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <p className="admin-brand">{c.brand}</p>
        <nav className="admin-header-actions" aria-label="Administrator navigation">
          <a href="/index.html">{c.student}</a>
          <button className="admin-link-button" type="button" onClick={() => setLocale(locale === "en" ? "ko" : "en")} aria-label="Change language">
            {locale === "en" ? "한국어" : "English"}
          </button>
          {authenticated && <button className="admin-link-button" type="button" onClick={logout}>{c.logout}</button>}
        </nav>
      </header>
      <main className="admin-main">
        <h1>{webDeployment ? c.webTitle : c.title}</h1>
        <p className="admin-lede">{webDeployment ? c.webLede : c.lede}</p>
        {message && <p className={"admin-alert " + message.type} role={message.type === "error" ? "alert" : "status"}>{message.text}</p>}

        {bootstrapped === null && <p role="status">{c.loading}</p>}

        {bootstrapped !== null && !authenticated && (
          <section className="admin-panel" aria-labelledby="admin-auth-title">
            <h2 id="admin-auth-title">{recoveryMode ? c.recover : (bootstrapped ? c.loginTitle : c.createTitle)}</h2>
            {recoveryMode ? (
              <form className="admin-form" onSubmit={recover}>
                <div className="admin-field">
                  <label htmlFor="admin-recovery">{c.recoveryCode}</label>
                  <input id="admin-recovery" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} autoComplete="off" required />
                </div>
                <div className="admin-field">
                  <label htmlFor="admin-new-password">{c.newPassword}</label>
                  <input id="admin-new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={12} required />
                  <small>{c.passwordHint}</small>
                </div>
                <button className="admin-primary" disabled={busy} type="submit">{c.reset}</button>
                <button className="admin-secondary" type="button" onClick={() => setRecoveryMode(false)}>{c.back}</button>
              </form>
            ) : (
              <form className="admin-form" onSubmit={authenticate}>
                {!bootstrapped && webDeployment && (
                  <div className="admin-field">
                    <label htmlFor="admin-setup-token">{c.setupToken}</label>
                    <input id="admin-setup-token" type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} autoComplete="off" minLength={24} required autoFocus />
                    <small>{c.setupTokenHint}</small>
                  </div>
                )}
                <div className="admin-field">
                  <label htmlFor="admin-password">{c.password}</label>
                  <input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={bootstrapped ? "current-password" : "new-password"} minLength={12} required autoFocus={!webDeployment || bootstrapped} />
                  <small>{c.passwordHint}</small>
                </div>
                {!bootstrapped && (
                  <div className="admin-field">
                    <label htmlFor="admin-confirm">{c.confirm}</label>
                    <input id="admin-confirm" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={12} required />
                  </div>
                )}
                <button className="admin-primary" disabled={busy} type="submit">{bootstrapped ? c.signIn : c.create}</button>
                {bootstrapped && <button className="admin-secondary" type="button" onClick={() => setRecoveryMode(true)}>{c.recover}</button>}
              </form>
            )}
          </section>
        )}

        {authenticated && (
          <section className="admin-panel" aria-labelledby="admin-secrets-title">
            <h2 id="admin-secrets-title">{c.secretsTitle}</h2>
            {oneTimeRecovery && <div className="admin-recovery" role="status">{c.recoverySave}<code>{oneTimeRecovery}</code></div>}
            {webDeployment && secrets && !secrets.installationReady && <p className="admin-alert setup" role="status">{c.setupIncomplete}</p>}
            {!webDeployment && <p className="admin-alert error" role="alert">{c.setupRequired}</p>}
            <div className="admin-secret-list">
              {secretRows.map((row) => {
                const configured = Boolean(normalizedSecrets[row.name]?.configured);
                return (
                  <article className="admin-secret" key={row.name}>
                    <div>
                      <h2>{row.title}</h2>
                      <p>{row.description}</p>
                      <span className={"admin-badge " + (configured ? "on" : "off")}>{configured ? c.configured : c.missing}</span>
                    </div>
                    {row.mutable && (
                      <div className="admin-secret-actions">
                        <button className="admin-secondary" type="button" disabled={busy || !webDeployment} onClick={() => { setEditing(row.name); setSecretValue(""); }}>
                          {configured ? c.replace : c.add}
                        </button>
                        {configured && row.name !== "encryption" && <button className="admin-danger" type="button" disabled={busy || !webDeployment} onClick={() => clearSecret(row.name)}>{c.clear}</button>}
                      </div>
                    )}
                    {editing === row.name && (
                      <form className="admin-editor" onSubmit={saveSecret}>
                        <label htmlFor={"secret-" + row.name}>{c.value}</label>
                        <input id={"secret-" + row.name} type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} autoComplete="off" required autoFocus />
                        <button className="admin-primary" type="submit" disabled={busy}>{c.save}</button>
                        <button className="admin-secondary" type="button" onClick={() => { setEditing(null); setSecretValue(""); }}>{c.cancel}</button>
                      </form>
                    )}
                  </article>
                );
              })}
            </div>
            <p className="admin-footnote">{webDeployment ? c.webSafeNote : c.safeNote}</p>

            {webDeployment && models && (
              <form className="admin-models" onSubmit={saveModels}>
                <div>
                  <h2>{c.modelsTitle}</h2>
                  <p>{c.modelsLede}</p>
                </div>
                {[
                  ["small", c.smallTier],
                  ["medium", c.mediumTier],
                  ["large", c.largeTier],
                ].map(([tier, label]) => (
                  <div className="admin-field" key={tier}>
                    <label htmlFor={`model-${tier}`}>{label}</label>
                    <select id={`model-${tier}`} value={models[tier] || ""} onChange={(event) => setModels((current) => ({ ...current, [tier]: event.target.value }))} required>
                      {modelOptions.map((option) => (
                        <option key={option.id} value={option.id} disabled={option.available === false && option.id !== models[tier]}>
                          {option.label}{option.available === false ? ` · ${c.unavailable}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <button className="admin-primary" type="submit" disabled={busy}>{c.saveModels}</button>
              </form>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
