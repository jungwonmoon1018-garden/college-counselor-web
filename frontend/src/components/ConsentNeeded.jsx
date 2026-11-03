import { useEffect, useState } from "react";
import { t } from "../i18n.js";
import CloseButton from "./CloseButton.jsx";

// ═══════════════════════════════════════════════════════════════════════
// ConsentNeeded — asks the student for a consent the server requires that
// this app does not grant on its own (session/consent-needs.js, debt-11).
// The app knows nothing about such a type, so what the student reads is the
// server's own label and description (GET /api/consent/requirements?types=,
// in the app's language), and nothing is granted until the student ticks
// each one and presses the button. A type the server does not describe
// cannot be consented to knowingly, so it is named and not offered. The
// panel used to ask the route without the types, and the route then
// described only the three onboarding consents, which never come here, so
// it could not offer anything at all.
// ═══════════════════════════════════════════════════════════════════════

export default function ConsentNeeded({ types = [], locale = "en-US", onGranted, onClose }) {
  const [described, setDescribed] = useState(null); // { [type]: { label, description } }
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const typesKey = types.join(",");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/consent/requirements?types=${encodeURIComponent(typesKey)}&locale=${encodeURIComponent(locale)}`);
        const list = r.ok ? await r.json() : [];
        const map = {};
        for (const item of Array.isArray(list) ? list : []) {
          if (item?.consentType && item.label) map[item.consentType] = { label: String(item.label), description: String(item.description || "") };
        }
        if (alive) setDescribed(map);
      } catch {
        if (alive) setDescribed({});
      }
    })();
    return () => { alive = false; };
  }, [locale, typesKey]);

  const offered = described ? types.filter((type) => described[type]) : [];
  const undescribed = described ? types.filter((type) => !described[type]) : [];
  const ready = offered.length > 0 && offered.every((type) => checked[type]);

  async function grant() {
    if (!ready || busy) return;
    setBusy(true); setError("");
    try {
      const token = window.__CC_SESSION_TOKEN__;
      const results = await Promise.all(offered.map((consentType) => fetch("/api/consent/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ consentType, grantedBy: "student", locale }),
      }).then((r) => r.ok).catch(() => false)));
      if (results.every(Boolean)) onGranted?.(offered);
      else setError(t(locale, "consent.grant_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={t(locale, "consent.title")} data-testid="consent-needed"
      style={{ position:"fixed", inset:0, zIndex:1200, background:"rgba(5,8,14,0.78)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ width:"min(520px, 100%)", maxHeight:"min(86vh, 760px)", overflowY:"auto", padding:22, borderRadius:16, background:"#101522", border:"1px solid rgba(255,255,255,0.08)", display:"flex", flexDirection:"column", gap:12, color:"#e8e6e3" }}>
        <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
          <div style={{ flex:1, fontSize:16, fontWeight:600 }}>{t(locale, "consent.title")}</div>
          <CloseButton label={t(locale, "chat.modal.close")} onClick={() => onClose?.()} />
        </div>
        <div style={{ fontSize:13, color:"#b7c1ce", lineHeight:1.5 }}>{t(locale, "consent.intro")}</div>
        {described == null && <div aria-live="polite" style={{ fontSize:13, color:"#8a8a9a" }}>…</div>}
        {offered.map((type) => (
          <label key={type} style={{ display:"flex", gap:10, alignItems:"flex-start", fontSize:13, lineHeight:1.5, padding:"10px 12px", borderRadius:10, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)", cursor:"pointer" }}>
            <input type="checkbox" checked={Boolean(checked[type])} onChange={(e) => setChecked((p) => ({ ...p, [type]: e.target.checked }))} style={{ marginTop:3 }} />
            <span><strong>{described[type].label}</strong>{described[type].description ? ` — ${described[type].description}` : ""}</span>
          </label>
        ))}
        {undescribed.length > 0 && (
          <div role="note" style={{ fontSize:12, color:"#f6ad55", lineHeight:1.5 }}>
            {t(locale, "consent.undescribed", { types: undescribed.join(", ") })}
          </div>
        )}
        {error && <div role="alert" style={{ fontSize:12, color:"#f56565" }}>{error}</div>}
        <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
          {offered.length > 0 && (
            <button type="button" onClick={grant} disabled={!ready || busy}
              style={{ padding:"8px 14px", borderRadius:8, border:"none", fontSize:13, fontWeight:600, background: ready && !busy ? "linear-gradient(135deg,#378ADD,#667eea)" : "rgba(255,255,255,0.04)", color: ready && !busy ? "#fff" : "#555", cursor: ready && !busy ? "pointer" : "default" }}>
              {t(locale, "consent.grant")}
            </button>
          )}
          <button type="button" onClick={() => onClose?.()}
            style={{ padding:"8px 14px", borderRadius:8, border:"1px solid rgba(255,255,255,0.1)", background:"transparent", color:"#8a8a9a", fontSize:13, cursor:"pointer" }}>
            {t(locale, "consent.not_now")}
          </button>
        </div>
      </div>
    </div>
  );
}
