import test from "node:test";
import assert from "node:assert/strict";
import {
  callLLM,
  detectProvider,
  isReasonableModelId,
  listProviders,
  PROVIDERS,
  TIER_DEFAULTS,
  OPENROUTER_BASE_URL,
  isReasoningModel,
} from "../llm-adapters/index.js";

function fakeResponse(text = "grounded response", status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => status === 200 ? {
      id: "chatcmpl-1",
      model: TIER_DEFAULTS.openrouter.small,
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    } : { error: { message: "unauthorized" } },
  };
}

test("only OpenRouter can be detected or listed", () => {
  assert.equal(detectProvider({ apiKey: "sk-or-test" }), PROVIDERS.OPENROUTER);
  assert.equal(detectProvider({ apiKey: "sk-test" }), null);
  assert.equal(detectProvider({ apiKey: "AIza-test" }), null);
  assert.equal(detectProvider({
    apiKey: "sk-or-test",
    baseUrl: "https://attacker.invalid/v1",
  }), null);
  assert.deepEqual(listProviders().map((provider) => provider.id), ["openrouter"]);
});

test("model id shape rejects injection syntax", () => {
  assert.equal(isReasonableModelId("google/gemma-4-26b-a4b-it"), true);
  for (const value of ["", "ab", "bad model", "bad\nmodel", "; DROP TABLE", null, 42]) {
    assert.equal(isReasonableModelId(value), false);
  }
});

test("OpenRouter round-trip always uses the fixed endpoint", async () => {
  let capturedUrl;
  let capturedBody;
  const result = await callLLM({
    provider: "openrouter",
    apiKey: "sk-or-test",
    baseUrl: OPENROUTER_BASE_URL,
    model: TIER_DEFAULTS.openrouter.small,
    system: "Use supplied evidence only.",
    messages: [{ role: "user", content: "Help with my course plan." }],
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return fakeResponse();
    },
  });
  assert.equal(capturedUrl, OPENROUTER_BASE_URL + "/chat/completions");
  assert.equal(capturedBody.messages[0].role, "system");
  assert.equal(result.content[0].text, "grounded response");
  assert.equal(result.usage.input_tokens, 8);
  assert.equal(result.usage.output_tokens, 3);
});

test("OpenRouter errors are normalized", async () => {
  await assert.rejects(
    callLLM({
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: TIER_DEFAULTS.openrouter.small,
      messages: [{ role: "user", content: "hello" }],
      fetchImpl: async () => fakeResponse("", 401),
    }),
    (error) => error.status === 401 && error.code === "auth_rejected",
  );
});

test("tier resolution, abort signals, and disabled tools are enforced", async () => {
  let body;
  let signal;
  const controller = new AbortController();
  await callLLM({
    provider: "openrouter",
    apiKey: "sk-or-test",
    tier: "small",
    messages: [{ role: "user", content: "hello" }],
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      signal = options.signal;
      return fakeResponse();
    },
  });
  assert.equal(body.model, TIER_DEFAULTS.openrouter.small);
  // The adapter composes the caller's signal with its own provider-timeout
  // signal (AbortSignal.any), so identity is no longer expected — what
  // matters is that the caller's abort still propagates to the fetch.
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal(signal.aborted, true);

  await assert.rejects(
    callLLM({
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: TIER_DEFAULTS.openrouter.small,
      messages: [{ role: "user", content: "search the web" }],
      tools: [{ type: "web_search", name: "web_search" }],
    }),
    (error) => error.code === "tools_disabled",
  );
});

// A provider socket that never answers used to hang the request (and the
// student's UI) indefinitely — Node's fetch has no default timeout.
test("a stalled provider call is aborted by the adapter timeout", async () => {
  process.env.LLM_CALL_TIMEOUT_MS = "50";
  try {
    await assert.rejects(
      callLLM({
        provider: "openrouter",
        apiKey: "sk-or-test",
        model: TIER_DEFAULTS.openrouter.small,
        messages: [{ role: "user", content: "hello" }],
        // A stall = the promise settles only on abort. On a slow CI runner the
        // tiny timeout can fire BEFORE this mock runs, and an already-aborted
        // signal never emits "abort" — guard for it or the promise (and the
        // test) hangs forever.
        fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
          if (options.signal.aborted) return reject(options.signal.reason);
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        }),
      }),
      (error) => error.code === "provider_timeout" && error.status === 504,
    );
  } finally {
    delete process.env.LLM_CALL_TIMEOUT_MS;
  }
});

// OpenRouter sends the headers at once and the body when generation ends.
// An attempt whose body read is cut off by the attempt budget used to come
// back as an empty 200 (the JSON parse failure was swallowed), so the chat
// answered "There is not enough information…" at exactly the budget and
// the retry never ran. It must throw as an abort and retry.
test("an attempt cut off while reading the body retries on a fresh connection", async () => {
  process.env.LLM_CALL_TIMEOUT_MS = "120";
  const calls = [];
  try {
    const result = await callLLM({
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: TIER_DEFAULTS.openrouter.small,
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 1024,
      fetchImpl: (_url, options) => {
        calls.push(Date.now());
        if (calls.length === 1) {
          // Headers arrive; the body settles only on abort.
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => new Promise((_resolve, reject) => {
              const fail = () => { const err = new Error("aborted"); err.name = "AbortError"; reject(err); };
              if (options.signal.aborted) return fail();
              options.signal.addEventListener("abort", fail, { once: true });
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: "x", model: TIER_DEFAULTS.openrouter.small, choices: [{ message: { role: "assistant", content: "second attempt" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
        });
      },
    });
    assert.equal(calls.length, 2, "the cut-off attempt must be retried");
    assert.match(JSON.stringify(result), /second attempt/);
  } finally {
    delete process.env.LLM_CALL_TIMEOUT_MS;
  }
});

// Some providers hand the content back as an array of parts; that used to
// translate to an empty answer.
test("array content translates to the joined text", async () => {
  const result = await callLLM({
    provider: "openrouter",
    apiKey: "sk-or-test",
    model: TIER_DEFAULTS.openrouter.small,
    messages: [{ role: "user", content: "hello" }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "x", model: TIER_DEFAULTS.openrouter.small, choices: [{ message: { role: "assistant", content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    }),
  });
  assert.equal(result.content[0].text, "part one part two");
});

// A reasoning-capable model outside the reasoning list can spend a small
// budget thinking and return empty content with finish_reason "length" —
// the chat then showed "There is not enough information…" after a
// normal-length call. One follow-up with room for the answer, and the
// model starts at that budget for the rest of the process.
test("an empty reply that exhausted its budget is retried with a larger one", async () => {
  // The small default is not on the reasoning list, so it starts at the
  // requested budget. This test is last in the file: after it the model
  // starts at 4,096 for the rest of the process.
  const model = TIER_DEFAULTS.openrouter.small;
  assert.equal(isReasoningModel(model), false);
  const budgets = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    budgets.push(body.max_tokens);
    const answered = body.max_tokens >= 4096;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "x", model,
        choices: [{ message: { role: "assistant", content: answered ? "the answer" : "", reasoning: "thinking…" }, finish_reason: answered ? "stop" : "length" }],
        usage: { prompt_tokens: 3, completion_tokens: 1024, completion_tokens_details: { reasoning_tokens: 1024 } },
      }),
    };
  };
  const first = await callLLM({ provider: "openrouter", apiKey: "sk-or-test", model, messages: [{ role: "user", content: "hello" }], maxTokens: 1024, fetchImpl });
  assert.deepEqual(budgets, [1024, 4096]);
  assert.equal(first.content[0].text, "the answer");
  assert.equal(first.budget_retry, true);
  // The next call on that model starts at the larger budget.
  const second = await callLLM({ provider: "openrouter", apiKey: "sk-or-test", model, messages: [{ role: "user", content: "again" }], maxTokens: 1024, fetchImpl });
  assert.deepEqual(budgets, [1024, 4096, 4096]);
  assert.equal(second.content[0].text, "the answer");
  assert.notEqual(second.budget_retry, true);
});
