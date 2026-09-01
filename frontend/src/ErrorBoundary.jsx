import { Component } from "react";

// Last-resort catch for render-time exceptions. Without a boundary, React
// unmounts the entire tree on the first render crash and the student is left
// staring at a blank page with no explanation. Vault + server state are
// untouched by a crash, so a reload recovers everything.
export default class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error("[ui] render crash:", error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0f", fontFamily: "system-ui, sans-serif", padding: 20 }}>
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 20, color: "#e8e6e3", margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#8a8a9a", lineHeight: 1.6, margin: "0 0 18px" }}>
            The page hit an unexpected error. Your data is safe — reloading brings you right back.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "10px 22px", borderRadius: 10, border: "none", background: "linear-gradient(135deg,#378ADD,#667eea)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
          >
            Reload
          </button>
          <details style={{ marginTop: 16, textAlign: "left" }}>
            <summary style={{ fontSize: 11, color: "#555", cursor: "pointer" }}>Technical details</summary>
            <pre style={{ fontSize: 10, color: "#666", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(this.state.error?.stack || this.state.error)}</pre>
          </details>
        </div>
      </main>
    );
  }
}
