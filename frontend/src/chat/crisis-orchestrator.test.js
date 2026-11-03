import { afterEach, describe, expect, it, vi } from "vitest";
import { orchestrate } from "./chat-orchestrator.js";
import { requestChat } from "./chat-client.js";
import { crisisDisclaimer, crisisResourceFooter, crisisResources, crisisResponseText } from "./crisis-lexicon.js";

// Until 2026-11 a crisis reply from /api/chat was treated as an ordinary
// answer: the gatekeeper's JSON.parse failed and the turn fell back to
// safe_multi, each specialist and the supervisor got the same body, and the
// student saw "Please reach out to one of these resources:" with no
// resources, blocked:false and no crisisSafe. These tests drive the real
// orchestrator against a fetch stub shaped like the server.

// The reply the current server sends (buildCrisisChatReply).
function serverCrisisBody(locale = "en-US") {
  const answer = crisisResponseText(locale);
  return {
    answer, topic_type: "crisis", crisisSafe: true, claims: [],
    limitations: [crisisDisclaimer(locale)], actions: crisisResources(locale),
    content: [{ type: "text", text: answer }],
    _meta: { deterministic: true, topicType: "CRISIS", modelTier: "NONE" },
  };
}

// The reply the server sent before the fix, which an un-redeployed server
// could still send: one sentence, resources only in actions, no topic_type.
const OLD_SERVER_CRISIS_BODY = {
  answer: "It sounds like you may be going through a difficult time. Please reach out to one of these resources:",
  claims: [],
  limitations: ["I'm an AI assistant and cannot provide crisis counseling. Please contact a trained professional."],
  actions: [
    { name: "Emergency Services", contact: "911", description: "For immediate danger", type: "emergency" },
    { name: "Suicide & Crisis Lifeline", contact: "988", description: "24/7 mental health support", type: "crisis" },
    { name: "Crisis Text Line", contact: "Text HOME to 741741", description: "Free 24/7 crisis texting", type: "crisis" },
  ],
  content: [{ type: "text", text: "It sounds like you may be going through a difficult time. Please reach out to one of these resources:" }],
  _meta: { deterministic: true, topicType: "CRISIS", modelTier: "NONE" },
};

function stubChat(reply) {
  const calls = [];
  const fetchSpy = vi.fn(async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    const call = { url: String(url), headers: options.headers || {}, body, system: String(body.system || "") };
    calls.push(call);
    const out = reply(call, calls.length);
    return { ok: true, status: 200, json: async () => out };
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls, fetchSpy };
}

const answer = (text) => ({ answer: text });
const isGatekeeper = (call) => /CLASSIFY the student's message/.test(call.system);
const isValidator = (call) => /You validate responses/.test(call.system);
const isSupervisor = (call) => /combining the substance of upstream/.test(call.system);
const isScreener = (call) => /content safety screener/.test(call.system);

function run(message, { locale, pendingFile = null } = {}) {
  return orchestrate(message, { profile: {}, activities: [] }, vi.fn(), vi.fn(), new AbortController().signal, pendingFile, [], locale ? { locale } : {});
}

function expectCrisisTurn(result, lines = ["988", "741741"]) {
  expect(result.crisisSafe).toBe(true);
  expect(result.blocked).toBe(true);
  for (const line of lines) expect(result.text).toContain(line);
  expect(result.text).not.toMatch(/\[object Object\]/);
  expect(result.text.trim()).not.toMatch(/resources:$/);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("a crisis reply from the server ends the turn at the call it lands on", () => {
  it("on the gatekeeper call, before any JSON parse", async () => {
    const { calls } = stubChat(() => OLD_SERVER_CRISIS_BODY);
    const result = await run("Something happened at home and I need to talk to someone");
    expectCrisisTurn(result);
    expect(calls).toHaveLength(1);
    expect(isGatekeeper(calls[0])).toBe(true);
  });

  it("on a quick-routed specialist call", async () => {
    const { calls } = stubChat(() => serverCrisisBody());
    const result = await run("Which robotics club activities should I list first?");
    expectCrisisTurn(result, ["911", "988", "741741", "1-800-422-4453"]);
    expect(result.text).toBe(crisisResponseText("en-US"));
    expect(calls).toHaveLength(1);
  });

  it("on either specialist of a two-route turn, which allSettled used to swallow", async () => {
    const { calls } = stubChat((call) => (/ACADEMICS/i.test(call.body.messages?.at(-1)?.content || "") ? answer("Keep your GPA up.") : serverCrisisBody()));
    const result = await run("What GPA do I need and which club should I join?");
    expectCrisisTurn(result);
    expect(calls).toHaveLength(2);
    expect(calls.some(isSupervisor)).toBe(false);
  });

  it("on the upload screener call", async () => {
    const { calls } = stubChat((call) => (isScreener(call) ? serverCrisisBody() : answer("Your transcript shows strong grades.")));
    const result = await run("Summarize my transcript", { pendingFile: { name: "t.pdf", type: "application/pdf", base64: "JVBERi0=", mediaType: "application/pdf" } });
    expectCrisisTurn(result);
    expect(calls).toHaveLength(1);
    expect(isScreener(calls[0])).toBe(true);
  });
});

// The supervisor and the validator send model text, the specialists' drafts,
// not the student's question, which the client lexicon and the specialist
// calls had already read. A draft about recovering from self-harm or about a
// suicide-prevention club tripped the server lexicon on those calls, and the
// finished answer was swapped for the crisis reply, the question went unsaved
// and the thread was retitled "Support resources". The answer goes out now,
// with the resource lines, since the draft is about those topics.
describe("a crisis reply on a call that carries only model text keeps the answer", () => {
  it("on the validator call: the draft goes out, marked unverified, with the resource lines", async () => {
    const draft = "Your essay describes how you stopped self-harming; open with that moment.";
    const { calls } = stubChat((call) => (isValidator(call) ? serverCrisisBody() : answer(draft)));
    const result = await run("Can you give me feedback on my college essay about robotics club?");
    expect(result.crisisSafe).toBeUndefined();
    expect(result.blocked).toBe(false);
    expect(result.text).toContain(draft);
    expect(result.text).toMatch(/could not be fully verified/);
    expect(result.text.split("741741").length - 1).toBe(1);
    expect(calls.filter(isValidator)).toHaveLength(1);
  });

  it("on the supervisor merge: the unmerged drafts go out", async () => {
    const { calls } = stubChat((call) => (isSupervisor(call)
      ? serverCrisisBody()
      : answer(/ACADEMICS/i.test(call.body.messages?.at(-1)?.content || "") ? "Aim for a 3.9 unweighted." : "Join the suicide prevention club you mentioned.")));
    const result = await run("What GPA do I need and which club should I join?", { locale: "ko" });
    expect(result.crisisSafe).toBeUndefined();
    expect(result.blocked).toBe(false);
    expect(result.text).toMatch(/Aim for a 3\.9 unweighted\.[\s\S]*Join the suicide prevention club/);
    expect(result.text).toContain("109");
    expect(calls.filter(isSupervisor)).toHaveLength(1);
  });

  it("but a crisis reply on the student's own words still ends the turn, whatever the later calls say", async () => {
    const { calls } = stubChat((call) => (isGatekeeper(call) || isSupervisor(call) || isValidator(call) ? answer("{}") : serverCrisisBody()));
    const result = await run("Which robotics club activities should I list first?");
    expectCrisisTurn(result);
    expect(calls.some(isSupervisor) || calls.some(isValidator)).toBe(false);
  });
});

describe("the client lexicon ends the turn before any call", () => {
  it("for Korean, typographic apostrophes, and a statement past character 600", async () => {
    const { fetchSpy } = stubChat(() => answer("should not be called"));
    expectCrisisTurn(await run("요즘 너무 힘들어서 죽고 싶어요", { locale: "ko" }), ["109", "1388", "119", "112", "988"]);
    expectCrisisTurn(await run("I’m not safe at home"));
    const long = "I have a question about my schedule for next year. ".repeat(14) + "Honestly I don't want to live anymore.";
    expect(long.length).toBeGreaterThan(700);
    expectCrisisTurn(await run(long));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("but answers an idiom that only looks like danger", async () => {
    stubChat(() => answer("Meet your teacher this week and redo the lab reports."));
    const result = await run("I'm in danger of failing AP Chem, what should I do?");
    expect(result.blocked).toBe(false);
    expect(result.crisisSafe).toBeUndefined();
    expect(result.text).toMatch(/redo the lab reports/);
  });
});

describe("the UI locale reaches every call", () => {
  it("sends ko on the query, Accept-Language and X-CollegeApp-Locale, and shows the Korean reply", async () => {
    const { calls } = stubChat((call) => (isGatekeeper(call) ? answer(JSON.stringify({ category: "safe_ec", reason: "x", route_to: ["ec"] })) : serverCrisisBody("ko")));
    const result = await run("Can we talk about something?", { locale: "ko" });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.url).toContain("?locale=ko");
      expect(call.headers["Accept-Language"]).toBe("ko");
      expect(call.headers["X-CollegeApp-Locale"]).toBe("ko");
    }
    expectCrisisTurn(result, ["109", "1388", "988"]);
  });

  it("requestChat sends ko when asked and en-US by default", async () => {
    const { calls } = stubChat(() => answer("ok"));
    await requestChat({ messages: [{ role: "user", content: "hi" }] }, undefined, "ko");
    await requestChat({ messages: [{ role: "user", content: "hi" }] });
    expect(calls[0].headers["X-CollegeApp-Locale"]).toBe("ko");
    expect(calls[1].headers["Accept-Language"]).toBe("en-US");
  });
});

describe("a topic mention is answered with the resource footer", () => {
  it("keeps the server's footer once", async () => {
    const footer = crisisResourceFooter("en-US");
    stubChat(() => answer(`Run a bake sale and a 5K walk.${footer}`));
    const result = await run("our school's suicide prevention club needs a fundraiser idea");
    expect(result.blocked).toBe(false);
    expect(result.text).toMatch(/bake sale/);
    expect(result.text.split("741741").length - 1).toBe(1);
  });

  it("adds the footer when the merge or the validator dropped it, and never sends it back", async () => {
    const footer = crisisResourceFooter("en-US");
    const { calls } = stubChat((call) => {
      if (isValidator(call)) return answer(JSON.stringify({ passed: false, issues: ["x"], cleaned_response: "Run a bake sale; results are not guaranteed." }));
      return answer(`You are guaranteed to raise money with a bake sale.${footer}`);
    });
    const result = await run("our school's suicide prevention club needs a fundraiser idea");
    expect(result.blocked).toBe(false);
    expect(result.text).toMatch(/results are not guaranteed/);
    expect(result.text).toContain("741741");
    const validatorCall = calls.find(isValidator);
    expect(JSON.stringify(validatorCall.body.messages)).not.toContain("741741");
  });
});
