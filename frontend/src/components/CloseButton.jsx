// The close control every dismissible surface in the student app shares,
// in the style of the Claude Code interface: a bare "×" glyph in the corner
// of a card, banner, toast or dialog, muted until hovered or focused, with a
// full-size hit target and an accessible name. Before this, the tool cards
// had a bordered "✕" pill, the drift banner a text button, the dialog a
// text "Close" button and the session toasts nothing at all.
import { useState } from "react";

export default function CloseButton({ label, onClick, size = 28, style }) {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      style={{
        width: size, height: size, flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        padding: 0, border: "none", borderRadius: 6,
        background: hot ? "rgba(255,255,255,0.08)" : "transparent",
        color: hot ? "#e8e6e3" : "#8a8a9a",
        fontSize: Math.round(size * 0.64), lineHeight: 1, cursor: "pointer",
        transition: "background 0.15s, color 0.15s",
        ...style,
      }}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
}
