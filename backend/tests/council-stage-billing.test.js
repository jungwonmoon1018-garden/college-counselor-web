// backend-3: a Strategist try that was billed but could not be parsed,
// followed by a provider failure (a 401, a 5xx during an outage) or the
// student closing the request on the retry, stopped the Council before the
// stage was reconciled. The route then released the stage, so a call the
// operator paid for counted 0 USD against the student's monthly cap: the
// under-billing sumUsage in councilor.js was added to stop. The stage is now
// reconciled at the usage of the tries that were billed before the run
// stops; a stage with no billed try reconciles at null usage, which records
// 0 USD as a release would.
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { convene, initCouncilTables, prepareCouncilStatements } from "../council/index.js";

const context = { text: "[baseline_fact:fact-1] Robotics leadership.", evidenceIndex: {} };
const BILLED = { input_tokens: 8000, output_tokens: 8192 };

function providerError(status, code) {
  return Object.assign(new Error(`provider ${status}`), { status, code });
}

function run({ calls, signal = undefined }) {
  const db = new Database(":memory:");
  initCouncilTables(db);
  const reconciled = [];
  let call = 0;
  const promise = convene({
    studentId: "student-billing",
    question: "Should I apply early?",
    explicit: true,
    student: {},
    contextOverride: context,
    councilStmts: prepareCouncilStatements(db),
    llm: { provider: "openrouter", apiKey: "sk-or-test" },
    signal,
    beforeStage: () => ({ allowed: true }),
    afterStage: ({ index, output }) => { reconciled.push({ index, usage: output?.usage ?? null }); },
    callModel: async (args) => calls[call++](args),
  });
  return { promise, reconciled, calls: () => call, close: () => db.close() };
}

for (const [label, failure] of [["a rejected key", providerError(401, "auth_rejected")], ["a 503 during an outage", providerError(503, "http_error")]]) {
  test(`a billed unparseable Strategist try is reconciled when the retry meets ${label}`, async () => {
    const council = run({
      calls: [
        async () => ({ content: [{ type: "text", text: "not json at all" }], usage: BILLED }),
        async () => { throw failure; },
      ],
    });
    try {
      await assert.rejects(council.promise, (error) => error.councilCode === "COUNCIL_PROVIDER_UNAVAILABLE");
      assert.equal(council.calls(), 2);
      assert.deepEqual(council.reconciled, [{ index: 0, usage: BILLED }]);
    } finally {
      council.close();
    }
  });
}

test("a Strategist that never got an answer reconciles at no usage, the same as a release", async () => {
  const council = run({ calls: [async () => { throw providerError(401, "auth_rejected"); }] });
  try {
    await assert.rejects(council.promise, (error) => error.councilCode === "COUNCIL_PROVIDER_UNAVAILABLE");
    assert.deepEqual(council.reconciled, [{ index: 0, usage: null }]);
  } finally {
    council.close();
  }
});

test("a billed unparseable try is reconciled when the student closes the request on the retry", async () => {
  const abort = new AbortController();
  const closed = Object.assign(new Error("The client closed the Council request."), { name: "AbortError" });
  const council = run({
    signal: abort.signal,
    calls: [
      async () => ({ content: [{ type: "text", text: "not json at all" }], usage: BILLED }),
      async () => { abort.abort(closed); throw closed; },
    ],
  });
  try {
    await assert.rejects(council.promise, (error) => error === closed);
    assert.deepEqual(council.reconciled, [{ index: 0, usage: BILLED }]);
  } finally {
    council.close();
  }
});
