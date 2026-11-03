import { describe, expect, it } from "vitest";
import { chatErrorFromResponse, chatErrorRetryable, formatChatError, isSessionExpiry, isSessionExpiryResponse } from "./chat-errors.js";

const headers = (map) => ({ get: (name) => map[name] ?? null });
const GENERIC = /Something went wrong|문제가 생겼어요/;

// Every (status, code) the chat and Council routes send. Until this table
// each one read "Something went wrong while answering that. Please try
// again." in English, whatever the cause and whatever the UI language.
const CASES = [
  { status: 402, body: { code: "monthly_cap_exceeded", error: "Monthly model budget does not allow this request.", budget: { remainingUsd: 0 } }, en: /used this month's AI budget/, ko: /예산을 모두 사용/ },
  { status: 402, body: { code: "monthly_cap_exceeded", budget: { remainingUsd: 0.4 } }, en: /more of your monthly AI budget than you have left/, ko: /남은 AI 예산보다/ },
  { status: 402, body: { code: "budget_exceeded" }, en: /used this month's AI budget/, ko: /예산을 모두 사용/ },
  { status: 402, body: { code: "unknown_model_pricing" }, en: /no price on file/, ko: /가격 정보가 없어서/ },
  { status: 402, body: { code: "grade_required" }, en: /grade \(9-12\)/, ko: /학년/ },
  { status: 403, body: { code: "consent_required", missing: ["ai_processing"] }, en: /permission to use AI/, ko: /동의가 필요해요/ },
  { status: 429, body: { code: "rate_limited", retryAfterSeconds: 42 }, en: /Wait 42 seconds/, ko: /42초/ },
  { status: 503, body: { code: "openrouter_not_configured" }, en: /isn't set up on this site/, ko: /설정되지 않아서/ },
  { status: 503, body: { code: "installation_setup_required" }, en: /isn't set up on this site/, ko: /설정되지 않아서/ },
  { status: 502, body: { code: "provider_error" }, en: /AI service had trouble/, ko: /문제가 생겼어요\. 1분 정도/ },
  { status: 502, body: { code: "provider_auth_failed" }, en: /still signed in/, ko: /로그인은 그대로/ },
  { status: 504, body: { code: "provider_timeout" }, en: /took too long/, ko: /너무 오래 걸려서/ },
  { status: 502, body: { code: "empty_model_reply" }, en: /empty answer/, ko: /빈 답변/ },
  { status: 401, body: { error: "Invalid or expired session token." }, en: /sign-in has expired/, ko: /로그인이 만료/ },
  { status: 401, body: { error: "Invalid or expired session token.", code: "session_invalid" }, en: /sign-in has expired/, ko: /로그인이 만료/ },
  { status: 409, body: { code: "request_id_released" }, en: /goes as a new request/, ko: /새 요청으로/ },
  { status: 409, body: { code: "duplicate_request_id" }, en: /already sent once/, ko: /이미 한 번/ },
  { status: 499, body: { code: "request_cancelled" }, en: /stopped before the counselor answered/, ko: /요청이 중단됐어요/ },
  { status: 400, body: { code: "invalid_request" }, en: /Reload the page/, ko: /새로 고친/ },
  { status: 402, body: { code: "identity_required" }, en: /Reload the page/, ko: /새로 고친/ },
];

describe("formatChatError", () => {
  for (const { status, body, en, ko } of CASES) {
    it(`${status} ${body.code}${body.budget ? ` (remaining ${body.budget.remainingUsd})` : ""} has its own copy in English and Korean`, () => {
      const err = chatErrorFromResponse(status, body);
      expect(formatChatError(err, "en-US")).toMatch(en);
      expect(formatChatError(err, "ko")).toMatch(ko);
      expect(formatChatError(err, "en-US")).not.toMatch(GENERIC);
    });
  }

  // The cap's 402 carries when the month ends. Noon UTC is the same calendar
  // day in every zone the test can run in.
  it("says when a used-up budget comes back, when the server says", () => {
    const err = chatErrorFromResponse(402, { code: "monthly_cap_exceeded", budget: { remainingUsd: 0, resetsAt: "2026-12-01T12:00:00.000Z" } });
    expect(formatChatError(err, "en-US")).toMatch(/until it resets on December 1\./);
    expect(formatChatError(err, "ko")).toMatch(/12월 1일에 예산이 초기화될 때까지/);
    const short = chatErrorFromResponse(402, { code: "monthly_cap_exceeded", budget: { remainingUsd: 0.4, resetsAt: "2026-12-01T12:00:00.000Z" } });
    expect(formatChatError(short, "en-US")).toMatch(/resets on December 1\./);
    const unknown = chatErrorFromResponse(402, { code: "monthly_cap_exceeded", budget: { remainingUsd: 0, resetsAt: "soon" } });
    expect(formatChatError(unknown, "en-US")).toMatch(/at the start of next month/);
  });

  it("tells a fresh-id resend, a stop and a server fault apart from a dead end", () => {
    expect(chatErrorRetryable(chatErrorFromResponse(409, { code: "request_id_released" }))).toBe(true);
    expect(chatErrorRetryable(chatErrorFromResponse(402, { code: "request_id_conflict" }))).toBe(true);
    expect(chatErrorRetryable(chatErrorFromResponse(499, { code: "request_cancelled" }))).toBe(true);
    expect(chatErrorRetryable(chatErrorFromResponse(400, { code: "invalid_request" }))).toBe(false);
    const internal = chatErrorFromResponse(500, { code: "internal_error" });
    expect(chatErrorRetryable(internal)).toBe(true);
    expect(formatChatError(internal, "en-US")).toMatch(/Trying again in a minute may help/);
    expect(formatChatError(internal, "ko")).toMatch(/1분 뒤에 다시 시도/);
  });

  it("takes the wait from the Retry-After header when the body has none", () => {
    const err = chatErrorFromResponse(429, { error: "Too many requests." }, headers({ "Retry-After": "17" }));
    expect(err.retryAfterSeconds).toBe(17);
    expect(formatChatError(err, "en-US")).toMatch(/Wait 17 seconds/);
  });

  it("says whether trying again can help when the code is unknown", () => {
    const transient = formatChatError(chatErrorFromResponse(500, { code: "some_new_code" }), "en-US");
    const permanent = formatChatError(chatErrorFromResponse(400, { code: "some_new_code" }), "en-US");
    expect(transient).toMatch(/Trying again in a minute may help/);
    expect(permanent).toMatch(/probably won't help/);
    expect(formatChatError(chatErrorFromResponse(400, {}), "ko")).toMatch(/다시 보내도 해결되지 않을/);
  });

  it("keeps reading the older servers' and the browser's messages", () => {
    expect(formatChatError(new Error("Failed to fetch"), "en-US")).toMatch(/internet connection/);
    expect(formatChatError(new Error("The model call timed out"), "ko")).toMatch(/너무 오래 걸려서/);
    expect(formatChatError(chatErrorFromResponse(503, { error: "An administrator must configure OpenRouter before chat is available." }), "en-US")).toMatch(/isn't set up/);
  });

  it("keeps the code, budget and missing consents on the error", () => {
    const err = chatErrorFromResponse(402, { error: "x", code: "monthly_cap_exceeded", budget: { capUsd: 10, remainingUsd: 0 } });
    expect(err.status).toBe(402);
    expect(err.code).toBe("monthly_cap_exceeded");
    expect(err.budget.capUsd).toBe(10);
    expect(chatErrorRetryable(err)).toBe(false);
    expect(chatErrorFromResponse(403, { code: "consent_required", missing: ["ai"] }).missing).toEqual(["ai"]);
    expect(chatErrorRetryable(chatErrorFromResponse(502, { code: "empty_model_reply" }))).toBe(true);
  });
});

// A provider 401 forwarded as our own 401 set off a hidden sign-in on every
// call. Only a 401 that is about the session is one.
describe("isSessionExpiry", () => {
  it("is true for the session middleware's 401, which carries no code", () => {
    expect(isSessionExpiry(401, { error: "Invalid or expired session token." })).toBe(true);
    expect(isSessionExpiry(401, { code: "session_invalid" })).toBe(true);
  });
  it("is false for a provider's refusal, whatever status it arrived with", () => {
    expect(isSessionExpiry(401, { code: "provider_auth_failed" })).toBe(false);
    expect(isSessionExpiry(401, { code: "auth_rejected", upstreamStatus: 401 })).toBe(false);
    expect(isSessionExpiry(401, { code: "llm_error", provider: "openrouter" })).toBe(false);
    expect(isSessionExpiry(502, { code: "provider_auth_failed" })).toBe(false);
  });
});

describe("isSessionExpiryResponse", () => {
  const response = (status, body) => ({ status, clone: () => ({ json: async () => body }) });
  it("reads the body from a clone, leaving the response unread", async () => {
    expect(await isSessionExpiryResponse(response(401, { error: "Invalid or expired session token." }))).toBe(true);
    expect(await isSessionExpiryResponse(response(401, { code: "auth_rejected", upstreamStatus: 401 }))).toBe(false);
    expect(await isSessionExpiryResponse(response(200, {}))).toBe(false);
    expect(await isSessionExpiryResponse({ status: 401 })).toBe(true);
  });
});
