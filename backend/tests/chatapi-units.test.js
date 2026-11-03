// Unit pins for the chat reliability pieces the route tests reach only in
// part: which replies count as unusable, the verified-figure backstop of the
// fidelity retry, the one error-to-status translation, the adapter's error
// bodies and summed usage, and the per-student chat limiter.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { numbersDroppedFromVerified, unusableReplyReason } from "../chat/usable-reply.js";
import { modelErrorResponse, respondLLMError } from "../server/model-calls.js";
import { callLLM, effectiveMaxTokens, isReasoningModel, sumUsage, TIER_DEFAULTS } from "../llm-adapters/index.js";
import { __internals as openaiInternals } from "../llm-adapters/openai.js";
import { CHAT_RATE_LIMIT, createChatRateLimiters } from "../security/security-hardening.js";
import { CHAT_RETRY_CUTOFF_MS } from "../routes/chat.js";
import { readFrontendSource } from "./helpers/frontend-source.mjs";

test("empty, whitespace, tool-markup-only and error-bodied replies are unusable; real answers are not", () => {
  assert.equal(unusableReplyReason({ stop_reason: "stop" }, ""), "empty");
  assert.equal(unusableReplyReason({ stop_reason: "stop" }, "  \n "), "empty");
  assert.equal(unusableReplyReason({ stop_reason: "length" }, ""), "cut_off_empty");
  assert.equal(unusableReplyReason({ stop_reason: "error", provider_error: "upstream" }, ""), "provider_error_body");
  // What screenOutput leaves of <tool_call>{...}</tool_call>.
  assert.equal(unusableReplyReason({ stop_reason: "stop" }, '{"name":"fetch_rag_context","arguments":{"focus":"ec"}}'), "tool_markup_only");
  assert.equal(unusableReplyReason({ stop_reason: "stop" }, '[{"name":"get_student_profile","parameters":{}}]'), "tool_markup_only");
  // Utility JSON and ordinary prose are answers.
  assert.equal(unusableReplyReason({ stop_reason: "stop" }, '{"category":"safe_college","route_to":["college"]}'), null);
  assert.equal(unusableReplyReason({ stop_reason: "stop" }, '{"name":"Robotics Club","role":"Captain","impact":"regional finalist"}'), null);
  assert.equal(unusableReplyReason({ stop_reason: "length" }, "Lead with the competition results and"), null);
  assert.equal(unusableReplyReason({ stop_reason: "stop" }, "Lead with the competition results."), null);
});

test("the fidelity backstop keeps the first answer only when the retry loses a verified figure", () => {
  const verified = "VERIFIED DATA\nStanford University: admit rate 3.9%; SAT middle 50% 1500-1570; cost of attendance 92,076 USD.";
  const first = "Your A in AP English stands out. Stanford admits 3.9% of applicants, and the cost is 92,076 USD.";
  // The retry fixes the grade and keeps the school's figures.
  assert.deepEqual(numbersDroppedFromVerified(first, "Your B+ in AP English stands out. Stanford admits 3.9% of applicants, and the cost is 92,076 USD.", verified), []);
  // The retry drops one figure and changes another.
  assert.deepEqual(
    numbersDroppedFromVerified(first, "Your B+ in AP English stands out. Stanford admits about 4% of applicants, and costs are high.", verified).sort(),
    ["3.9%", "92076"].sort(),
  );
  // With no VERIFIED DATA block there is nothing to protect.
  assert.deepEqual(numbersDroppedFromVerified(first, "Your B+ in AP English stands out.", ""), []);
  // A misstated value the check flagged is meant to change, even when it
  // equals a verified figure (a GPA that happens to match an average).
  const gpaVerified = "VERIFIED DATA\nExample University: average GPA 3.90.";
  assert.deepEqual(
    numbersDroppedFromVerified("Your 3.90 GPA matches Example's 3.90 average.", "Your 3.82 GPA is near Example's average.", gpaVerified, [{ kind: "gpa", stated: "3.90" }]),
    [],
  );
});

test("an upstream 401 or 403 never leaves as our own; budget, consent and duplicate keep theirs", () => {
  const upstream = (status, code) => Object.assign(new Error("x"), { status, code, provider: "openrouter" });
  assert.deepEqual(
    [modelErrorResponse(upstream(401, "auth_rejected")).status, modelErrorResponse(upstream(401, "auth_rejected")).body.code],
    [502, "provider_auth_failed"],
  );
  assert.equal(modelErrorResponse(upstream(403, "auth_rejected")).body.code, "provider_auth_failed");
  assert.deepEqual([modelErrorResponse(upstream(504, "provider_timeout")).status, modelErrorResponse(upstream(504, "provider_timeout")).body.code], [504, "provider_timeout"]);
  // OpenRouter's own 402 (credit) and 429 are not the student's cap or our limiter.
  assert.deepEqual([modelErrorResponse(upstream(402, "http_error")).status, modelErrorResponse(upstream(402, "http_error")).body.code], [502, "provider_error"]);
  assert.deepEqual([modelErrorResponse(upstream(429, "http_error")).status, modelErrorResponse(upstream(429, "http_error")).body.code], [502, "provider_error"]);
  assert.equal(modelErrorResponse(upstream(502, "network_error")).body.code, "provider_error");
  assert.equal(modelErrorResponse(upstream(400, "missing_api_key")).body.code, "openrouter_not_configured");

  const budget = modelErrorResponse(Object.assign(new Error("Monthly model budget does not allow this request."), { status: 402, code: "monthly_cap_exceeded", budget: { remainingUsd: 0 } }));
  assert.deepEqual([budget.status, budget.body.code, budget.body.budget.remainingUsd], [402, "monthly_cap_exceeded", 0]);
  const consent = modelErrorResponse(Object.assign(new Error("x"), { status: 403, code: "consent_required", missing: ["ai_interaction"] }));
  assert.deepEqual([consent.status, consent.body.code, consent.body.missing], [403, "consent_required", ["ai_interaction"]]);
  const duplicate = modelErrorResponse(Object.assign(new Error("dup"), { status: 409, code: "duplicate_request_id" }));
  assert.deepEqual([duplicate.status, duplicate.body.code], [409, "duplicate_request_id"]);
  assert.deepEqual([modelErrorResponse(Object.assign(new Error("e"), { status: 502, code: "empty_model_reply" })).body.code], ["empty_model_reply"]);
  // Our own bug is a coded 500, not a provider error.
  assert.deepEqual([modelErrorResponse(new TypeError("boom")).status, modelErrorResponse(new TypeError("boom")).body.code], [500, "internal_error"]);

  // The other model routes answer the same way.
  let sent = null;
  const res = { status(code) { sent = { code }; return this; }, json(body) { sent.body = body; return this; } };
  respondLLMError(res, upstream(401, "auth_rejected"), "test");
  assert.equal(sent.code, 502);
  assert.equal(sent.body.code, "provider_auth_failed");
  assert.match(sent.body.error, /credential/);
});

test("a 200 that carries an error body translates to stop_reason error, not an empty answer", () => {
  const translated = openaiInternals.translateOpenAIResponseToAnthropic({ error: { message: "Provider returned error", code: 502 } }, { fallbackModel: "m" });
  assert.equal(translated.stop_reason, "error");
  assert.match(translated.provider_error, /Provider returned error/);
  assert.equal(translated.content[0].text, "");
  const choiceError = openaiInternals.translateOpenAIResponseToAnthropic({ choices: [{ message: { content: "" }, finish_reason: "error" }] }, { fallbackModel: "m" });
  assert.equal(choiceError.stop_reason, "error");
  const normal = openaiInternals.translateOpenAIResponseToAnthropic({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }, { fallbackModel: "m" });
  assert.equal(normal.stop_reason, "stop");
  assert.equal(normal.provider_error, undefined);
});

test("the adapter bills both calls of its larger-budget follow-up, and reservations use its real output budget", async () => {
  const model = TIER_DEFAULTS.openrouter.small;
  assert.equal(isReasoningModel(model), false);
  assert.equal(effectiveMaxTokens(model, 1024), 1024);
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const answered = body.max_tokens >= 4096;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "x", model,
        choices: [{ message: { role: "assistant", content: answered ? "the answer" : "", reasoning: "thinking" }, finish_reason: answered ? "stop" : "length" }],
        usage: { prompt_tokens: 3000, completion_tokens: answered ? 200 : 1024 },
      }),
    };
  };
  const result = await callLLM({ provider: "openrouter", apiKey: "sk-or-test", model, messages: [{ role: "user", content: "hello" }], maxTokens: 1024, fetchImpl });
  assert.equal(result.budget_retry, true);
  assert.equal(result.usage.input_tokens, 6000);
  assert.equal(result.usage.output_tokens, 1224);
  // The model now starts at 4,096, and a reservation for it says so.
  assert.equal(effectiveMaxTokens(model, 1024), 4096);
  const reasoning = Object.values(TIER_DEFAULTS.openrouter).find((id) => isReasoningModel(id));
  if (reasoning) assert.equal(effectiveMaxTokens(reasoning, 600), 8192);
  assert.deepEqual(sumUsage({ input_tokens: 1, output_tokens: 2 }, { input_tokens: 3 }), { input_tokens: 4, output_tokens: 2 });
});

async function limiterHarness(t) {
  const { chatIpLimiter, chatStudentLimiter } = createChatRateLimiters();
  const app = express();
  // A stand-in for requireStudentAuth: the student is named in a header.
  const auth = (req, res, next) => {
    req.studentId = req.headers["x-student"] || null;
    if (!req.studentId) return res.status(401).json({ error: "auth" });
    next();
  };
  app.post("/api/chat", chatIpLimiter, auth, chatStudentLimiter, (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/chat`;
  return (student) => fetch(url, { method: "POST", headers: { "x-student": student } });
}

test("the chat limiter counts per student, so classmates on one network do not share a bucket", async (t) => {
  assert.equal(CHAT_RATE_LIMIT.perStudent, 60);
  assert.equal(CHAT_RATE_LIMIT.perIp, 300);
  const post = await limiterHarness(t);
  for (let i = 0; i < CHAT_RATE_LIMIT.perStudent; i++) {
    const [a, b] = await Promise.all([post("student-a"), post("student-b")]);
    assert.equal(a.status, 200, `student a, call ${i + 1}`);
    assert.equal(b.status, 200, `student b, call ${i + 1}`);
  }
  const limited = await post("student-a");
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(body.retryAfterSeconds, Number(limited.headers.get("retry-after")));
  // A third classmate on the same address is unaffected.
  assert.equal((await post("student-c")).status, 200);
});

test("one address is still capped across students at the per-IP ceiling", async (t) => {
  const post = await limiterHarness(t);
  let sent = 0;
  // 300 calls spread over six students (50 each, under the per-student 60).
  for (let student = 0; student < 6; student++) {
    const batch = await Promise.all(Array.from({ length: 50 }, () => post(`ceiling-${student}`)));
    for (const response of batch) assert.equal(response.status, 200);
    sent += batch.length;
  }
  assert.equal(sent, CHAT_RATE_LIMIT.perIp);
  const over = await post("ceiling-new");
  assert.equal(over.status, 429);
  assert.equal((await over.json()).code, "rate_limited");
});

test("a Council seat that cannot parse its reply reports the usage of both tries, and names why it abstained", async () => {
  const { Councilor } = await import("../council/councilor.js");
  let calls = 0;
  const seat = new Councilor({
    role: "Strategist",
    getSystemPrompt: () => "system",
    tier: "small",
    callModel: async () => {
      calls += 1;
      return { content: [{ type: "text", text: "prose, not JSON" }], usage: { input_tokens: 100, output_tokens: 7 } };
    },
  });
  const unparseable = await seat.deliberate({ question: "q", context: { text: "c", evidenceIndex: {} }, llm: { apiKey: "sk-or-test" } });
  assert.equal(calls, 2);
  assert.equal(unparseable.abstained, true);
  assert.equal(unparseable.abstain_reason, "unparseable");
  assert.deepEqual([unparseable.usage.input_tokens, unparseable.usage.output_tokens], [200, 14]);

  // A rejected key is not retried; a transient 5xx gets the second try.
  const tries = [];
  const failing = (error) => new Councilor({
    role: "Strategist",
    getSystemPrompt: () => "system",
    callModel: async () => { tries.push(error.code); throw error; },
  });
  const rejected = await failing(Object.assign(new Error("401"), { status: 401, code: "auth_rejected", provider: "openrouter" }))
    .deliberate({ question: "q", context: { text: "c", evidenceIndex: {} }, llm: { apiKey: "sk-or-test" } });
  assert.equal(rejected.abstain_reason, "provider");
  assert.deepEqual(rejected.provider_error.status, 401);
  assert.equal(tries.length, 1);
  await failing(Object.assign(new Error("502"), { status: 502, code: "http_error", provider: "openrouter" }))
    .deliberate({ question: "q", context: { text: "c", evidenceIndex: {} }, llm: { apiKey: "sk-or-test" } });
  assert.equal(tries.length, 3);

  // A closed request stops the seat instead of abstaining.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    failing(Object.assign(new Error("aborted"), { status: 499, code: "aborted", provider: "openrouter" }))
      .deliberate({ question: "q", context: { text: "c", evidenceIndex: {} }, llm: { apiKey: "sk-or-test" }, signal: controller.signal }),
    /aborted/,
  );
});

// The server stops starting retries well before the client gives up on the
// call; if the two constants drift together, a retry lands after the
// student has been told the counselor timed out.
test("the server's retry cutoff leaves a full model call of room under the client's timeout", () => {
  const match = readFrontendSource().match(/MODEL_CALL_TIMEOUT_MS\s*=\s*([\d_]+)/);
  assert.ok(match, "the client's model-call timeout constant");
  const clientTimeoutMs = Number(match[1].replace(/_/g, ""));
  assert.equal(CHAT_RETRY_CUTOFF_MS, 60_000);
  assert.ok(clientTimeoutMs - CHAT_RETRY_CUTOFF_MS >= 60_000, `client ${clientTimeoutMs} ms vs cutoff ${CHAT_RETRY_CUTOFF_MS} ms`);
});

// Route tests relax every limit a hundredfold, so the wiring is pinned by
// its text: the IP ceiling ahead of the session check, the per-student
// limiter inside it, both from the factory above.
test("/api/chat mounts the per-IP ceiling before sign-in and the per-student limiter after it", async () => {
  const { readServerSource } = await import("./helpers/server-source.mjs");
  const source = readServerSource();
  assert.match(source, /createChatRateLimiters\(\{ hashIP, relax: relaxedMax \}\)/);
  assert.match(source, /app\.post\("\/api\/chat", chatIpLimiter, requireStudentAuth, parseLargeJsonBody, async/);
  assert.match(source, /requireStudentAuth\(req, res, \(err\) => \(err \? next\(err\) : chatStudentLimiter\(req, res, next\)\)\)/);
});
