import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import DeadlineTracker from "./DeadlineTracker.jsx";

// The GET body exactly as the server sends it: backend
// tests/council-naming-deadlines-routes.test.js holds the live route to the
// same keys, so the chip cannot read a field the server never sends again
// (it read `summary` for a year while the server sent none).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST_FIXTURE = JSON.parse(fs.readFileSync(
  path.resolve(HERE, "..", "..", "..", "backend", "tests", "fixtures", "deadlines-list-response.json"), "utf8"));

function stubList(body, posts = []) {
  vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
    const p = String(url).split("?")[0];
    if (p === "/api/students/deadlines" && (opts.method || "GET") === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    if (p === "/api/students/deadlines" && opts.method === "POST") {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 201, text: async () => JSON.stringify({ ok: true, deadline: {} }) };
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: "unexpected request" }) };
  }));
}

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

describe("DeadlineTracker reads what the server sends", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("shows the chat-top chip from the server's summary", async () => {
    stubList(LIST_FIXTURE);
    render(<DeadlineTracker locale="en-US" compact />);
    expect(await screen.findByText(LIST_FIXTURE.summary.friendlyMessage)).toBeInTheDocument();
  }, 20_000);

  it("shows no chip when nothing is overdue or due this week", async () => {
    stubList({ ...LIST_FIXTURE, summary: { ...LIST_FIXTURE.summary, overdue: 0, dueIn7: 0, friendlyMessage: "Nothing soon." } });
    const { container } = render(<DeadlineTracker locale="en-US" compact />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  }, 20_000);

  // A typed date is a calendar date: shown as itself in any time zone, due
  // all through its own day on the student's clock, overdue only after.
  it("shows each due date as typed and counts days on the local calendar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 3, 23, 30)); // 23:30 local on Nov 3
    const today = { ...LIST_FIXTURE.deadlines[1], id: "d-today", title: "Portal check", dueAt: "2026-11-03", dueDate: "2026-11-03" };
    const legacy = { ...LIST_FIXTURE.deadlines[1], id: "d-legacy", title: "Old row", dueAt: "2026-11-10T00:00:00.000Z", dueDate: null };
    stubList({ ...LIST_FIXTURE, deadlines: [...LIST_FIXTURE.deadlines, today, legacy] });
    render(<DeadlineTracker locale="en-US" />);
    expect(await screen.findByText(LIST_FIXTURE.summary.friendlyMessage)).toBeInTheDocument();

    const row = (title) => screen.getByText(title).parentElement.parentElement;
    expect(within(row("Portal check")).getByText("Due in 0d")).toBeInTheDocument();
    expect(within(row("Portal check")).getByText("Nov 3, 2026")).toBeInTheDocument();
    expect(within(row("MIT — Early Action")).getByText("Due in 3d")).toBeInTheDocument();
    expect(within(row("MIT — Early Action")).getByText("Nov 6, 2026")).toBeInTheDocument();
    expect(within(row("Scholarship essay")).getByText("Overdue")).toBeInTheDocument();
    // A row saved as UTC midnight before 2026-11 still reads as its date.
    expect(within(row("Old row")).getByText("Nov 10, 2026")).toBeInTheDocument();
    expect(within(row("Old row")).getByText("Due in 7d")).toBeInTheDocument();
    expect(within(row("Scholarship essay")).getByText(/Financial aid/)).toBeInTheDocument();
  }, 20_000);

  it("sends the picked date as a date and a category from the server's list", async () => {
    const posts = [];
    stubList({ ...LIST_FIXTURE, deadlines: [] }, posts);
    render(<DeadlineTracker locale="en-US" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add deadline" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "FAFSA" } });
    fireEvent.change(screen.getByLabelText("Deadlines"), { target: { value: "2027-01-01" } });
    const category = screen.getByLabelText("Category");
    expect([...category.querySelectorAll("option")].map((o) => o.value)).toEqual(["", "personal", "admissions", "financial_aid", "test", "other"]);
    fireEvent.change(category, { target: { value: "financial_aid" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ title: "FAFSA", dueAt: "2027-01-01", category: "financial_aid" });
  }, 20_000);
});
