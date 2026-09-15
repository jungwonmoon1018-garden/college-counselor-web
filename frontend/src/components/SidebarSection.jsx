// A collapsible section of the sidebar: the same small uppercase heading
// the sidebar always had, now a button with a chevron that folds the
// section's content away. Each section remembers its state in
// localStorage, so the sidebar stays the way the student left it across
// reloads (a per-device convenience; nothing else depends on it). The
// heading row can carry an action on the right (the "+ New" chat button).
import { useState } from "react";

const STORAGE_KEY = "cc.sidebar.collapsed";

function readCollapsed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCollapsed(id, collapsed) {
  try {
    const all = readCollapsed();
    if (collapsed) all[id] = true;
    else delete all[id];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage can be unavailable (private windows); the section still toggles.
  }
}

export default function SidebarSection({ id, title, count, action, defaultOpen = true, style, children }) {
  const [open, setOpen] = useState(() => (Object.prototype.hasOwnProperty.call(readCollapsed(), id) ? false : defaultOpen));
  const toggle = () => {
    setOpen((current) => {
      writeCollapsed(id, current);
      return !current;
    });
  };
  const contentId = `sidebar-section-${id}`;
  return (
    <section style={{ marginBottom: open ? 14 : 6, ...style }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: open ? 8 : 0 }}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={contentId}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 0", minWidth: 0,
            background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
            color: "#6a6a7a", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "left",
          }}
        >
          <span aria-hidden="true" style={{ display: "inline-block", width: 10, fontSize: 8, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
          <span>{title}{count != null ? ` (${count})` : ""}</span>
        </button>
        {action}
      </div>
      <div id={contentId} hidden={!open}>{children}</div>
    </section>
  );
}
