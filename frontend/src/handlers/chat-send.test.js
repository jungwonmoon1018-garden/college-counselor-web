import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNCIL_CLIENT_TIMEOUT_MS, councilTimeoutMessage } from "../profile/strategy-council.js";

vi.mock("../chat/chat-orchestrator.js", async (importOriginal) => ({
  ...(await importOriginal()),
  orchestrate: vi.fn(async () => ({ text: "Take AP Physics C next year.", blocked: false, routeKey: "academics" })),
}));

const { send } = await import("./chat-send.js");
const { orchestrate } = await import("../chat/chat-orchestrator.js");
const { rateLimiter } = await import("../chat/chat-client.js");

function makeCtx(overrides = {}) {
  let messages = [];
  const ctx = {
    abortRef: { current: null },
    activeThreadId: null,
    authedFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    calendarCtx: null,
    chatFiles: [],
    chatTextareaRef: { current: null },
    conveneStrategyCouncil: vi.fn(async () => ({ text: "Council recommendation", blocked: false, council: true })),
    councilDecisionType: null,
    councilTurnSequenceRef: { current: 0 },
    data: { profile: {}, activities: [] },
    input: "",
    inputRef: { current: null },
    loading: false,
    locale: "en-US",
    messages: [],
    newThread: vi.fn(async () => "thread-new"),
    pendingFile: null,
    persistTurn: vi.fn(async () => {}),
    refreshBudget: vi.fn(),
    refreshThreadList: vi.fn(async () => {}),
    setAgentStatus: vi.fn(),
    setChatFiles: vi.fn(),
    setChatFilesExpanded: vi.fn(),
    setCouncilDecisionType: vi.fn(),
    setData: vi.fn(),
    setInput: vi.fn(),
    setLoading: vi.fn(),
    setMessages: vi.fn((update) => { messages = typeof update === "function" ? update(messages) : update; }),
    setPendingFile: vi.fn(),
    targetSchools: [],
    toolSeq: { current: 0 },
    ...overrides,
  };
  return { ctx, messages: () => messages };
}

beforeEach(() => {
  rateLimiter.reset();
  orchestrate.mockClear();
});

describe("send()", () => {
  // Every /api/chat call used to say en-US: orchestrate() took no locale.
  it("passes the UI locale to the orchestrator", async () => {
    const { ctx } = makeCtx({ input: "Which classes should I take next year?", locale: "ko", activeThreadId: "thread-1" });
    await send(ctx);
    expect(orchestrate).toHaveBeenCalledTimes(1);
    expect(orchestrate.mock.calls[0][7]).toEqual({ locale: "ko" });
  });

  // The Council path had no client check: "better off without me" inside a
  // Council question went to the server alone, which missed it.
  it("answers a crisis Council question with the crisis reply and never convenes the Council", async () => {
    const { ctx, messages } = makeCtx({
      input: "Should I apply ED to Harvard? Honestly everyone would be better off without me if I fail.",
      councilDecisionType: "college-list",
    });
    await send(ctx);
    expect(ctx.conveneStrategyCouncil).not.toHaveBeenCalled();
    expect(orchestrate).not.toHaveBeenCalled();
    const reply = messages().filter((m) => m.role === "assistant").at(-1);
    for (const line of ["911", "988", "741741", "1-800-422-4453"]) expect(reply.content).toContain(line);
    // The student's words are not persisted; the reply is, under the neutral title.
    expect(ctx.persistTurn.mock.calls.map((c) => c[1])).toEqual(["assistant"]);
    const patch = ctx.authedFetch.mock.calls.find(([, options]) => options?.method === "PATCH");
    expect(JSON.parse(patch[1].body)).toEqual({ title: "Support resources" });
  });

  it("shows the Korean lines for a Korean Council crisis question", async () => {
    const { ctx, messages } = makeCtx({ input: "아빠가 저를 때려요. 어디에 지원해야 할까요?", councilDecisionType: "college-list", locale: "ko" });
    await send(ctx);
    expect(ctx.conveneStrategyCouncil).not.toHaveBeenCalled();
    const reply = messages().filter((m) => m.role === "assistant").at(-1);
    expect(reply.content).toMatch(/109[\s\S]*1388[\s\S]*988/);
  });

  // The burst guard, the Council's attachment rule and its 2,000-character
  // limit all returned before the lexicon ran, so a long Council message or
  // a fourth send in ten seconds that said "I want to kill myself" got the
  // limit note and no hotline.
  it("answers a crisis statement before the Council's length and attachment rules and the burst guard", async () => {
    const long = `${"I keep rewriting my list of reach schools and second-guessing every choice. ".repeat(30)}Honestly I want to kill myself.`;
    expect(long.length).toBeGreaterThan(2000);
    const pdf = { name: "list.pdf", type: "application/pdf", size: 900, base64: "JVBERi0=", mediaType: "application/pdf" };
    for (const overrides of [
      { input: long },
      { input: "I want to kill myself", pendingFile: pdf },
      { input: "I want to kill myself", burst: true },
    ]) {
      rateLimiter.reset();
      if (overrides.burst) for (let i = 0; i < 3; i += 1) rateLimiter.check();
      const { ctx, messages } = makeCtx({ input: overrides.input, pendingFile: overrides.pendingFile || null, councilDecisionType: "college-list" });
      await send(ctx);
      expect(ctx.conveneStrategyCouncil).not.toHaveBeenCalled();
      const reply = messages().filter((m) => m.role === "assistant").at(-1);
      expect(reply.content, JSON.stringify(Object.keys(overrides))).toContain("988");
      expect(reply.content).not.toMatch(/2,000 characters|attachments|10 seconds/);
    }
  });

  it("lets an ordinary-chat crisis statement past the burst guard to the orchestrator's lexicon", async () => {
    for (let i = 0; i < 3; i += 1) rateLimiter.check();
    const { ctx, messages } = makeCtx({ input: "I don't want to be alive anymore", activeThreadId: "thread-1" });
    await send(ctx);
    expect(orchestrate).toHaveBeenCalledTimes(1);
    expect(messages().some((m) => /10 seconds/.test(m.content || ""))).toBe(false);
  });

  it("still applies the Council's rules and the burst guard to an ordinary question", async () => {
    const { ctx, messages } = makeCtx({ input: "a".repeat(2001), councilDecisionType: "college-list" });
    await send(ctx);
    expect(ctx.conveneStrategyCouncil).not.toHaveBeenCalled();
    expect(messages().at(-1).content).toMatch(/2,000 characters/);
    for (let i = 0; i < 3; i += 1) rateLimiter.check();
    const burst = makeCtx({ input: "Which classes should I take next year?" });
    await send(burst.ctx);
    expect(orchestrate).not.toHaveBeenCalled();
    expect(burst.messages().at(-1).content).toMatch(/10 seconds/);
  });

  it("still convenes the Council for an ordinary question", async () => {
    const { ctx } = makeCtx({ input: "Should I add a safety school in Ohio?", councilDecisionType: "college-list" });
    await send(ctx);
    expect(ctx.conveneStrategyCouncil).toHaveBeenCalledTimes(1);
  });
});

// A failed turn used to clear the composer for good and save the error
// alone to the thread: the student retyped the question and re-picked the
// files, a reopened thread showed an error under no question, and the next
// turn replayed the error to the model as its own answer.
describe("a failed turn is undone", () => {
  const typed = "Can you review my activity list? I pasted the long descriptions.";
  const files = [{ kind: "text", name: "activities.txt", path: "activities.txt", size: 2048, content: "Robotics captain" }];
  const pdf = { name: "transcript.pdf", type: "application/pdf", size: 9000, base64: "JVBERi0=", mediaType: "application/pdf" };
  const typedError = (status, code, message = "x") => Object.assign(new Error(message), { status, code });

  it("puts the question and every file back, and saves nothing", async () => {
    orchestrate.mockRejectedValueOnce(typedError(504, "provider_timeout"));
    const { ctx, messages } = makeCtx({ input: typed, chatFiles: files, pendingFile: pdf, activeThreadId: "thread-1" });
    await send(ctx);
    expect(ctx.setInput.mock.calls.at(-1)[0]).toBe(typed);
    expect(ctx.setChatFiles.mock.calls.at(-1)[0]).toBe(files);
    expect(ctx.setPendingFile.mock.calls.at(-1)[0]).toBe(pdf);
    expect(ctx.persistTurn).not.toHaveBeenCalled();
    const shown = messages();
    expect(shown.some((m) => m.role === "user")).toBe(false); // the bubble comes back out
    expect(shown.at(-1)).toMatchObject({ role: "assistant", transient: true });
    expect(shown.at(-1).content).toMatch(/took too long/);
    expect(ctx.setLoading.mock.calls.at(-1)[0]).toBe(false);
  });

  it("says why in the student's language", async () => {
    orchestrate.mockRejectedValueOnce(typedError(402, "monthly_cap_exceeded"));
    const { ctx, messages } = makeCtx({ input: typed, locale: "ko" });
    await send(ctx);
    expect(messages().at(-1).content).toMatch(/예산을 모두 사용/);
  });

  it("undoes a cancelled turn the same way", async () => {
    orchestrate.mockRejectedValueOnce(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    const { ctx, messages } = makeCtx({ input: typed, activeThreadId: "thread-1" });
    await send(ctx);
    expect(ctx.setInput.mock.calls.at(-1)[0]).toBe(typed);
    expect(ctx.persistTurn).not.toHaveBeenCalled();
    expect(messages().at(-1)).toMatchObject({ transient: true, content: "Cancelled. Your question is back in the message box." });
  });

  it("gives the files back when the upload screen could not reach a verdict", async () => {
    orchestrate.mockResolvedValueOnce({ text: "We couldn't check this file just now. Please send it again in a moment.", blocked: true, uploadRejected: true, uploadTransient: true });
    const { ctx, messages } = makeCtx({ input: "Summarize this", pendingFile: pdf, activeThreadId: "thread-1" });
    await send(ctx);
    expect(ctx.setPendingFile.mock.calls.at(-1)[0]).toBe(pdf);
    expect(ctx.persistTurn).not.toHaveBeenCalled();
    expect(messages().at(-1)).toMatchObject({ transient: true });
  });

  // gate-8: a block reads as the counselor's reply, and the question comes
  // back to be edited; the student's words are still never saved.
  it("shows a policy block's reply and puts the question back to edit", async () => {
    orchestrate.mockResolvedValueOnce({ text: "I can't write your college essay for you — want to brainstorm instead?", blocked: true, policyBlocked: true });
    const { ctx, messages } = makeCtx({ input: "Write my personal statement", activeThreadId: "thread-1" });
    await send(ctx);
    expect(messages().at(-1).content).toMatch(/brainstorm/);
    expect(ctx.setInput.mock.calls.at(-1)[0]).toBe("Write my personal statement");
    expect(ctx.persistTurn.mock.calls.map((c) => c[1])).not.toContain("user");
  });

  it("does not give back a file refused as unsafe", async () => {
    orchestrate.mockResolvedValueOnce({ text: "I can't process this file: Explicit content.", blocked: true, uploadRejected: true });
    const { ctx } = makeCtx({ input: "Look at this", pendingFile: pdf, activeThreadId: "thread-1" });
    await send(ctx);
    expect(ctx.setPendingFile.mock.calls.every(([value]) => value === null)).toBe(true);
    expect(ctx.setInput.mock.calls.at(-1)[0]).toBe("Look at this");
  });

  // A question that names suicide, self-harm or overdose gets the 988 /
  // 741741 footer on its answer, and the footer used to be added only to a
  // successful answer: a spent budget, a withdrawn consent or an outage
  // showed the error copy with no line at all.
  it("keeps the crisis lines on the error note of a turn that names suicide as a topic", async () => {
    const topic = "Our suicide prevention club needs a fundraiser idea";
    for (const [err, locale, line] of [
      [typedError(402, "monthly_cap_exceeded"), "en-US", "741741"],
      [typedError(403, "consent_required"), "en-US", "988"],
      [typedError(502, "provider_error"), "ko", "109"],
      [Object.assign(new Error("Cancelled"), { name: "AbortError" }), "en-US", "741741"],
    ]) {
      rateLimiter.reset();
      orchestrate.mockRejectedValueOnce(err);
      const { ctx, messages } = makeCtx({ input: topic, locale, activeThreadId: "thread-1" });
      await send(ctx);
      const note = messages().at(-1);
      expect(note).toMatchObject({ role: "assistant", transient: true });
      expect(note.content, `${err.code || err.name} ${locale}`).toContain(line);
      expect(note.content.split("741741").length - 1).toBe(1);
      expect(ctx.persistTurn).not.toHaveBeenCalled();
    }
  });

  it("keeps the crisis lines on a failed Council turn, a try-again upload and a redirect that name the topic", async () => {
    const council = makeCtx({
      input: "Should our self-harm awareness week be my main activity?",
      councilDecisionType: "activities",
      conveneStrategyCouncil: vi.fn(async () => { throw Object.assign(new Error("The Council is busy."), { status: 503, code: "provider_unavailable" }); }),
    });
    await send(council.ctx);
    expect(council.messages().at(-1).content).toContain("741741");

    rateLimiter.reset();
    orchestrate.mockResolvedValueOnce({ text: "We couldn't check this file just now. Please send it again in a moment.", blocked: true, uploadRejected: true, uploadTransient: true });
    const upload = makeCtx({ input: "Here is my essay about our overdose prevention program", pendingFile: pdf, activeThreadId: "thread-1" });
    await send(upload.ctx);
    expect(upload.messages().at(-1).content).toContain("741741");

    rateLimiter.reset();
    orchestrate.mockResolvedValueOnce({ text: "I'm designed for academics, ECs, and college planning.", blocked: true });
    const redirect = makeCtx({ input: "Tell me about suicide statistics", activeThreadId: "thread-1" });
    await send(redirect.ctx);
    expect(redirect.messages().at(-1).content).toContain("741741");
  });

  it("adds no crisis line to the error note of an ordinary question", async () => {
    orchestrate.mockRejectedValueOnce(typedError(402, "monthly_cap_exceeded"));
    const { ctx, messages } = makeCtx({ input: typed });
    await send(ctx);
    expect(messages().at(-1).content).not.toContain("741741");
  });

  it("keeps a successful turn's save as it was", async () => {
    const { ctx } = makeCtx({ input: "Which classes should I take next year?", activeThreadId: "thread-1" });
    await send(ctx);
    expect(ctx.persistTurn.mock.calls.map((c) => c[1])).toEqual(["user", "assistant"]);
    expect(ctx.setInput.mock.calls.at(-1)[0]).toBe("");
  });
});

// chat-9: the Council call had no deadline and no Cancel.
describe("the Strategy Council call", () => {
  afterEach(() => { vi.useRealTimers(); });

  const waitForAbort = vi.fn((question, type, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));

  it("stops after the client deadline with the Council's own copy", async () => {
    vi.useFakeTimers();
    const { ctx, messages } = makeCtx({ input: "Should I drop AP Physics?", councilDecisionType: "course-selection", conveneStrategyCouncil: waitForAbort });
    const pending = send(ctx);
    await vi.advanceTimersByTimeAsync(COUNCIL_CLIENT_TIMEOUT_MS + 10);
    await pending;
    expect(messages().at(-1).content).toBe(councilTimeoutMessage("en-US"));
    expect(ctx.setInput.mock.calls.at(-1)[0]).toBe("Should I drop AP Physics?");
    expect(ctx.setCouncilDecisionType.mock.calls.at(-1)[0]).toBe("course-selection");
  });

  // The question came back after a failure but the Council mode did not, so
  // "try again" sent the Council question through ordinary chat and spent the
  // budget on a turn with no recommendation.
  it("puts the Council mode back with the question when the turn fails", async () => {
    for (const failure of [
      Object.assign(new Error("The Council is busy."), { status: 503, code: "provider_unavailable" }),
      Object.assign(new Error("I can't help with that request as written."), { status: 400, code: "COUNCIL_INPUT_BLOCKED", blocked: true }),
    ]) {
      rateLimiter.reset();
      const { ctx } = makeCtx({ input: "Should I drop AP Physics?", councilDecisionType: "course-selection", conveneStrategyCouncil: vi.fn(async () => { throw failure; }) });
      await send(ctx);
      expect(ctx.setInput.mock.calls.at(-1)[0]).toBe("Should I drop AP Physics?");
      expect(ctx.setCouncilDecisionType.mock.calls.at(-1)[0], failure.code).toBe("course-selection");
    }
    rateLimiter.reset();
    const ok = makeCtx({ input: "Should I drop AP Physics?", councilDecisionType: "course-selection" });
    await send(ok.ctx);
    expect(ok.ctx.setCouncilDecisionType.mock.calls.at(-1)[0]).toBeNull();
  });

  it("is stopped by Cancel", async () => {
    const { ctx, messages } = makeCtx({ input: "Should I drop AP Physics?", councilDecisionType: "course-selection", conveneStrategyCouncil: waitForAbort });
    const pending = send(ctx);
    await vi.waitFor(() => expect(ctx.abortRef.current).toBeTruthy());
    await vi.waitFor(() => expect(waitForAbort).toHaveBeenCalled());
    ctx.abortRef.current.abort(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    await pending;
    expect(messages().at(-1).content).toMatch(/^Cancelled/);
  });
});

// A long thread reopens with only its newest messages; the line saying so
// is a notice, never a turn the model is sent.
describe("openThread", () => {
  it("says when earlier messages are not shown", async () => {
    const { openThread } = await import("./chat-send.js");
    let shown = [];
    const ctx = {
      authedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ thread: { title: "Plans" }, messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }], truncated: true, olderCount: 40 }) })),
      locale: "en-US",
      refreshThreadList: vi.fn(),
      setActiveThreadId: vi.fn(),
      setMessages: vi.fn((next) => { shown = next; }),
    };
    await openThread(ctx, "thread-1");
    expect(shown[0]).toMatchObject({ role: "notice", transient: true, content: "Earlier messages are not shown (40 older messages)." });
    expect(shown.slice(1).map((m) => m.role)).toEqual(["user", "assistant"]);

    await openThread({ ...ctx, locale: "ko" }, "thread-1");
    expect(shown[0].content).toBe("이전 메시지 40개는 여기에 표시되지 않아요.");
  });

  it("adds nothing to a thread that came back whole", async () => {
    const { openThread } = await import("./chat-send.js");
    let shown = [];
    await openThread({
      authedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ thread: {}, messages: [{ role: "user", content: "Hi" }], truncated: false, olderCount: 0 }) })),
      refreshThreadList: vi.fn(), setActiveThreadId: vi.fn(), setMessages: (next) => { shown = next; },
    }, "thread-1");
    expect(shown.map((m) => m.role)).toEqual(["user"]);
  });
});
