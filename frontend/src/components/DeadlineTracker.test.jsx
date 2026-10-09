import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DeadlineTracker from "./DeadlineTracker.jsx";

// The form says up front what the server holds a deadline to (a 200-character
// name, a date from 2000-01-01 through six years out), and a refusal's
// friendlyMessage still reaches the student.
describe("DeadlineTracker", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
      const path = String(url).split("?")[0];
      if (path === "/api/students/deadlines" && (opts.method || "GET") === "GET") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, deadlines: [] }) };
      }
      if (path === "/api/students/deadlines" && opts.method === "POST") {
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: "dueAt must fall between 2000-01-01 and 2032-10-09", friendlyMessage: "Pick a date between 2000-01-01 and 2032-10-09." }) };
      }
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: "unexpected request" }) };
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("limits the name and the date the way the server does, and shows a refusal", async () => {
    render(<DeadlineTracker locale="en-US" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add deadline" }));
    const title = screen.getByLabelText("Title");
    expect(title).toHaveAttribute("maxLength", "200");
    const date = screen.getByLabelText("Deadlines");
    expect(date).toHaveAttribute("min", "2000-01-01");
    const latest = new Date();
    latest.setUTCFullYear(latest.getUTCFullYear() + 6);
    expect(date).toHaveAttribute("max", latest.toISOString().slice(0, 10));

    fireEvent.change(title, { target: { value: "Finish the MIT essay draft" } });
    fireEvent.change(date, { target: { value: "2027-01-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick a date between 2000-01-01 and 2032-10-09.");
  // The whole-suite run queues each test's steps behind the other files'
  // (vitest 4.1.11; see AdminApp.test.jsx); alone this is well under 5 s.
  }, 20_000);
});
