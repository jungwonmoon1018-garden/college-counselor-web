import { useEffect, useState } from "react";
import { narrative as narrativeApi } from "../api.js";
import { t } from "../i18n.js";

// ═══════════════════════════════════════════════════════════════════════
// DriftBanner — surfaces /api/narrative/drift status at the top of CHAT.
// Renders nothing if all_fresh; nudges the student to re-rank when ECs
// have shifted out of alignment with the saved narrative. friendlyMessage
// already comes back locale-translated, so we render it verbatim.
// ═══════════════════════════════════════════════════════════════════════

// `refreshKey` changes whenever the narrative or the activities are saved,
// so the banner re-reads drift instead of showing a stale "no saved story"
// warning after the student has just saved one. `onWriteStory` opens the
// story editor — the visible action for the no-narrative state (the server
// text used to name an API endpoint instead).
export default function DriftBanner({ locale = "en-US", onReview, onWriteStory, refreshKey = 0 }) {
  const [drift, setDrift] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    setDismissed(false);
    (async () => {
      try {
        const r = await narrativeApi.drift();
        if (alive) setDrift(r);
      } catch { /* drift is best-effort; never block chat */ }
    })();
    return () => { alive = false; };
  }, [refreshKey]);

  if (!drift || dismissed) return null;
  if (drift.status === "all_fresh") return null;

  const isUrgent = drift.status === "many_stale" || drift.status === "no_active_narrative";
  const bg = isUrgent ? "rgba(245,101,101,0.08)" : "rgba(237,137,54,0.08)";
  const border = isUrgent ? "1px solid rgba(245,101,101,0.18)" : "1px solid rgba(237,137,54,0.18)";
  const iconColor = isUrgent ? "#f56565" : "#ed8936";

  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 12,
      padding: "12px 16px",
      borderRadius: 12,
      background: bg,
      border,
      marginBottom: 12,
    }}>
      <span style={{ color: iconColor, fontSize: 20, lineHeight: 1, marginTop: 1 }}>•</span>
      <div style={{ flex: 1, fontSize: 13, color: "#e0e0e0", lineHeight: 1.5 }}>
        {drift.friendlyMessage || drift.status}
        {Array.isArray(drift.staleEcs) && drift.staleEcs.length > 0 && (
          <div style={{ fontSize: 11, color: "#8a8a9a", marginTop: 6 }}>
            {drift.staleEcs.slice(0, 4).map((e) => e.name || e).join(" • ")}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {drift.status === "no_active_narrative" && onWriteStory ? (
          <button onClick={onWriteStory} style={{
            fontSize: 12, padding: "6px 12px", borderRadius: 8,
            border: "none", background: "linear-gradient(135deg,#378ADD,#667eea)",
            color: "#fff", fontWeight: 600, cursor: "pointer",
          }}>
            {t(locale, "drift.write_story")}
          </button>
        ) : onReview && (
          <button onClick={onReview} style={{
            fontSize: 12, padding: "6px 12px", borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.1)", background: "transparent",
            color: "#e0e0e0", cursor: "pointer",
          }}>
            {t(locale, "drift.review")}
          </button>
        )}
        <button onClick={() => setDismissed(true)} style={{
          fontSize: 12, padding: "6px 12px", borderRadius: 8,
          border: "none", background: "transparent", color: "#8a8a9a", cursor: "pointer",
        }}>
          {t(locale, "drift.dismiss")}
        </button>
      </div>
    </div>
  );
}
