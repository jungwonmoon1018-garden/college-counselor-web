import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NarrativeEditor from "./NarrativeEditor.jsx";

// The story editor's Delete sent DELETE /api/ec/narrative/<id>, a route the
// server never had: the student saw "Not found" and the story stayed active,
// still feeding the counselor and the activity reads. The server deletes the
// session's active narrative at DELETE /api/ec/narrative.
const STORY = "I care about making science readable for people who never had a lab, and I have shown it by tutoring at the library every weekend for two years.";

function stubBackend(calls) {
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = String(url).split("?")[0];
    const method = String(options.method || "GET").toUpperCase();
    calls.push(`${method} ${path}`);
    const reply = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => body,
      text: async () => (body == null ? "" : JSON.stringify(body)),
    });
    if (method === "GET" && path === "/api/ec/narrative/active") return reply(200, { id: "nar_1", narrative_text: STORY, created_at: "2026-10-01T00:00:00Z", source: "student" });
    if (method === "DELETE" && path === "/api/ec/narrative") return reply(204, null);
    return reply(404, { error: "Not found" });
  }));
}

describe("NarrativeEditor", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("deletes the active story through the session's narrative route", async () => {
    const calls = [];
    stubBackend(calls);
    const onSaved = vi.fn();
    render(<NarrativeEditor onSaved={onSaved} />);
    expect(await screen.findByDisplayValue(STORY)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete narrative" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null));
    expect(calls).toContain("DELETE /api/ec/narrative");
    expect(calls.some((c) => c.startsWith("DELETE /api/ec/narrative/"))).toBe(false);
    expect(screen.queryByDisplayValue(STORY)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete narrative" })).not.toBeInTheDocument();
    expect(screen.queryByText("Not found")).not.toBeInTheDocument();
  // Alone this takes well under a second; in the whole-suite run vitest
  // 4.1.11 queues each test's steps behind the other files' (see
  // AdminApp.test.jsx), and on 2026-10-09 it crossed the 5 s default.
  }, 20_000);

  // The server sends SQLite's "YYYY-MM-DD HH:MM:SS" in UTC. Read raw, Chrome
  // took it for local time (a 14:00 KST save read 05:00) and Safari showed
  // "Saved Invalid Date". The expected label is computed from the UTC instant,
  // so this holds in any time zone.
  it("shows the saved time as the viewer's local time", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = String(url).split("?")[0];
      const body = path === "/api/ec/narrative/active"
        ? { id: "nar_1", narrative_text: STORY, created_at: "2026-11-03 05:00:00", source: "student" }
        : { error: "Not found" };
      return { ok: path === "/api/ec/narrative/active", status: path === "/api/ec/narrative/active" ? 200 : 404, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) };
    }));
    render(<NarrativeEditor />);
    expect(await screen.findByDisplayValue(STORY)).toBeInTheDocument();
    const when = new Date("2026-11-03T05:00:00Z").toLocaleString("en-US");
    expect(screen.getByText((text) => text.includes(when))).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  }, 20_000);
});
