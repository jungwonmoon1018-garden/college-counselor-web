import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCollegeFit } from "./useCollegeFit.js";

// The sidebar's "Clear cached college values" deleted every school's read
// for every student while its dialog said it cleared this account's (ui-8).
// Its replacement re-reads only the school on the card, with force, and
// never sends a DELETE.
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("re-reading one school's values", () => {
  let calls;

  beforeEach(() => {
    calls = [];
    window.__CC_SESSION_TOKEN__ = "tok";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.__CC_SESSION_TOKEN__ = null;
  });

  it("posts force for the shown school only, and paints the new read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
      return reply({ displayName: "Rice University", values: [{ theme: "Fresh" }], cached: false });
    }));
    const { result } = renderHook(() => useCollegeFit({ data: {}, locale: "ko", user: { email: "s@x.edu" } }));
    act(() => result.current.setCollegeValues({ displayName: "Rice University", values: [{ theme: "Old" }], cached: true }));

    let outcome;
    await act(async () => { outcome = await result.current.rereadCollegeValues(); });
    expect(outcome).toEqual({ ok: true, status: 200, code: null });
    expect(calls).toEqual([{ url: "/api/colleges/values", method: "POST", body: { collegeName: "Rice University", force: true } }]);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(result.current.collegeValues.values[0].theme).toBe("Fresh");
    expect(result.current.collegeValues.refreshedAt).toBeTruthy();
  });

  it("a failed re-read keeps the card as it was and says what happened", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "budget", code: "budget_exceeded" }, 402)));
    const { result } = renderHook(() => useCollegeFit({ data: {}, locale: "en-US", user: { email: "s@x.edu" } }));
    const shown = { displayName: "Rice University", values: [{ theme: "Old" }], cached: true };
    act(() => result.current.setCollegeValues(shown));
    let outcome;
    await act(async () => { outcome = await result.current.rereadCollegeValues(); });
    expect(outcome).toEqual({ ok: false, status: 402, code: "budget_exceeded" });
    expect(result.current.collegeValues).toEqual(shown);
    expect(result.current.collegeValuesLoading).toBe(false);
  });

  it("with no school on the card it sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCollegeFit({ data: {}, locale: "en-US", user: { email: "s@x.edu" } }));
    let outcome;
    await act(async () => { outcome = await result.current.rereadCollegeValues(); });
    expect(outcome.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
