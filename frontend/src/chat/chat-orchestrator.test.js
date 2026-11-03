import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCalendarPreamble, orchestrate } from "./chat-orchestrator.js";

// The real orchestrator against a fetch stub shaped like /api/chat. `reply`
// returns { status, body } or a bare body (200).
function stubChat(reply) {
  const calls = [];
  const fetchSpy = vi.fn(async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    const call = { url: String(url), body, system: String(body.system || ""), text: JSON.stringify(body.messages || []) };
    calls.push(call);
    const out = reply(call, calls.length);
    const status = out?.status && out?.body ? out.status : 200;
    const json = out?.status && out?.body ? out.body : out;
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json };
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls, fetchSpy };
}

const isGatekeeper = (call) => /CLASSIFY the student's message/.test(call.system);
const isValidator = (call) => /You validate responses/.test(call.system);
const isSupervisor = (call) => /combining the substance of upstream/.test(call.system);
const isScreener = (call) => /content safety screener/.test(call.system);
const isCollege = (call) => /COLLEGE FIT specialist/.test(call.system);

// A server reply on a regulated topic: the composer's decoration rides along.
const regulated = (answer) => ({
  answer,
  topic_type: "regulated",
  limitations: ["General guidance only; confirm on StudentAid.gov."],
  actions: [{ label: "StudentAid.gov", url: "https://studentaid.gov" }],
});

const GHOSTWRITING = "I can't write your college essay for you — admissions essays have to be your own work. What I can do is help you brainstorm ideas, shape an outline, or give honest feedback on a draft you've written yourself.";
const blocked400 = { status: 400, body: { error: GHOSTWRITING, blocked: true } };
const PDF = { name: "transcript.pdf", type: "application/pdf", base64: "JVBERi0=", mediaType: "application/pdf" };

function run(message, { data = { profile: {}, activities: [] }, pendingFile = null, locale } = {}) {
  return orchestrate(message, data, vi.fn(), vi.fn(), new AbortController().signal, pendingFile, [], locale ? { locale } : {});
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("policy blocks show the block's own reply", () => {
  it("when the LLM gatekeeper's call is blocked", async () => {
    const { calls } = stubChat(() => blocked400);
    const result = await run("Can you write my personal statement?");
    expect(isGatekeeper(calls[0])).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.text).toBe(GHOSTWRITING);
    expect(result.text).not.toMatch(/couldn't reach the model|administrator/);
  });

  it("when both specialists of a two-route turn are blocked", async () => {
    const { calls } = stubChat(() => blocked400);
    const result = await run("How do I improve my GPA and also my club leadership?");
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ blocked: true, text: GHOSTWRITING });
    expect(result.text).not.toMatch(/rephrasing/);
  });

  it("when a quick-routed specialist is blocked", async () => {
    stubChat(() => blocked400);
    const result = await run("Which robotics club activities should I list first?");
    expect(result).toMatchObject({ blocked: true, text: GHOSTWRITING });
  });

  it("but a blocked supervisor merge sends the unmerged answers, not a block the student never caused", async () => {
    stubChat((call) => (isSupervisor(call) ? blocked400 : { answer: /ACADEMICS/.test(call.text) ? "Take AP Calculus." : "Lead the robotics outreach team." }));
    const result = await run("How do I improve my GPA and also my club leadership?");
    expect(result.blocked).toBe(false);
    expect(result.text).toContain("Take AP Calculus.");
    expect(result.text).toContain("Lead the robotics outreach team.");
  });
});

describe("a failed turn fails with its typed error", () => {
  it("when both specialists of a two-route turn hit the monthly budget", async () => {
    stubChat(() => ({ status: 402, body: { error: "Monthly model budget does not allow this request.", code: "monthly_cap_exceeded" } }));
    const err = await run("How do I improve my GPA and also my club leadership?").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("monthly_cap_exceeded");
  });

  it("when the gatekeeper call fails, instead of quoting the provider", async () => {
    stubChat(() => ({ status: 502, body: { error: "upstream exploded", code: "provider_error" } }));
    const err = await run("Is my family eligible for a Pell grant?").catch((e) => e);
    expect(err.code).toBe("provider_error");
  });

  it("but still shows the hotlines when the attached text carries a safety statement", async () => {
    stubChat(() => ({ status: 503, body: { error: "not configured", code: "openrouter_not_configured" } }));
    const message = "[Attached files — read carefully; 1 text file(s)]\nI want to kill myself.\n[End of attached files]\n\nPlease look at this draft.";
    const result = await run(message);
    expect(result.crisisSafe).toBe(true);
    expect(result.text).toMatch(/988/);
    expect(result.text).toMatch(/isn't set up on this site/);
  });

  it("falls back to the specialists when the gatekeeper's reply is empty", async () => {
    const { calls } = stubChat((call) => (isGatekeeper(call)
      ? { status: 502, body: { error: "The model returned an empty reply.", code: "empty_model_reply" } }
      : { answer: "Here is a plan." }));
    const result = await run("Is my family eligible for a Pell grant?");
    expect(result.blocked).toBe(false);
    expect(calls.length).toBeGreaterThan(1);
  });
});

// The gatekeeper and the validator are utility calls: the client sends
// mode "utility" and reads their JSON even when the server decorated it.
describe("utility calls keep their JSON", () => {
  it("a Pell question the gatekeeper files as College goes only to the College agent", async () => {
    const { calls } = stubChat((call) => (isGatekeeper(call)
      ? regulated('{"category":"safe_college","reason":"aid question","route_to":["college"]}')
      : { answer: "Ask your counselor to walk through the FAFSA with your family." }));
    const result = await run("Is my family eligible for a Pell grant?");
    expect(calls).toHaveLength(2);
    expect(calls[0].body.mode).toBe("utility");
    expect(isCollege(calls[1])).toBe(true);
    expect(calls[1].body.mode).toBeUndefined();
    expect(result.blocked).toBe(false);
  });

  it("applies the validator's cleaned answer on a regulated draft", async () => {
    const { calls } = stubChat((call) => {
      if (isValidator(call)) return regulated('{"passed":false,"issues":["guarantee"],"cleaned_response":"Pell Grant eligibility depends on your family\'s FAFSA."}');
      return { answer: "You are guaranteed a Pell Grant." };
    });
    const result = await run("Which robotics club activities should I list first?");
    const validator = calls.find(isValidator);
    expect(validator.body.mode).toBe("utility");
    expect(result.text).toContain("Pell Grant eligibility depends on your family's FAFSA.");
    expect(result.text).not.toMatch(/guaranteed|could not be fully verified|Limitations/);
  });

  it("gives the validator a budget that fits a long draft", async () => {
    const long = `You are guaranteed a spot. ${"Keep building your robotics portfolio. ".repeat(120)}`;
    const { calls } = stubChat((call) => (isValidator(call) ? { answer: '{"passed":true}' } : { answer: long }));
    await run("Which robotics club activities should I list first?");
    expect(calls.find(isValidator).body.max_tokens).toBeGreaterThan(1000);
  });
});

describe("upload screening", () => {
  it("a screen with no verdict is a try-again, not 'upload a school document'", async () => {
    const { calls } = stubChat((call) => (isScreener(call) ? { answer: "I can't help with that." } : { answer: "x" }));
    const result = await run("Summarize my transcript", { pendingFile: PDF });
    expect(calls.filter(isScreener)).toHaveLength(2);
    expect(result).toMatchObject({ blocked: true, uploadRejected: true, uploadTransient: true });
    expect(result.text).toMatch(/send it again/);
    expect(result.text).not.toMatch(/Please upload a school document|Unexpected token/);
  });

  it("an explicit unsafe verdict is still a refusal", async () => {
    stubChat((call) => (isScreener(call) ? { answer: '{"safe":false,"reason":"Explicit content."}' } : { answer: "x" }));
    const result = await run("Summarize my transcript", { pendingFile: PDF });
    expect(result.uploadRejected).toBe(true);
    expect(result.uploadTransient).toBeUndefined();
    expect(result.text).toMatch(/Explicit content\.[\s\S]*school document/);
  });

  it("a silent screen lets the file through with a note, and the validator still reads the answer", async () => {
    const { calls } = stubChat((call) => {
      if (isScreener(call)) return { answer: "" };
      if (isValidator(call)) return { answer: '{"passed":true}' };
      return { answer: "Your transcript shows an A in AP Biology." };
    });
    const result = await run("Summarize my transcript", { pendingFile: PDF });
    expect(calls.filter(isScreener)).toHaveLength(2);
    expect(calls.some(isValidator)).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.text).toMatch(/automatic file check wasn't available/);
  });
});

// The profile route answers { unweighted: null, weighted: null } for a
// student with no GPA, and the quick reply printed "GPA: null".
describe("the GPA quick reply", () => {
  it("says there is no GPA when the record holds none", async () => {
    const result = await run("what's my gpa?", { data: { profile: { gpa: { unweighted: null, weighted: null } }, activities: [] } });
    expect(result.text).toBe("I don't have a GPA saved yet.");
  });
  it("prints a saved GPA", async () => {
    const result = await run("what's my gpa?", { data: { profile: { gpa: { unweighted: 3.8, weighted: 4.2 } }, activities: [] } });
    expect(result.text).toBe("GPA: 3.8 / 4.2w");
  });
});

// A TOEFL band 5.5 read "TOEFL: 5.5" (a failing 0-120 score, to anyone
// reading it) and a ninth grader's PSAT 8/9 read "PSAT: 900".
describe("the test-score quick replies name each score's scale", () => {
  const tests = [
    { test: "toefl", scale: "band", totalScore: 5.5 },
    { test: "psat", scale: "8/9", totalScore: 900 },
    { test: "sat", totalScore: 1450 },
  ];
  it("in the test-score list", async () => {
    const result = await run("what are my test scores?", { data: { profile: { testScores: tests }, activities: [] } });
    expect(result.text).toBe("TOEFL (1-6 band): 5.5\nPSAT 8/9: 900\nSAT: 1450");
  });
  it("in the profile summary", async () => {
    const result = await run("my profile", { data: { profile: { testScores: tests }, activities: [] } });
    expect(result.text).toContain("Test scores: TOEFL (1-6 band): 5.5, PSAT 8/9: 900, SAT: 1450");
  });
});

// The calendar appendix is the only "today" the chat model gets, and it was
// the UTC date: at 6:30 PM in Los Angeles on a deadline day the model was
// told it was tomorrow and called a live deadline past-due, while the
// tracker said due today. The clock is passed in, and each zone is set for
// its own case, so the test does not depend on the day or the machine.
describe("the calendar preamble", () => {
  it("stamps the student's local date, not the UTC one", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      // 7:30 PM on Dec 15 in Los Angeles, already Dec 16 in UTC.
      expect(buildCalendarPreamble(null, [], new Date("2026-12-16T03:30:00Z"))).toContain("Today's date: 2026-12-15.");
      process.env.TZ = "Asia/Seoul";
      // 8:30 AM on Dec 15 in Seoul, still Dec 14 in UTC.
      expect(buildCalendarPreamble(null, [], new Date("2026-12-14T23:30:00Z"))).toContain("Today's date: 2026-12-15.");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

// From Feb 1 to Jul 31 the calendar route's payload carries the cycle the
// seniors are still in (backend/server/narrative-calendar.js, closingCycle),
// a year before the planning cycle the typical dates outline. The preamble
// printed only the phase, so the model never saw which year a senior's
// deposit and late deadlines fall in, and a senior's Common Data Set dates
// sat under the planning cycle's heading. The payloads below are injected in
// the route's shape, so nothing here reads the clock.
describe("the calendar preamble in the closing cycle", () => {
  const closingNote = "Seniors applying for Fall 2027 entry are still in this cycle until Jul 31 2027: date their deposit, decisions and any late regular deadline in 2027, not by the planning cycle above.";
  const calendarFor = ({ depositPassed = false, closing = true } = {}) => ({
    today: "2027-02-03",
    cycleStartYear: 2027,
    cycleEntryYear: 2028,
    schoolYear: "2027–2028",
    applicationCycle: "Class entering Fall 2028",
    phase: "planning the upcoming cycle — research, essays, and target list for applications this fall",
    typicalDeadlines: {
      earlyEaEd: "~Nov 1 2027 (some Nov 15)",
      regularDecision: "~Jan 1–15 2028",
      eaEdDecisionsRelease: "mid–late Dec 2027",
      rdDecisionsRelease: "mid-Mar–early-Apr 2028",
      fafsaOpens: "Oct 1 2027",
      cssProfilePriority: "Nov 2027–Feb 2028 (varies)",
      financialAidPriority: "often the ED/EA date, else ~Feb 1 2028",
      nationalDepositDeadline: "May 1 2028",
    },
    typicalHsBreaks: { summer: "early-June–late-Aug 2027", thanksgiving: "late Nov 2027", winter: "~Dec 20 2027–early Jan 2028", spring: "~Mar–Apr 2028" },
    ...(closing ? {
      closingCycle: {
        cycle: "2026-27",
        cycleStartYear: 2026,
        cycleEntryYear: 2027,
        applicationCycle: "Class entering Fall 2027",
        rdDecisionsRelease: "mid-Mar–early-Apr 2027",
        nationalDepositDeadline: "May 1 2027",
        depositISO: "2027-05-01",
        depositPassed,
        note: closingNote,
      },
    } : {}),
  });
  const at = new Date("2027-02-03T15:00:00Z");
  const linesOf = (text) => text.split("\n");

  it("adds a line for the seniors' cycle while its deposit is still ahead", () => {
    const lines = linesOf(buildCalendarPreamble({ calendar: calendarFor() }, [], at));
    const closing = lines.filter((l) => l.startsWith("Closing cycle"));
    expect(closing).toEqual([
      `Closing cycle 2026-27 (seniors, entering Fall 2027): late regular deadlines and the May 1 2027 enrollment deposit are still ahead; RD decisions mid-Mar–early-Apr 2027. ${closingNote}`,
    ]);
    // It follows the planning cycle's typical dates it is set against.
    expect(lines.indexOf(closing[0])).toBe(lines.findIndex((l) => l.startsWith("Typical US deadlines")) + 1);
  });

  it("says the deposit date has passed once it has", () => {
    const text = buildCalendarPreamble({ calendar: calendarFor({ depositPassed: true }) }, [], at);
    expect(linesOf(text).filter((l) => l.startsWith("Closing cycle"))).toEqual([
      `Closing cycle 2026-27 (seniors, entering Fall 2027): the May 1 2027 enrollment deposit date has passed. ${closingNote}`,
    ]);
    expect(text).not.toMatch(/still ahead/);
  });

  it("adds nothing from August to January, when the payload has no closing cycle", () => {
    expect(buildCalendarPreamble({ calendar: calendarFor({ closing: false }) }, [], at)).not.toMatch(/Closing cycle/);
    expect(buildCalendarPreamble(null, [], at)).not.toMatch(/Closing cycle/);
    // A malformed block is left out rather than printed as "Fall NaN".
    const broken = { ...calendarFor(), closingCycle: { cycle: "2026-27" } };
    expect(buildCalendarPreamble({ calendar: broken }, [], at)).not.toMatch(/Closing cycle|NaN|undefined/);
  });

  it("marks a school dated in another cycle than the heading's", () => {
    const schools = [
      { school: "Example College", deadlines: { rd: "2027-03-01" }, source: "cds", cycle: "2026-27" },
      { school: "Sample University", deadlines: { ea: "2027-11-01", rd: "2028-01-04" }, source: "https://admissions.sample.edu/dates", cycle: "2027-28" },
      { school: "Typical Institute", deadlines: null, source: "typical" },
    ];
    const lines = linesOf(buildCalendarPreamble({ calendar: calendarFor(), schools }, [], at));
    expect(lines).toContain("Target-school deadlines (cycle entering Fall 2028, unless a school is marked with its own):");
    expect(lines).toContain("  • Example College (2026-27 cycle, entering Fall 2027): EA —; ED —; RD 2027-03-01; financial aid —; decisions —; commit by — [cds]");
    expect(lines).toContain("  • Sample University: EA 2027-11-01; ED —; RD 2028-01-04; financial aid —; decisions —; commit by — [https://admissions.sample.edu/dates]");
    expect(lines).toContain("  • Typical Institute: specific dates not retrieved — use the typical US dates above and tell the student to verify on the school's site.");
  });

  it("keeps the heading as it was when every school is in the planning cycle", () => {
    const schools = [{ school: "Sample University", deadlines: { rd: "2028-01-04" }, source: "cds", cycle: "2027-28" }];
    const lines = linesOf(buildCalendarPreamble({ calendar: calendarFor({ closing: false }), schools }, [], at));
    expect(lines).toContain("Target-school deadlines (cycle entering Fall 2028):");
    expect(lines).toContain("  • Sample University: EA —; ED —; RD 2028-01-04; financial aid —; decisions —; commit by — [cds]");
  });

  // The provider-side redactor masks dollar amounts; the block has none.
  it("writes no dollar sign", () => {
    expect(buildCalendarPreamble({ calendar: calendarFor(), schools: [] }, [], at)).not.toContain("$");
  });
});
