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
