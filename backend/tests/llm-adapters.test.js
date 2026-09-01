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
        fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        }),
      }),
      (error) => error.code === "provider_timeout" && error.status === 504,
    );
  } finally {
    delete process.env.LLM_CALL_TIMEOUT_MS;
  }
});
