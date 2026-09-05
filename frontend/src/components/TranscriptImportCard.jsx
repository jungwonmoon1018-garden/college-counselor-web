import { useState } from "react";
import { summarizeParsedTranscript } from "../transcript-utils.js";

// Inline chat card offered after a student attaches a transcript: reads the
// courses deterministically (the same parser the profile editor uses — grades
// are never guessed; an unreadable grade becomes "in progress") and lets the
// student add them to the profile in one click.
export default function TranscriptImportCard({ file, onParse, onImport }) {
  const [state, setState] = useState({ phase: "idle", parsed: null, error: "", result: null });

  const parse = async () => {
    setState({ phase: "parsing", parsed: null, error: "", result: null });
    try {
      const parsed = await onParse(file);
      setState({ phase: "parsed", parsed, error: "", result: null });
    } catch (err) {
      setState({ phase: "idle", parsed: null, error: err?.message || "Couldn't read this transcript.", result: null });
    }
  };
  const importAll = () => {
    const result = onImport(state.parsed);
    setState((s) => ({ ...s, phase: "done", result }));
  };

  const groups = state.parsed ? summarizeParsedTranscript(state.parsed.courses) : [];
  const total = groups.reduce((n, g) => n + g.courses.length, 0);
  const label = (y) => y === "unknown" ? "Year not stated" : y.charAt(0).toUpperCase() + y.slice(1);

  return (
    <div style={{ fontSize: 12, color: "#cfd5e0", lineHeight: 1.5 }}>
      <div style={{ marginBottom: 8 }}>
        <strong>{file.name}</strong> looks like a transcript. I can read its courses and grades into your profile — grades are copied exactly as they appear, and a course without a final grade is saved as <em>in progress</em>.
      </div>
      {state.phase === "idle" && (
        <button onClick={parse} style={{ fontSize: 11, color: "#63b3ed", background: "rgba(55,138,221,0.08)", border: "1px solid rgba(55,138,221,0.3)", borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}>
          📥 Read the courses from this transcript
        </button>
      )}
      {state.phase === "parsing" && <div style={{ color: "#8a8a9a" }}>Reading transcript…</div>}
      {state.error && <div style={{ color: "#fc8181", marginTop: 6 }}>{state.error}</div>}
      {(state.phase === "parsed" || state.phase === "done") && state.parsed && (
        <div style={{ marginTop: 6 }}>
          {state.parsed.gpa != null && <div style={{ color: "#8a8a9a", marginBottom: 4 }}>Transcript GPA: {state.parsed.gpa}</div>}
          {groups.map((g) => (
            <div key={g.year} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: "#6a6a7a", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label(g.year)} · {g.courses.length}</div>
              {g.courses.map((c, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                  <span><span style={{ color: c.type === "ap" ? "#f6ad55" : "#666" }}>{c.type === "ap" && !/^ap\s+/i.test(c.name) ? "AP " : ""}</span>{c.name}</span>
                  <span style={{ color: c.grade === "IP" ? "#8a8a9a" : "#63b3ed", fontWeight: 600 }}>{c.grade === "IP" ? "in progress" : c.grade}</span>
                </div>
              ))}
            </div>
          ))}
          {Array.isArray(state.parsed.warnings) && state.parsed.warnings.length > 0 && (
            <div style={{ fontSize: 10, color: "#f6ad55", marginTop: 4 }}>{state.parsed.warnings.join(" ")}</div>
          )}
          {state.phase === "parsed" && total > 0 && (
            <button onClick={importAll} style={{ marginTop: 8, fontSize: 11, color: "#68d391", background: "rgba(104,211,145,0.08)", border: "1px solid rgba(104,211,145,0.3)", borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}>
              ✓ Add {total} course{total === 1 ? "" : "s"} to my profile
            </button>
          )}
          {state.phase === "parsed" && total === 0 && <div style={{ color: "#8a8a9a" }}>No courses could be read from this document.</div>}
          {state.phase === "done" && state.result && (
            <div style={{ marginTop: 8, color: "#9ae6b4" }}>
              Added {state.result.added} course{state.result.added === 1 ? "" : "s"}
              {state.result.skipped ? ` · ${state.result.skipped} already on your profile` : ""}
              {state.result.unplaced ? ` · ${state.result.unplaced} left out (no school year stated — add them in Edit profile)` : ""}
              . Double-click any course in the sidebar to fix a grade.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
