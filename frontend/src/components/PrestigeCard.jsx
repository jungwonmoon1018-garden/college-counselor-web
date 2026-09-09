import { useEffect, useState } from "react";
import { ec as ecApi } from "../api.js";
import { t } from "../i18n.js";

// ═══════════════════════════════════════════════════════════════════════
// PrestigeCard — fetches /api/ec/strength/:ecName/prestige and renders the
// score, the level that was read and where it was found (the activity's
// name, its 150-character description, listed awards, an attachment), the
// source label, the rationale, and the organizer's cited pages. The backend
// localizes the source label and the friendly message; the rationale is
// rendered verbatim.
// ═══════════════════════════════════════════════════════════════════════

export default function PrestigeCard({ ecName, locale = "en-US" }) {
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false); setData(null);
    (async () => {
      try {
        const r = await ecApi.prestige(ecName);
        if (alive) setData(r);
      } catch (err) {
        // A known activity without a cached rationale answers 404 with a
        // friendly message; surface it instead of a bare "no data".
        if (alive && err?.body?.friendlyMessage) setData({ error: err.body.error || "no_cached_rationale", friendlyMessage: err.body.friendlyMessage });
      }
      finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; };
  }, [ecName]);

  if (!loaded) {
    return <div style={{ fontSize: 12, color: "#555", padding: "8px 12px" }}>...</div>;
  }
  if (!data || data.error) {
    return (
      <div style={{ fontSize: 12, color: "#8a8a9a", padding: "10px 14px", borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
        {data?.friendlyMessage || t(locale, "prestige.no_data")}
      </div>
    );
  }

  const score = Number(data.score ?? 0);
  const scoreColor = score >= 0.8 ? "#68d391" : score >= 0.6 ? "#fbd38d" : score >= 0.4 ? "#f6ad55" : "#a0aec0";
  const source = data.friendly || data.sourceLabel || null;
  const level = data.level && data.level !== "default" ? data.level : (data.catalogMatch?.level && data.catalogMatch.level !== "default" ? data.catalogMatch.level : null);

  return (
    <div data-testid="prestige-card" style={{
      padding: "12px 14px",
      borderRadius: 10,
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.06)",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#fff", flex: 1 }}>
          {t(locale, "prestige.title")}
        </span>
        <span style={{ fontSize: 13, color: scoreColor, fontWeight: 700 }}>
          {t(locale, "prestige.score")} {score.toFixed(2)}
        </span>
        {source?.short && (
          <span style={{ fontSize: 10, color: "#8a8a9a", padding: "2px 6px", borderRadius: 6, background: "rgba(255,255,255,0.04)" }}>
            {source.short}
          </span>
        )}
      </div>
      {level && (
        <div style={{ fontSize: 12, color: "#cbd5e0" }}>
          <span style={{ color: "#8a8a9a" }}>{t(locale, "prestige.level")}: </span>{level}
          {data.catalogMatch?.activityName && <span style={{ color: "#8a8a9a" }}> · {data.catalogMatch.activityName}</span>}
        </div>
      )}
      {data.rationale && (
        <div style={{ fontSize: 12, color: "#cbd5e0", lineHeight: 1.5 }}>
          {data.rationale}
        </div>
      )}
      {source?.summary && (
        <div style={{ fontSize: 11, color: "#8a8a9a", lineHeight: 1.5 }}>
          {source.summary}
        </div>
      )}
      {Array.isArray(data.sourcesCited) && data.sourcesCited.length > 0 && (
        <div style={{ fontSize: 11, color: "#8a8a9a" }}>
          {t(locale, "prestige.sources")}: {data.sourcesCited.map((s, i) => (
            <a key={i} href={s} target="_blank" rel="noreferrer" style={{ color: "#90cdf4", marginLeft: 6 }}>
              {(() => { try { return new URL(s).hostname; } catch { return s; } })()}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
