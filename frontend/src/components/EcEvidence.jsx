import { useEffect, useState } from "react";
import { ec as ecApi } from "../api.js";

// ═══════════════════════════════════════════════════════════════════════
// EcEvidence — the files linked to one activity as the EC strength read
// sees them: a certificate, letter or write-up the student attached in chat
// (filed to the activity it named) or uploaded directly. Self-fetches
// GET /api/ec/strength/:ecName, where the attachments ride along with the
// vector. Each file has a remove control (DELETE /api/ec/attachments/:id):
// a wrong or sensitive upload used to stay, and keep counting, until the
// whole account was deleted. ChatEvidenceSync is the button that reads every
// past chat upload into the activities they name and says what happened.
// ═══════════════════════════════════════════════════════════════════════

export default function EcEvidence({ ecName, refreshKey = 0, onRemoved }) {
  const [rows, setRows] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    setRows(null);
    setNote("");
    (async () => {
      try {
        const r = await ecApi.evidence(ecName);
        if (alive) setRows(Array.isArray(r?.attachments) ? r.attachments : []);
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => { alive = false; };
  }, [ecName, refreshKey]);

  const remove = async (a) => {
    if (!a?.id || removing) return;
    // Removing evidence cannot be undone, so the student confirms it.
    const ok = typeof window === "undefined" || typeof window.confirm !== "function"
      || window.confirm(`Remove ${a.filename || "this file"} from ${ecName}'s evidence? It will no longer count toward this activity, and a direct upload is deleted from the server.`);
    if (!ok) return;
    setRemoving(a.id);
    setNote("");
    try {
      await ecApi.removeAttachment(a.id);
      setRows((current) => (current || []).filter((row) => row.id !== a.id));
      if (onRemoved) onRemoved(a);
    } catch (err) {
      setNote(err?.body?.error || err?.message || "Could not remove the file.");
    } finally {
      setRemoving(null);
    }
  };

  if (rows === null) return null;
  return (
    <div data-testid="ec-evidence" style={{ fontSize: 11, color: "#8a8a9a", padding: "6px 2px 0", lineHeight: 1.5 }}>
      <span style={{ color: "#6a6a7a" }}>Evidence: </span>
      {rows.length === 0
        ? <span>none linked yet — attach a certificate, letter or write-up in chat and name this activity in your message.</span>
        : rows.map((a, i) => (
          <span key={a.id || a.filename}>
            {i > 0 ? " " : ""}📎 {a.filename}{a.origin === "chat" ? " (from chat)" : ""}{a.uploaded_at ? ` · ${String(a.uploaded_at).slice(0, 10)}` : ""}
            {a.id && (
              <button
                type="button"
                onClick={() => remove(a)}
                disabled={removing === a.id}
                aria-label={`Remove ${a.filename || "file"}`}
                title="Remove this file from the activity's evidence"
                style={{ fontSize: 10, color: removing === a.id ? "#666" : "#b58a6a", background: "transparent", border: "none", padding: "0 0 0 4px", cursor: removing === a.id ? "default" : "pointer" }}
              >
                {removing === a.id ? "removing…" : "remove"}
              </button>
            )}
          </span>
        ))}
      {note && <div role="alert" style={{ fontSize: 10, color: "#c98a8a", marginTop: 2 }}>{note}</div>}
    </div>
  );
}

export function describeHarvest(r) {
  const parts = [];
  const linked = Array.isArray(r?.linked) ? r.linked : [];
  const unmatched = Array.isArray(r?.unmatched) ? r.unmatched : [];
  const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
  const nameOnly = Array.isArray(r?.nameOnly) ? r.nameOnly : [];
  if (linked.length) parts.push(`Linked ${linked.length} file${linked.length > 1 ? "s" : ""}: ${linked.map((l) => `${l.name} → ${l.ecName}`).join(", ")}.`);
  else parts.push("No new files to link.");
  if (unmatched.length) parts.push(`${unmatched.length} named no activity (${unmatched.map((u) => u.name).join(", ")}) — mention the activity in your message when you attach a file.`);
  const removed = skipped.filter((sk) => sk?.reason === "removed");
  const already = skipped.length - removed.length;
  if (already) parts.push(`${already} already linked.`);
  if (removed.length) parts.push(`${removed.length} you removed earlier stayed removed (${removed.map((sk) => sk.name).join(", ")}).`);
  if (nameOnly.length) {
    const many = nameOnly.length > 1;
    parts.push(`${nameOnly.length} older upload${many ? "s" : ""} kept only ${many ? "their names" : "its name"} (${nameOnly.map((n) => n.name).join(", ")}) — attach ${many ? "them" : "it"} again in chat to link ${many ? "them" : "it"}.`);
  }
  return parts.join(" ");
}

export function ChatEvidenceSync({ onLinked }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const run = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await ecApi.readChatUploads();
      setNote(describeHarvest(r));
      if (r?.linked?.length && onLinked) onLinked(r);
    } catch (err) {
      setNote(err?.body?.error || err?.message || "Could not read the chat uploads.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        title="Files you attached in chat — certificates, award letters, write-ups — are read into the activity they name, so the strength read and the prestige rationale can use them"
        style={{ fontSize: 10.5, color: busy ? "#666" : "#6a8ab5", background: "transparent", border: "1px solid rgba(99,179,237,0.18)", borderRadius: 6, padding: "3px 9px", cursor: busy ? "default" : "pointer" }}
      >
        {busy ? "Reading chat uploads…" : "Read chat uploads into activities"}
      </button>
      {note && <div role="status" style={{ fontSize: 10, color: "#9a9aa8", marginTop: 4, lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}
