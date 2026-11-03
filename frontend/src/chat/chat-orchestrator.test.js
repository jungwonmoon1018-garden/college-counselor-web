import { afterEach, describe, expect, it, vi } from "vitest";
import { orchestrate } from "./chat-orchestrator.js";

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
