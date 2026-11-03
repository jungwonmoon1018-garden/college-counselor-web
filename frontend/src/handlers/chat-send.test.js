import { beforeEach, describe, expect, it, vi } from "vitest";

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
    formatUserFacingError: (err) => String(err?.message || err),
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
