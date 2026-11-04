import { afterEach, describe, expect, it, vi } from "vitest";
import { deadlines } from "./api.js";

// The deadline list is counted on the student's own calendar: the server
// takes ?today=YYYY-MM-DD and otherwise counts from Anywhere-on-Earth today,
// a day behind Seoul for most of the day.
describe("deadlines.list", () => {
  afterEach(() => { vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  it("sends the viewer's local date with the locale", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ deadlines: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    // Local time, so the expected date is the one on this machine's calendar.
    await deadlines.list({ now: new Date(2027, 0, 1, 23, 30) });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toMatch(/^\/api\/students\/deadlines\?today=2027-01-01&locale=/);
  });

  it("dates an update on the same calendar", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await deadlines.patch("d 1", { status: "snoozed" }, { now: new Date(2027, 0, 1, 0, 15) });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/students\/deadlines\/d%201\?today=2027-01-01&locale=/);
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
  });
});
