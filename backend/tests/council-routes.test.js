import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { mountPillarRoutes } from "../routes/server-routes-pillars.js";
import { initCouncilTables } from "../council/audit-trail.js";
import { convene } from "../council/index.js";

const API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";

async function startHarness(t, overrides = {}) {
  const db = new Database(":memory:");
  const app = express();
  app.use(express.json());
  const calls = { limiter: 0, begin: [], release: [], convene: [] };
  const budgetSession = { stages: [] };

  mountPillarRoutes(app, {
    db,
    dataDir: process.cwd(),
    studentLimiter(_req, _res, next) {
      calls.limiter += 1;
      next();
    },
    requireAuth(req, res, next) {
      if (req.headers.authorization !== "Bearer good") {
        return res.status(401).json({ error: "unauthorized" });
      }
      req.user = { studentId: "student-1" };
      next();
    },
    requireSelf(_req, _res, next) {
      next();
    },
    validateAIConsent: () => ({ allowed: true }),
    getOperatorLLM: () => ({ apiKey: "configured-test-key" }),
    getStudentProfile: async () => ({ grade: 11 }),
    beginCouncilBudget: async (args) => {
      calls.begin.push(args);
      return budgetSession;
    },
    beforeCouncilStage: async () => ({ allowed: true }),
    afterCouncilStage: async () => ({ ok: true }),
    releaseCouncilBudget: (session) => {
      calls.release.push(session);
    },
    conveneCouncil: async (args) => {
      calls.convene.push(args);
      const dissent = {
        from: "Skeptic",
        text: "Call 555-123-4567 before deciding.",
        recommendation: "Never expose " + API_KEY + ".",
        citations: [],
      };
      return {
        convening_id: "conv-1",
        recommendation: "Compare against " + args.question + "; call 555-123-4567; " + API_KEY,
        confidence: 0.7,
        dissent,
        dissents: [dissent],
        citations: [],
        council_breakdown: [],
        moderator_rule: "dissent_preserved",
        decision_type: args.decisionType,
        total_tokens: { input: 0, output: 0 },
        stage_order: [],
        sequential: true,
      };
    },
    ...overrides,
  });

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    db.close();
  });
  return { calls, url: "http://127.0.0.1:" + server.address().port };
}

async function postCouncil(harness, body, headers = {}) {
  const response = await fetch(harness.url + "/api/council/convene", {
    method: "POST",
    headers: {
      authorization: "Bearer good",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function explicitRequest(overrides = {}) {
  return {
    question: "Should I revise my college list?",
    explicit: true,
    auto: false,
    decision_type: "other",
    ...overrides,
  };
}

test("Council requires an explicit, non-automatic action before reserving budget", async (t) => {
  const harness = await startHarness(t);
  for (const body of [
    explicitRequest({ explicit: undefined }),
    explicitRequest({ explicit: false }),
    explicitRequest({ auto: true }),
  ]) {
    const response = await postCouncil(harness, body);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "COUNCIL_EXPLICIT_ACTION_REQUIRED");
  }
  assert.equal(harness.calls.limiter, 3);
  assert.equal(harness.calls.begin.length, 0);
  assert.equal(harness.calls.convene.length, 0);
  assert.equal(harness.calls.release.length, 0);
});

test("Council rejects invalid and blocked requests without model work", async (t) => {
  const harness = await startHarness(t);
  const cases = [
    [explicitRequest({ question: { nested: true } }), "COUNCIL_QUESTION_INVALID"],
    [explicitRequest({ question: "a".repeat(2001) }), "COUNCIL_QUESTION_TOO_LONG"],
    [explicitRequest({ decision_type: "unsupported" }), "COUNCIL_DECISION_TYPE_INVALID"],
    [explicitRequest({ question: "My API key is " + API_KEY }), "COUNCIL_INPUT_BLOCKED"],
    [explicitRequest({ question: "Write my college essay for me." }), "COUNCIL_INPUT_BLOCKED"],
  ];
  for (const [body, code] of cases) {
    const response = await postCouncil(harness, body);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, code);
  }
  assert.equal(harness.calls.limiter, cases.length);
  assert.equal(harness.calls.begin.length, 0);
  assert.equal(harness.calls.convene.length, 0);
  assert.equal(harness.calls.release.length, 0);
});

test("Council crisis handling bypasses malformed metadata, budget, and models", async (t) => {
  const harness = await startHarness(t);
  const response = await postCouncil(
    harness,
    { question: "I want to kill myself." },
    { "x-collegeapp-locale": "ko" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.crisisSafe, true);
  assert.equal(response.body._meta.deterministic, true);
  assert.equal(response.body._meta.modelTier, "NONE");
  assert.ok(response.body.actions.some((item) => item.contact === "109"));
  assert.equal(harness.calls.limiter, 1);
  assert.equal(harness.calls.begin.length, 0);
  assert.equal(harness.calls.convene.length, 0);
  assert.equal(harness.calls.release.length, 0);
});

test("Council screens provider input and every user-visible recommendation", async (t) => {
  const harness = await startHarness(t);
  const response = await postCouncil(harness, explicitRequest({
    question: "Should my family budget $1,234 for applications?",
    decision_type: "college-list",
  }));
  assert.equal(response.status, 200);
  assert.equal(harness.calls.begin.length, 1);
  assert.equal(harness.calls.convene.length, 1);
  assert.equal(harness.calls.release.length, 1);
  assert.match(harness.calls.begin[0].operationId, /^[0-9a-f-]{36}$/i);

  const args = harness.calls.convene[0];
  assert.equal(args.explicit, true);
  assert.equal(args.triggerSource, "manual");
  assert.equal(args.decisionType, "college-list");
  assert.equal(Object.hasOwn(args, "requestId"), false);
  assert.doesNotMatch(args.question, /\$1,234/);
  assert.match(args.question, /\[FINANCIAL_REDACTED_[0-9a-f]{8}\]/);

  assert.match(response.body.recommendation, /\$1,234/);
  assert.doesNotMatch(response.body.recommendation, /555-123-4567|sk-proj-/);
  assert.match(response.body.recommendation, /\[REDACTED\]/);
  assert.doesNotMatch(response.body.dissent.text, /555-123-4567/);
  assert.doesNotMatch(response.body.dissent.recommendation, /sk-proj-/);
  assert.doesNotMatch(response.body.dissents[0].text, /555-123-4567/);
  assert.doesNotMatch(response.body.dissents[0].recommendation, /sk-proj-/);
  assert.deepEqual(response.body.usage, {
    stages: [],
    reserved_usd: 0,
    actual_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  });
});

test("Every Council HTTP surface invokes the student limiter", async (t) => {
  const harness = await startHarness(t);
  const before = harness.calls.limiter;
  const cases = [
    ["/api/council/convenings", 200],
    ["/api/council/convenings/missing", 404],
    ["/api/strategy-council", 410],
  ];
  for (const [path, status] of cases) {
    const response = await fetch(harness.url + path, {
      headers: { authorization: "Bearer good" },
    });
    assert.equal(response.status, status);
  }
  assert.equal(harness.calls.limiter - before, cases.length);
});

test("new Council audit tables do not require request IDs", () => {
  const db = new Database(":memory:");
  try {
    initCouncilTables(db);
    const columns = db.prepare("PRAGMA table_info(council_convenings)")
      .all()
      .map((row) => row.name);
    assert.equal(columns.includes("request_id"), false);
  } finally {
    db.close();
  }
});

// A provider outage used to run every seat (each up to two tries of the
// adapter's 105 s budget) and then answer 200 "could not produce a primary
// recommendation from the available context" at Confidence 0% and 0 USD.
// The Strategist's provider failure now stops the run with a coded error.
test("a Council run whose provider fails answers a coded error, not a 0 USD no-recommendation", async (t) => {
  for (const [upstreamStatus, upstreamCode, expectedStatus, expectedCode] of [
    [401, "auth_rejected", 502, "provider_auth_failed"],
    [504, "provider_timeout", 504, "provider_timeout"],
  ]) {
    const providerCalls = [];
    const harness = await startHarness(t, {
      conveneCouncil: (args) => convene({
        ...args,
        contextOverride: "Student context for the test.",
        callModel: async (request) => {
          providerCalls.push(request.model);
          throw Object.assign(new Error("mock upstream " + upstreamStatus), { status: upstreamStatus, code: upstreamCode, provider: "openrouter" });
        },
      }),
    });
    const response = await postCouncil(harness, explicitRequest());
    assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
    assert.equal(response.body.code, expectedCode);
    assert.equal(response.body.councilCode, "COUNCIL_PROVIDER_UNAVAILABLE");
    assert.equal(response.body.stage, "Strategist");
    assert.notEqual(response.status, 401, "an upstream 401 is never our own");
    assert.equal(providerCalls.length, 1, "no further seats or tries into the same outage");
    assert.equal(harness.calls.release.length, 1, "the reserved stages are released");
  }
});

test("a Strategist whose reply cannot be parsed still yields the moderator's answer, without blaming the context", async (t) => {
  let calls = 0;
  const harness = await startHarness(t, {
    conveneCouncil: (args) => convene({
      ...args,
      contextOverride: "Student context for the test.",
      callModel: async () => {
        calls += 1;
        return { content: [{ type: "text", text: "not json at all" }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    }),
  });
  const response = await postCouncil(harness, explicitRequest());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.moderator_rule, "no_primary_recommendation");
  assert.doesNotMatch(response.body.recommendation, /available context/);
  // Every seat tried twice; each try's usage is reported, not dropped.
  assert.equal(calls, 8);
  const strategist = response.body.council_breakdown.find((seat) => seat.role === "Strategist");
  assert.equal(strategist.abstained, true);
});

// The client's Cancel and its five-minute deadline abort the request; the
// route ties its own signal to the response closing, so the run stops and
// its reserved stages are released instead of four seats billing a review
// nobody reads.
test("a Council request the client abandons stops the run and releases the budget", async (t) => {
  let seen = null;
  const harness = await startHarness(t, {
    conveneCouncil: (args) => new Promise((_, reject) => {
      seen = args.signal;
      args.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("The client closed the Council request."), { code: "aborted", provider: "openrouter", status: 499 }));
      }, { once: true });
    }),
  });
  const client = new AbortController();
  const pending = fetch(harness.url + "/api/council/convene", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify(explicitRequest()),
    signal: client.signal,
  }).then(() => "answered", (error) => error?.name || "error");
  for (let i = 0; i < 100 && !seen; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(seen, "the run started with the route's signal");
  assert.equal(seen.aborted, false);
  client.abort();
  assert.equal(await pending, "AbortError");
  for (let i = 0; i < 100 && harness.calls.release.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen.aborted, true, "the client's abort reached the run");
  assert.equal(harness.calls.release.length, 1, "the reserved stages are released");
});
