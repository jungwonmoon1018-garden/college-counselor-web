import { useEffect, useState } from "react";
import { deadlines as deadlinesApi } from "../api.js";
import { t } from "../i18n.js";
import { daysUntilDue, dueSortKey, formatDueDate } from "../profile/dates.js";
import { DEADLINE_CATEGORIES, DEADLINE_EARLIEST_DATE, DEADLINE_TITLE_MAX, latestDeadlineDate } from "../profile/deadline-limits.js";

// ═══════════════════════════════════════════════════════════════════════
// DeadlineTracker — list/add/patch/delete student deadlines. summary lives
// on the GET response (overdue/dueIn7/dueIn30/friendlyMessage). Render the
// server's friendlyMessage verbatim. The server only started sending
// `summary` in 2026-11; before that the chat-top chip read a field that
// never arrived and never once rendered.
//
// A due date is a calendar date (profile/dates.js): it is sent as the
// YYYY-MM-DD the date input gives, shown as that date in every time zone
// and counted in local calendar days, so "Overdue" appears only once the
// student's own due date has ended.
// ═══════════════════════════════════════════════════════════════════════

// A snoozed row's main button marks it done; "Reopen" wakes it. The main
// button used to send snoozed -> open while reading "Mark done".
const STATUS_NEXT = { open: "done", done: "open", snoozed: "done" };

// The server's categories, offered as a choice: free text outside these
// used to be replaced with "personal" without a word. Their labels live in
// i18n.js with the tracker's other strings; a stored category the app has
// no label for is shown as stored.
function categoryLabel(locale, category) {
  const key = `deadlines.category.${category}`;
  const label = t(locale, key);
  return label === key ? category : label;
}

export default function DeadlineTracker({ locale = "en-US", compact = false, refreshKey = 0 }) {
  const [list, setList] = useState([]);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", dueAt: "", category: "", notes: "" });

  async function refresh() {
    setBusy(true); setErr("");
    try {
      const r = await deadlinesApi.list();
      setList(r.deadlines || r.list || []);
      setSummary(r.summary || null);
    } catch (e) {
      setErr(e.body?.friendlyMessage || e.message || "Failed to load deadlines.");
    } finally { setBusy(false); }
  }

  // Reload on mount and whenever the parent bumps refreshKey (e.g. a school was
  // removed from the college list and its deadlines were cascade-deleted).
  useEffect(() => { refresh(); }, [refreshKey]);

  async function save() {
    if (!draft.title.trim() || !draft.dueAt) return;
    setBusy(true); setErr("");
    try {
      await deadlinesApi.create({
        title: draft.title.trim(),
        // The date input's own YYYY-MM-DD: toISOString() made it UTC
        // midnight, the previous evening anywhere in the Americas.
        dueAt: draft.dueAt,
        category: draft.category || undefined,
        notes: draft.notes || undefined,
      });
      setDraft({ title: "", dueAt: "", category: "", notes: "" });
      setAdding(false);
      await refresh();
    } catch (e) {
      setErr(e.body?.friendlyMessage || e.message || "Failed to save deadline.");
    } finally { setBusy(false); }
  }

  async function patch(id, body) {
    setBusy(true); setErr("");
    try {
      await deadlinesApi.patch(id, body);
      await refresh();
    } catch (e) {
      setErr(e.body?.friendlyMessage || e.message || "Failed to update deadline.");
    } finally { setBusy(false); }
  }

  async function remove(id) {
    setBusy(true); setErr("");
    try {
      await deadlinesApi.delete(id);
      await refresh();
    } catch (e) {
      setErr(e.body?.friendlyMessage || e.message || "Failed to delete deadline.");
    } finally { setBusy(false); }
  }

  // Compact summary chip — used at the top of CHAT.
  if (compact) {
    if (!summary || (summary.overdue === 0 && summary.dueIn7 === 0)) return null;
    const isOverdue = summary.overdue > 0;
    return (
      <div style={{
        fontSize: 12,
        padding: "6px 12px",
        borderRadius: 999,
        background: isOverdue ? "rgba(245,101,101,0.1)" : "rgba(237,137,54,0.1)",
        color: isOverdue ? "#fed7d7" : "#fbd38d",
        border: `1px solid ${isOverdue ? "rgba(245,101,101,0.2)" : "rgba(237,137,54,0.2)"}`,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}>
        {summary.friendlyMessage || `${summary.overdue} overdue, ${summary.dueIn7} due in 7d`}
      </div>
    );
  }

  // Surface the most urgent first: overdue/soonest at the top, completed last.
  const sorted = [...list].sort((a, b) => {
    const aDone = a.status === "done", bDone = b.status === "done";
    if (aDone !== bDone) return aDone ? 1 : -1;
    return dueSortKey(a.dueAt || a.due_at) - dueSortKey(b.dueAt || b.due_at);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>
          {t(locale, "deadlines.title")}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setAdding((v) => !v)} style={{
          fontSize: 13, padding: "6px 12px", borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.1)",
          background: "transparent", color: "#e0e0e0", cursor: "pointer",
        }}>
          {t(locale, "deadlines.add")}
        </button>
      </div>
      {summary?.friendlyMessage && (
        <div style={{ fontSize: 12, color: "#8a8a9a", padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          {summary.friendlyMessage}
        </div>
      )}
      {adding && (
        <div style={{ padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            value={draft.title}
            onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
            placeholder={t(locale, "deadlines.title_field")}
            aria-label={t(locale, "deadlines.title_field")}
            maxLength={DEADLINE_TITLE_MAX}
            style={inp}
          />
          <input
            type="date"
            min={DEADLINE_EARLIEST_DATE}
            max={latestDeadlineDate()}
            value={draft.dueAt}
            onChange={(e) => setDraft((p) => ({ ...p, dueAt: e.target.value }))}
            aria-label={t(locale, "deadlines.title")}
            style={inp}
          />
          <select
            value={draft.category}
            onChange={(e) => setDraft((p) => ({ ...p, category: e.target.value }))}
            aria-label={t(locale, "deadlines.category_field")}
            style={inp}
          >
            <option value="">{t(locale, "deadlines.category_field")}</option>
            {DEADLINE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{categoryLabel(locale, c)}</option>
            ))}
          </select>
          <input
            value={draft.notes}
            onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
            placeholder={t(locale, "deadlines.notes_field")}
            aria-label={t(locale, "deadlines.notes_field")}
            style={inp}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} disabled={busy || !draft.title.trim() || !draft.dueAt} style={{
              fontSize: 13, padding: "8px 14px", borderRadius: 8, border: "none",
              background: draft.title.trim() && draft.dueAt && !busy ? "linear-gradient(135deg,#378ADD,#667eea)" : "rgba(255,255,255,0.04)",
              color: draft.title.trim() && draft.dueAt && !busy ? "#fff" : "#444",
              cursor: draft.title.trim() && draft.dueAt && !busy ? "pointer" : "default", fontWeight: 600,
            }}>{t(locale, "deadlines.save")}</button>
            <button onClick={() => setAdding(false)} style={{
              fontSize: 13, padding: "8px 14px", borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.1)", background: "transparent",
              color: "#8a8a9a", cursor: "pointer",
            }}>{t(locale, "deadlines.cancel")}</button>
          </div>
        </div>
      )}
      {err && <div role="alert" style={{ fontSize: 13, color: "#f56565" }}>{err}</div>}
      {busy && list.length === 0 && (
        <div aria-live="polite" style={{ fontSize: 13, color: "#8a8a9a", padding: "12px 14px" }}>…</div>
      )}
      {list.length === 0 && !busy && (
        <div style={{ fontSize: 13, color: "#8a8a9a", padding: "12px 14px", borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          {t(locale, "deadlines.empty")}
        </div>
      )}
      {sorted.map((d) => {
        const days = daysUntilDue(d.dueAt || d.due_at);
        const overdue = days != null && days < 0;
        const isDone = d.status === "done";
        const isSnoozed = d.status === "snoozed";
        const dueLabel = formatDueDate(d.dueAt || d.due_at, locale);
        return (
          <div key={d.id} style={{
            padding: "12px 14px", borderRadius: 10,
            background: isDone ? "rgba(104,211,145,0.04)" : "rgba(255,255,255,0.02)",
            border: `1px solid ${isDone ? "rgba(104,211,145,0.12)" : "rgba(255,255,255,0.06)"}`,
            opacity: isDone ? 0.7 : 1,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, fontSize: 14, color: "#fff", textDecoration: isDone ? "line-through" : "none" }}>
                {d.title}
              </div>
              <span style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                color: overdue ? "#fed7d7" : days <= 7 ? "#fbd38d" : "#cbd5e0",
                background: overdue ? "rgba(245,101,101,0.1)" : days <= 7 ? "rgba(237,137,54,0.1)" : "rgba(255,255,255,0.04)",
              }}>
                {overdue ? t(locale, "deadlines.overdue_chip") : t(locale, "deadlines.due_chip", { days })}
              </span>
            </div>
            {(dueLabel || d.category) && (
              <div style={{ fontSize: 11, color: "#8a8a9a", marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {dueLabel && <span>{dueLabel}</span>}
                {d.category && <span style={{ opacity: 0.7 }}>· {categoryLabel(locale, d.category)}</span>}
              </div>
            )}
            {d.notes && (
              <div style={{ fontSize: 12, color: "#8a8a9a", marginTop: 6 }}>{d.notes}</div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={() => patch(d.id, { status: STATUS_NEXT[d.status || "open"] })} style={btn}>
                {isDone ? t(locale, "deadlines.reopen") : t(locale, "deadlines.mark_done")}
              </button>
              {!isDone && !isSnoozed && (
                <button onClick={() => patch(d.id, { status: "snoozed" })} style={btn}>
                  {t(locale, "deadlines.snooze")}
                </button>
              )}
              {isSnoozed && (
                <button onClick={() => patch(d.id, { status: "open" })} style={btn}>
                  {t(locale, "deadlines.reopen")}
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button
                onClick={() => { if (window.confirm(t(locale, "deadlines.remove_confirm", { title: d.title }))) remove(d.id); }}
                style={{ ...btn, color: "#f56565", borderColor: "rgba(245,101,101,0.2)" }}
              >
                {t(locale, "deadlines.remove")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const inp = {
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.02)",
  color: "#e0e0e0",
  fontSize: 13,
};

const btn = {
  fontSize: 11,
  padding: "5px 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "transparent",
  color: "#cbd5e0",
  cursor: "pointer",
};
