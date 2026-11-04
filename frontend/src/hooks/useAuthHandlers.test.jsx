import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { handleLogin as handleLoginImpl } from "../handlers/auth-handlers.js";
import { useAuthHandlers } from "./useAuthHandlers.js";

vi.mock("../handlers/auth-handlers.js", () => ({
  handleCreate: vi.fn(async () => {}),
  handleLogin: vi.fn(async () => {}),
  handleStudentRecovery: vi.fn(async () => {}),
}));

// Sign-in's own message (the saved profile that could not be read) is in
// the app's language. The hook passes the locale App holds, and a switch of
// language makes a new handler, so the next sign-in uses the new one rather
// than the language the memoized handler was made in.
describe("useAuthHandlers.handleLogin", () => {
  const setters = Object.fromEntries([
    "setCError", "setData", "setLEmail", "setLError", "setLPass", "setMessages", "setOfflineMode",
    "setPassphrase", "setScreen", "setStudentRecoveryBusy", "setStudentRecoveryCode",
    "setStudentRecoveryInput", "setStudentRecoveryMessage", "setStudentRecoveryOpen",
    "setStudentRecoveryPassword", "setSurveyStep", "setUser", "setProfileReady", "setShowLoginPass",
    "setSyncBase", "setSyncNote", "setSyncStatus",
  ].map((name) => [name, vi.fn()]));
  const ctx = (locale) => ({ ...setters, authedFetch: vi.fn(), endSession: vi.fn(), lEmail: "jiyeon@school.edu", lPass: "correct-horse-battery", locale });

  it("hands sign-in the app's locale and follows the language switch", async () => {
    const { result, rerender } = renderHook((props) => useAuthHandlers(props), { initialProps: ctx("en-US") });
    await act(async () => { await result.current.handleLogin(); });
    expect(handleLoginImpl.mock.calls.at(-1)[0].locale).toBe("en-US");

    const before = result.current.handleLogin;
    rerender(ctx("ko"));
    expect(result.current.handleLogin).not.toBe(before);
    await act(async () => { await result.current.handleLogin(); });
    expect(handleLoginImpl.mock.calls.at(-1)[0].locale).toBe("ko");
  });
});
