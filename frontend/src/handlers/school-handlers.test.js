import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelLookup, conveneStrategyCouncil, createDeadlinesForSchool, lookupCollege } from "./school-handlers.js";

// A promise the test resolves when it chooses, so two lookups can be made
// to answer out of order.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function lookupCtx() {
  return {
    data: { profile: { gpa: { unweighted: 3.9 } }, majorInterest: "History" },
    fitFingerprintRef: { current: "" },
    locale: "en-US",
    lookupStateRef: { current: { seq: 0, controller: null, pending: null, lastRequest: null } },
    setCollegePositioning: vi.fn(),
    setCollegePositioningLoading: vi.fn(),
    setCollegeValues: vi.fn(),
    setCollegeValuesLoading: vi.fn(),
    setCollegeVerification: vi.fn(),
    setCollegeVerifying: vi.fn(),
  };
}

const last = (fn) => fn.mock.calls[fn.mock.calls.length - 1]?.[0];

// fit-11: a second lookup started before the first answers must never paint
// the first school's read on the second school's card.
describe("lookupCollege", () => {
  let routes;
  let signals;

  beforeEach(() => {
    window.__CC_SESSION_TOKEN__ = "tok_test";
    routes = {};
    signals = [];
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      const body = JSON.parse(options.body);
      const school = body.collegeName || body.targets?.[0]?.schoolName;
      const kind = String(url).includes("/api/colleges/values") ? "values" : "positioning";
      signals.push({ kind, school, signal: options.signal });
      const route = routes[`${kind}:${school}`];
      return route ? route() : Promise.resolve(reply({}));
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  it("drops a late positioning answer for the school the student moved away from", async () => {
    const ctx = lookupCtx();
    const harvardPositioning = deferred();
    routes["values:Harvard"] = () => Promise.resolve(reply({ displayName: "Harvard University", values: [] }));
    routes["positioning:Harvard"] = () => harvardPositioning.promise;
    routes["values:Ohio State"] = () => Promise.resolve(reply({ displayName: "The Ohio State University", values: [] }));
    routes["positioning:Ohio State"] = () => Promise.resolve(reply({ targets: [{ schoolName: "The Ohio State University", overallPositioningLabel: "Competitive" }] }));

    const harvard = lookupCollege(ctx, "Harvard");
    // Harvard's values land and its positioning starts (the slow live read).
    await vi.waitFor(() => expect(signals.some((s) => s.kind === "positioning" && s.school === "Harvard")).toBe(true));
    await lookupCollege(ctx, "Ohio State");
    expect(last(ctx.setCollegePositioning)).toEqual({ schoolName: "The Ohio State University", overallPositioningLabel: "Competitive" });

    // Harvard answers last, with the label that used to overwrite the card.
    harvardPositioning.resolve(reply({ targets: [{ schoolName: "Harvard University", overallPositioningLabel: "High reach" }] }));
    await harvard;
    expect(last(ctx.setCollegePositioning)).toEqual({ schoolName: "The Ohio State University", overallPositioningLabel: "Competitive" });
    expect(last(ctx.setCollegeValues)).toEqual({ displayName: "The Ohio State University", values: [] });
    expect(ctx.setCollegePositioning.mock.calls.some(([p]) => p?.overallPositioningLabel === "High reach")).toBe(false);
    // The loading flags belong to the newest lookup: Ohio State cleared them
    // and Harvard's late finish did not touch them again.
    expect(last(ctx.setCollegePositioningLoading)).toBe(false);
    expect(last(ctx.setCollegeValuesLoading)).toBe(false);
    // The superseded request was aborted when the new one began.
    const harvardSignal = signals.find((s) => s.kind === "positioning" && s.school === "Harvard").signal;
    expect(harvardSignal?.aborted).toBe(true);
  });

  it("drops a late values answer and never asks for the old school's positioning", async () => {
    const ctx = lookupCtx();
    const harvardValues = deferred();
    routes["values:Harvard"] = () => harvardValues.promise;
    routes["values:Ohio State"] = () => Promise.resolve(reply({ displayName: "The Ohio State University", values: [] }));
    routes["positioning:Ohio State"] = () => Promise.resolve(reply({ targets: [{ schoolName: "The Ohio State University", overallPositioningLabel: "Competitive" }] }));

    const harvard = lookupCollege(ctx, "Harvard");
    await lookupCollege(ctx, "Ohio State");
    harvardValues.resolve(reply({ displayName: "Harvard University", values: [] }));
    await harvard;

    expect(ctx.setCollegeValues.mock.calls.some(([v]) => v?.displayName === "Harvard University")).toBe(false);
    expect(last(ctx.setCollegeValues)).toEqual({ displayName: "The Ohio State University", values: [] });
    expect(signals.some((s) => s.kind === "positioning" && s.school === "Harvard")).toBe(false);
    expect(last(ctx.setCollegePositioning).overallPositioningLabel).toBe("Competitive");
  });

  it("a cleared card takes nothing that answers late", async () => {
    const ctx = lookupCtx();
    const first = deferred();
    routes["values:Rice"] = () => Promise.resolve(reply({ displayName: "Rice University", values: [] }));
    routes["positioning:Rice"] = () => first.promise;
    const pending = lookupCollege(ctx, "Rice");
    await vi.waitFor(() => expect(signals.some((s) => s.kind === "positioning")).toBe(true));
    expect(ctx.lookupStateRef.current.pending).toEqual({ collegeName: "Rice", hintUrl: undefined });
    // The student clears the card while the read is still out.
    cancelLookup(ctx.lookupStateRef);
    expect(ctx.lookupStateRef.current.pending).toBe(null);
    first.resolve(reply({ targets: [{ schoolName: "Rice University", overallPositioningLabel: "Reach" }] }));
    await pending;
    expect(ctx.setCollegePositioning.mock.calls.some(([p]) => p?.overallPositioningLabel === "Reach")).toBe(false);
  });

  // fit-7: the values read failing (402 budget here) does not stop the fit
  // read, and the failure keeps its code so the card can say why.
  it("keeps the values error's code and still applies the positioning read", async () => {
    const ctx = lookupCtx();
    routes["values:UT Austin"] = () => Promise.resolve(reply({ error: "The monthly AI budget doesn't allow this lookup right now.", code: "budget_exceeded" }, 402));
    routes["positioning:UT Austin"] = () => Promise.resolve(reply({ targets: [{ schoolName: "The University of Texas at Austin", overallPositioningLabel: "Competitive" }] }));
    await lookupCollege(ctx, "UT Austin");
    expect(last(ctx.setCollegeValues)).toEqual({ error: "The monthly AI budget doesn't allow this lookup right now.", code: "budget_exceeded", status: 402 });
    expect(last(ctx.setCollegePositioning)).toEqual({ schoolName: "The University of Texas at Austin", overallPositioningLabel: "Competitive" });
  });

  // The server marks the payload, not the target, when a source failed while
  // the read was built; the card shows its "a source did not answer" line
  // only from the read it is handed.
  it("carries the payload's degraded flag onto the read the card shows", async () => {
    const ctx = lookupCtx();
    routes["positioning:Tufts"] = () => Promise.resolve(reply({ degraded: true, targets: [{ schoolName: "Tufts University", overallPositioningLabel: "Reach" }] }));
    await lookupCollege(ctx, "Tufts");
    expect(last(ctx.setCollegePositioning)).toEqual({ schoolName: "Tufts University", overallPositioningLabel: "Reach", degraded: true });
    const clean = lookupCtx();
    routes["positioning:Tufts"] = () => Promise.resolve(reply({ degraded: false, targets: [{ schoolName: "Tufts University", overallPositioningLabel: "Reach" }] }));
    await lookupCollege(clean, "Tufts");
    expect(last(clean.setCollegePositioning)).toEqual({ schoolName: "Tufts University", overallPositioningLabel: "Reach" });
  });

  it("clears the previous school's values when a new school is looked up, and keeps them on a refresh", async () => {
    const ctx = lookupCtx();
    routes["values:Rice"] = () => Promise.resolve(reply({ error: "boom" }, 502));
    await lookupCollege(ctx, "Rice");
    expect(ctx.setCollegeValues.mock.calls[0][0]).toBe(null);
    const refreshCtx = lookupCtx();
    await lookupCollege(refreshCtx, "Rice", undefined, { refresh: true });
    // A failed re-read keeps the card: nothing is written to the values.
    expect(refreshCtx.setCollegeValues).not.toHaveBeenCalled();
  });
});

// ui-9: a school that is not on the list it was added to gets no deadlines.
describe("createDeadlinesForSchool", () => {
  const eight = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"];

  it("creates nothing for a school the full list did not take", async () => {
    const authedFetch = vi.fn(async () => reply({}));
    await createDeadlinesForSchool({ authedFetch }, "Stanford University", { targetSchools: eight });
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it("creates the deadlines for a school on the list, matched without regard to case", async () => {
    const authedFetch = vi.fn(async (path) => (String(path).includes("/api/calendar/context")
      ? reply({ calendar: {}, schools: [] })
      : reply({ created: 4 })));
    await createDeadlinesForSchool({ authedFetch }, "Stanford University", { targetSchools: [...eight.slice(0, 7), "stanford university"] });
    const paths = authedFetch.mock.calls.map(([path]) => path);
    expect(paths).toEqual(["/api/calendar/context", "/api/students/deadlines/bulk"]);
    const items = JSON.parse(authedFetch.mock.calls[1][1].body).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.title.startsWith("Stanford University — "))).toBe(true);
  });

  it("runs as before when the caller passes no list", async () => {
    const authedFetch = vi.fn(async () => reply({}));
    await createDeadlinesForSchool({ authedFetch }, "Rice University");
    expect(authedFetch.mock.calls.map(([path]) => path)).toEqual(["/api/calendar/context", "/api/students/deadlines/bulk"]);
  });
});

// input-8 / ui-3: reminders are made for the student's own cycle, never
// dated in the past, and the student is told what was skipped. Every clock
// is injected; dates are local calendar dates.
describe("createDeadlinesForSchool dates reminders for the student's own cycle", () => {
  const NOV_3 = new Date(2026, 10, 3, 12, 0); // planning cycle 2026-27
  const bulkItems = (authedFetch) => JSON.parse(authedFetch.mock.calls.find(([p]) => p === "/api/students/deadlines/bulk")[1].body).items;

  it("gives a senior no Early reminder once Nov 1 has passed, and sends dates as dates", async () => {
    const authedFetch = vi.fn(async (path) => {
      if (String(path).includes("/api/calendar/context")) throw new Error("offline");
      return reply({ createdCount: 3, skippedItems: [] });
    });
    const notify = vi.fn();
    const result = await createDeadlinesForSchool({ authedFetch, notify }, "Rice University", { now: NOV_3 });
    const items = bulkItems(authedFetch);
    expect(items.map((i) => [i.title, i.dueAt])).toEqual([
      ["Rice University — Regular Decision (approximate — verify)", "2027-01-01"],
      ["Rice University — Financial aid (approximate — verify)", "2027-02-01"],
      ["Rice University — Commit by (approximate — verify)", "2027-05-01"],
    ]);
    expect(result.past).toEqual(["Early (EA/ED)"]);
    expect(notify).toHaveBeenCalledWith("Rice University: added 3 deadlines for Fall 2027 entry to your Deadlines list. Skipped Early (EA/ED): that date has already passed.");
  });

  it("carries a school's dates to a sophomore's cycle and labels them approximate", async () => {
    const typical2028 = { earlyEaEd: "2028-11-01", regularDecision: "2029-01-01", financialAidPriority: "2029-02-01", fafsaOpens: "2028-10-01", nationalDepositDeadline: "2029-05-01" };
    const authedFetch = vi.fn(async (path) => (String(path).includes("/api/calendar/context")
      ? reply({
        calendar: { typicalISO: { earlyEaEd: "2026-11-01" } },
        studentCycle: { cycle: "2028-29", startYear: 2028, entryYear: 2029, projected: true, typicalISO: typical2028 },
        schools: [{ school: "Harvard University", deadlines: { ed: "2026-11-01", rd: "2027-01-05" }, source: "https://college.harvard.edu/admissions", cycle: "2026-27" }],
      })
      : reply({ createdCount: 4, skippedItems: [] })));
    await createDeadlinesForSchool({ authedFetch }, "Harvard University", { now: NOV_3 });
    const items = bulkItems(authedFetch);
    expect(items.map((i) => [i.title, i.dueAt])).toEqual([
      ["Harvard University — Early (EA/ED) (approximate — for Fall 2029 entry)", "2028-11-01"],
      ["Harvard University — Regular Decision (approximate — for Fall 2029 entry)", "2029-01-05"],
      ["Harvard University — Financial aid (approximate — for Fall 2029 entry)", "2029-02-01"],
      ["Harvard University — Commit by (approximate — for Fall 2029 entry)", "2029-05-01"],
    ]);
    expect(items[1].notes).toMatch(/2026-27 date carried forward to your cycle/);
  });

  it("keeps a school's own date for a senior and says what was already listed, in Korean too", async () => {
    const authedFetch = vi.fn(async (path) => (String(path).includes("/api/calendar/context")
      ? reply({
        studentCycle: { cycle: "2026-27", startYear: 2026, entryYear: 2027, projected: false, typicalISO: { earlyEaEd: "2026-11-01", regularDecision: "2027-01-01", financialAidPriority: "2027-02-01", nationalDepositDeadline: "2027-05-01" } },
        schools: [{ school: "MIT", deadlines: { ea: "2026-11-01", rd: "2027-01-05" }, source: "https://mitadmissions.org/apply", cycle: "2026-27" }],
      })
      : reply({ createdCount: 1, skippedItems: [{ title: "MIT — Financial aid (approximate — verify)", reason: "duplicate" }, { title: "MIT — Commit by (approximate — verify)", reason: "duplicate" }] })));
    const notify = vi.fn();
    const result = await createDeadlinesForSchool({ authedFetch, notify, locale: "ko" }, "MIT", { now: NOV_3 });
    const items = bulkItems(authedFetch);
    expect(items[0]).toMatchObject({ title: "MIT — Regular Decision", dueAt: "2027-01-05" });
    expect(result).toMatchObject({ created: 1, duplicates: 2, past: ["Early (EA/ED)"] });
    expect(notify).toHaveBeenCalledWith("MIT: Fall 2027 입학 기준 마감일 1개를 마감일 목록에 추가했어요. Early (EA/ED) 마감일은 이미 지나서 추가하지 않았어요. 2개는 이미 목록에 있어요.");
  });

  // time-1: a yearless page read on Feb 3 holds next fall's Early Action
  // beside this winter's Regular Decision under one record cycle (2027-28).
  // Dating every slot by that label gave a junior the closing cycle's
  // February 15 as the school's own date, and told a senior, whose RD was
  // twelve days away, that it had already passed. Each date is placed by
  // its own cycle.
  describe("a February reading that mixes two cycles", () => {
    const FEB_3 = new Date(2027, 1, 3, 12, 0); // planning cycle 2027-28, closing 2026-27
    const mixedReading = (startYear, createdCount) => vi.fn(async (path) => (String(path).includes("/api/calendar/context")
      ? reply({
        studentCycle: { cycle: `${startYear}-${String((startYear + 1) % 100)}`, startYear, entryYear: startYear + 1, projected: false, typicalISO: { earlyEaEd: `${startYear}-11-01`, regularDecision: `${startYear + 1}-01-01`, financialAidPriority: `${startYear + 1}-02-01`, fafsaOpens: `${startYear}-10-01`, nationalDepositDeadline: `${startYear + 1}-05-01` } },
        schools: [{
          school: "Example University",
          deadlines: { ea: "2027-11-01", rd: "2027-02-15" },
          labels: { rd: "Regular Decision (2026-27 cycle)" },
          source: "https://example.edu/apply/deadlines",
          cycle: "2027-28",
        }],
      })
      : reply({ createdCount, skippedItems: [] })));

    it("gives a junior next fall's Early date as the school's and carries RD to her own cycle", async () => {
      const authedFetch = mixedReading(2027, 4);
      const result = await createDeadlinesForSchool({ authedFetch }, "Example University", { now: FEB_3 });
      const items = bulkItems(authedFetch);
      expect(items.map((i) => [i.title, i.dueAt])).toEqual([
        ["Example University — Early (EA/ED)", "2027-11-01"],
        ["Example University — Regular Decision (approximate — for Fall 2028 entry)", "2028-02-15"],
        ["Example University — Financial aid (approximate — verify)", "2028-02-01"],
        ["Example University — Commit by (approximate — verify)", "2028-05-01"],
      ]);
      expect(items[0].notes).toMatch(/published date, read from https:\/\/example\.edu/);
      expect(items[1].notes).toMatch(/2026-27 date carried forward to your cycle/);
      expect(result.past).toEqual([]);
    });

    it("gives a senior this winter's RD as the school's date and skips only what has passed", async () => {
      const authedFetch = mixedReading(2026, 2);
      const notify = vi.fn();
      const result = await createDeadlinesForSchool({ authedFetch, notify }, "Example University", { now: FEB_3 });
      const items = bulkItems(authedFetch);
      expect(items.map((i) => [i.title, i.dueAt])).toEqual([
        ["Example University — Regular Decision", "2027-02-15"],
        ["Example University — Commit by (approximate — verify)", "2027-05-01"],
      ]);
      expect(items[0].notes).toMatch(/published date, read from https:\/\/example\.edu/);
      // Next fall's Early Action is the junior's, not the senior's: her
      // Early round is the closing cycle's, already over.
      expect(result.past).toEqual(["Early (EA/ED)", "Financial aid"]);
      expect(notify).toHaveBeenCalledWith("Example University: added 2 deadlines for Fall 2027 entry to your Deadlines list. Skipped Early (EA/ED), Financial aid: that date has already passed.");
    });
  });
});

// chat-9: the Council route answers a provider failure as 502/504 with the
// shared code and councilCode COUNCIL_PROVIDER_UNAVAILABLE beside it; the
// client read `code` alone, so its outage copy never showed. The turn's
// signal (Cancel, the five-minute deadline) has to reach the request, since
// the route stops the run when the response closes.
describe("conveneStrategyCouncil", () => {
  const councilCtx = (response, locale = "en-US") => ({
    locale,
    setAgentStatus: vi.fn(),
    authedFetch: vi.fn(async () => response),
  });
  const failure = (status, body, headers = {}) => ({ ok: false, status, headers: { get: (name) => headers[name] ?? null }, json: async () => body });

  it("hands the turn's signal to the request, so Cancel and the deadline close it", async () => {
    const ctx = councilCtx({ ok: true, status: 200, json: async () => ({ recommendation: "Keep Ohio State as a target.", decision_type: "college-list" }) });
    const turn = new AbortController();
    await conveneStrategyCouncil(ctx, "Should I add a safety school?", "college-list", turn.signal);
    const [path, options] = ctx.authedFetch.mock.calls[0];
    expect(path).toBe("/api/council/convene");
    expect(options.signal).toBe(turn.signal);
  });

  it("keeps the route's code and shows the Council's outage copy for a provider failure", async () => {
    for (const [status, code] of [[502, "provider_error"], [504, "provider_timeout"]]) {
      const ctx = councilCtx(failure(status, { error: "The AI service could not answer right now.", code, councilCode: "COUNCIL_PROVIDER_UNAVAILABLE", stage: "Strategist" }), "ko");
      const err = await conveneStrategyCouncil(ctx, "Should I add a safety school?", "college-list").catch((e) => e);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.councilCode).toBe("COUNCIL_PROVIDER_UNAVAILABLE");
      expect(err.message).toMatch(/학생의 정보가 부족해서가 아니에요/);
    }
  });

  it("says a refused key is the site's to fix, not an outage to wait out", async () => {
    const ctx = councilCtx(failure(502, { code: "provider_auth_failed", councilCode: "COUNCIL_PROVIDER_UNAVAILABLE", upstreamStatus: 401 }));
    const err = await conveneStrategyCouncil(ctx, "Should I add a safety school?", "college-list").catch((e) => e);
    expect(err.code).toBe("provider_auth_failed");
    expect(err.message).toMatch(/still signed in/);
  });

  it("reads the limiter's 429 and the lower-case unconfigured code", async () => {
    const limited = await conveneStrategyCouncil(councilCtx(failure(429, { error: "Too many requests.", code: "rate_limited" }, { "Retry-After": "30" })), "Q?", "other").catch((e) => e);
    expect(limited.message).toMatch(/Wait 30 seconds/);
    const unconfigured = await conveneStrategyCouncil(councilCtx(failure(503, { error: "The administrator must configure OpenRouter first.", code: "openrouter_not_configured" }), "ko"), "Q?", "other").catch((e) => e);
    expect(unconfigured.message).toMatch(/설정되지 않아서/);
  });
});
