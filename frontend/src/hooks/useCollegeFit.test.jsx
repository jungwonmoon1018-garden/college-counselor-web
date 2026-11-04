import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCollegeFit } from "./useCollegeFit.js";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const user = { email: "jiyeon@school.edu" };
const EIGHT = ["Rice University", "Duke University", "Emory University", "Tufts University", "Brown University", "Yale University", "Vanderbilt University", "Northwestern University"];

describe("useCollegeFit target schools", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", memoryStorage()); });
  afterEach(() => vi.unstubAllGlobals());

  // ui-9: the ninth school used to be cut from the list by slice(0, 8) after
  // the input had cleared, while its deadlines were still created.
  it("takes no ninth school: the list, the input and the deadlines stay as they were", async () => {
    window.localStorage.setItem(`cc_targets_${user.email}`, JSON.stringify(EIGHT));
    const { result } = renderHook(() => useCollegeFit({ data: {}, locale: "en-US", user }));
    await waitFor(() => expect(result.current.targetSchools).toHaveLength(8));
    const createDeadlines = vi.fn();
    result.current.createDeadlinesRef.current = createDeadlines;
    act(() => result.current.setTargetSchoolInput("Stanford University"));
    let outcome;
    act(() => { outcome = result.current.addTargetSchool("Stanford University"); });
    expect(outcome).toBe("full");
    expect(result.current.targetSchools).toEqual(EIGHT);
    expect(JSON.parse(window.localStorage.getItem(`cc_targets_${user.email}`))).toEqual(EIGHT);
    expect(createDeadlines).not.toHaveBeenCalled();
    expect(result.current.targetSchoolInput).toBe("Stanford University");
    // A school already on the full list is still the quiet no-op it was.
    act(() => { outcome = result.current.addTargetSchool("rice university"); });
    expect(outcome).toBe("duplicate");
    expect(createDeadlines).not.toHaveBeenCalled();
  });

  it("adds the eighth school and hands the deadline creator the list it joined", async () => {
    window.localStorage.setItem(`cc_targets_${user.email}`, JSON.stringify(EIGHT.slice(0, 7)));
    const { result } = renderHook(() => useCollegeFit({ data: {}, locale: "en-US", user }));
    await waitFor(() => expect(result.current.targetSchools).toHaveLength(7));
    const createDeadlines = vi.fn();
    result.current.createDeadlinesRef.current = createDeadlines;
    act(() => { result.current.addTargetSchool("Northwestern University"); });
    expect(result.current.targetSchools).toEqual(EIGHT);
    expect(createDeadlines).toHaveBeenCalledWith("Northwestern University", { targetSchools: EIGHT });
  });
});

// fit-11 in the hook: the double-check and the profile refresh answer only
// for the read that is still shown.
describe("useCollegeFit lookups", () => {
  let routes;
  let calls;

  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    window.__CC_SESSION_TOKEN__ = "tok_test";
    routes = {};
    calls = [];
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      const body = JSON.parse(options.body);
      const path = String(url);
      const kind = path.includes("/api/colleges/values") ? "values" : path.includes("/api/positioning/verify") ? "verify" : "positioning";
      const school = body.collegeName || body.schoolName || body.targets?.[0]?.schoolName;
      calls.push(`${kind}:${school}`);
      const route = routes[`${kind}:${school}`];
      return route ? route() : Promise.resolve(reply({}));
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  function mount(data = { profile: { gpa: { unweighted: 3.9 } } }) {
    const hook = renderHook(({ d }) => {
      const fit = useCollegeFit({ data: d, locale: "en-US", user });
      fit.lookupCollegeRef.current = fit.lookupCollege;
      return fit;
    }, { initialProps: { d: data } });
    return hook;
  }

  it("drops a double-check that answers after the student moved to another school", async () => {
    routes["values:Harvard"] = () => Promise.resolve(reply({ displayName: "Harvard University", values: [] }));
    routes["positioning:Harvard"] = () => Promise.resolve(reply({ targets: [{ schoolName: "Harvard University", overallPositioningLabel: "High reach" }] }));
    routes["values:Ohio State"] = () => Promise.resolve(reply({ displayName: "The Ohio State University", values: [] }));
    routes["positioning:Ohio State"] = () => Promise.resolve(reply({ targets: [{ schoolName: "The Ohio State University", overallPositioningLabel: "Competitive" }] }));
    const lateVerify = deferred();
    routes["verify:Harvard University"] = () => lateVerify.promise;
    const { result } = mount();
    await act(async () => { await result.current.lookupCollege("Harvard"); });
    let verifying;
    act(() => { verifying = result.current.verifyCollegeFit("Harvard University"); });
    expect(result.current.collegeVerifying).toBe(true);
    await act(async () => { await result.current.lookupCollege("Ohio State"); });
    expect(result.current.collegeVerifying).toBe(false);
    await act(async () => {
      lateVerify.resolve(reply({ verdict: "discrepancies_found", checks: [] }));
      await verifying;
    });
    expect(result.current.collegeVerification).toBe(null);
    expect(result.current.collegeVerifying).toBe(false);
    expect(result.current.collegePositioning.overallPositioningLabel).toBe("Competitive");
  });

  it("clearing the card drops the lookup still in flight", async () => {
    routes["values:Rice"] = () => Promise.resolve(reply({ displayName: "Rice University", values: [] }));
    const slow = deferred();
    routes["positioning:Rice"] = () => slow.promise;
    const { result } = mount();
    let lookup;
    act(() => { lookup = result.current.lookupCollege("Rice"); });
    await waitFor(() => expect(calls).toContain("positioning:Rice"));
    act(() => result.current.setCollegeValues(null));
    expect(result.current.collegePositioningLoading).toBe(false);
    await act(async () => {
      slow.resolve(reply({ targets: [{ schoolName: "Rice University", overallPositioningLabel: "Reach" }] }));
      await lookup;
    });
    expect(result.current.collegePositioning).toBe(null);
    expect(result.current.collegeValues).toBe(null);
  });

  // A profile sync that lands while the student's lookup of a new school is
  // still out used to re-read the card being replaced, superseding the
  // student's lookup with the previous school.
  it("a profile refresh during a lookup restarts that lookup, not the card it replaces", async () => {
    routes["values:Harvard"] = () => Promise.resolve(reply({ displayName: "Harvard University", values: [] }));
    routes["positioning:Harvard"] = () => Promise.resolve(reply({ targets: [{ schoolName: "Harvard University", overallPositioningLabel: "High reach" }] }));
    const slowOsu = deferred();
    routes["values:Ohio State"] = () => slowOsu.promise;
    routes["positioning:Ohio State"] = () => Promise.resolve(reply({ targets: [{ schoolName: "The Ohio State University", overallPositioningLabel: "Competitive" }] }));
    const { result, rerender } = mount();
    await act(async () => { await result.current.lookupCollege("Harvard"); });
    act(() => { result.current.lookupCollege("Ohio State"); });
    const moved = { profile: { gpa: { unweighted: 3.95 } } };
    rerender({ d: moved });
    act(() => result.current.refreshCollegeFit(moved));
    expect(calls.filter((c) => c === "values:Ohio State")).toHaveLength(2);
    expect(calls.filter((c) => c === "values:Harvard")).toHaveLength(1);
    await act(async () => { slowOsu.resolve(reply({ displayName: "The Ohio State University", values: [] })); });
    await waitFor(() => expect(result.current.collegePositioning?.overallPositioningLabel).toBe("Competitive"));
    expect(result.current.collegeValues.displayName).toBe("The Ohio State University");
  });

  // fit-7: a card standing on the fit read alone is re-read after a profile
  // change too, by the name the student looked up.
  it("re-reads a positioning-only card after the profile changes", async () => {
    routes["values:UT Austin"] = () => Promise.resolve(reply({ error: "budget", code: "budget_exceeded" }, 402));
    routes["positioning:UT Austin"] = () => Promise.resolve(reply({ targets: [{ schoolName: "The University of Texas at Austin", overallPositioningLabel: "Competitive" }] }));
    const { result, rerender } = mount();
    await act(async () => { await result.current.lookupCollege("UT Austin"); });
    expect(result.current.collegeValues).toMatchObject({ code: "budget_exceeded", status: 402 });
    const moved = { profile: { gpa: { unweighted: 3.95 } } };
    rerender({ d: moved });
    await act(async () => { result.current.refreshCollegeFit(moved); });
    await waitFor(() => expect(calls.filter((c) => c === "positioning:UT Austin")).toHaveLength(2));
    expect(result.current.collegeValues).toMatchObject({ code: "budget_exceeded" });
    expect(result.current.collegePositioning.overallPositioningLabel).toBe("Competitive");
  });
});
