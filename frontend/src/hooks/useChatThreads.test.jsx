import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatThreads } from "./useChatThreads.js";

// A failed thread create returned null in silence, the turn ran with no
// thread, and the conversation was gone after a reload with no warning.
describe("useChatThreads.newThread", () => {
  function setup(authedFetch, locale = "en-US") {
    const ctx = { authedFetch, locale, setMessages: vi.fn(), setSyncNote: vi.fn(), setSyncStatus: vi.fn() };
    const { result } = renderHook(() => useChatThreads(ctx));
    return { ctx, result };
  }

  it("raises the sync warning when the server refuses the create", async () => {
    const { ctx, result } = setup(vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    let id;
    await act(async () => { id = await result.current.newThread(undefined, true); });
    expect(id).toBeNull();
    expect(ctx.setSyncStatus).toHaveBeenCalledWith("failed");
    expect(ctx.setSyncNote.mock.calls.at(-1)[0]).toMatch(/couldn't be saved/);
  });

  it("raises it in Korean when the request throws", async () => {
    const { ctx, result } = setup(vi.fn(async () => { throw new TypeError("Failed to fetch"); }), "ko");
    await act(async () => { await result.current.newThread(undefined, true); });
    expect(ctx.setSyncNote.mock.calls.at(-1)[0]).toMatch(/저장할 수 없었어요/);
  });

  it("stays quiet when the thread is created", async () => {
    const authedFetch = vi.fn(async (path) => (path === "/api/students/threads" ? { ok: true, json: async () => ({ id: "thread-9", threads: [] }) } : { ok: true, json: async () => ({ threads: [] }) }));
    const { ctx, result } = setup(authedFetch);
    let id;
    await act(async () => { id = await result.current.newThread(undefined, true); });
    expect(id).toBe("thread-9");
    expect(ctx.setSyncStatus).not.toHaveBeenCalled();
  });
});
