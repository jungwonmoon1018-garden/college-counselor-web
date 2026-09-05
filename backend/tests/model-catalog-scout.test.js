import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  classifyModelCandidate,
  initModelCatalogScout,
  prepareModelCatalogStatements,
  runModelCatalogScout,
  listDynamicModelOptions,
  dynamicAllowedModelIds,
  setModelCandidateStatus,
  lastModelCatalogRun,
} from "../model-catalog-scout.js";
import { registerDynamicOpenRouterModels, isAllowedOpenRouterModel, listKnownModels } from "../llm-adapters/index.js";

const model = (id, { input = 0.2, output = 0.6, context = 128_000, free = false, modalities = { input: ["text"], output: ["text"] }, createdAt = "2026-08-01T00:00:00.000Z" } = {}) => ({
  id, name: id.split("/")[1] || id, contextLength: context, pricing: { inputPerMTok: input, outputPerMTok: output }, free, modalities, createdAt,
});

test("candidates are trusted, text-in/text-out, priced chat models sorted into price bands", () => {
  assert.deepEqual(classifyModelCandidate(model("google/gemma-5-27b-it", { input: 0.1, output: 0.3 })).tier, "small");
  assert.equal(classifyModelCandidate(model("deepseek/deepseek-v5-flash", { input: 0.5, output: 2 })).tier, "medium");
  assert.equal(classifyModelCandidate(model("openai/gpt-6", { input: 5, output: 15 })).tier, "large");
  const untrusted = classifyModelCandidate(model("unknownlab/chat-9b"));
  assert.equal(untrusted.eligible, false);
  assert.ok(untrusted.reasons.includes("provider_not_trusted"));
  for (const id of ["openai/gpt-6:free", "google/gemini-4-preview", "openai/gpt-6-realtime", "openai/text-embedding-4", "meta-llama/llama-5-70b-base", "anthropic/claude-6:thinking"]) {
    assert.equal(classifyModelCandidate(model(id)).eligible, false, id);
  }
  assert.ok(classifyModelCandidate(model("openai/gpt-6", { context: 8_000 })).reasons.includes("context_too_small"));
  assert.ok(classifyModelCandidate(model("openai/gpt-6", { modalities: { input: ["image"], output: ["image"] } })).reasons.includes("no_text_output"));
  assert.ok(classifyModelCandidate(model("openai/gpt-6", { input: null, output: null })).reasons.includes("no_pricing"));
  // Unknown modalities (older catalog rows) are not held against a model.
  assert.equal(classifyModelCandidate(model("openai/gpt-6", { modalities: { input: [], output: [] } })).eligible, true);
});

test("a run lists new eligible models, keeps dismissals, skips packaged ids, and feeds the allowlist", () => {
  const db = new Database(":memory:");
  initModelCatalogScout(db);
  const stmts = prepareModelCatalogStatements(db);
  const catalog = {
    reachable: true,
    models: [
      model("google/gemma-5-27b-it", { input: 0.1, output: 0.3 }),
      model("deepseek/deepseek-v5-flash", { input: 0.5, output: 2 }),
      model("openai/gpt-6", { input: 5, output: 15 }),
      model("openai/gpt-6:free", { free: true }),
      model("unknownlab/chat-9b"),
      model("google/gemma-4-26b-a4b-it", { input: 0.1, output: 0.2 }), // packaged already
    ],
  };
  catalog.byId = new Map(catalog.models.map((m) => [m.id, m]));
  const known = new Set(["google/gemma-4-26b-a4b-it"]);

  const first = runModelCatalogScout({ catalog, stmts, knownIds: known, trigger: "boot", now: new Date("2026-09-04T00:00:00Z") });
  assert.equal(first.eligible, 3);
  assert.deepEqual(first.added.map((a) => `${a.id}:${a.tier}`), ["google/gemma-5-27b-it:small", "deepseek/deepseek-v5-flash:medium", "openai/gpt-6:large"]);
  assert.equal(first.rejected.free_tier, 1);
  assert.equal(first.rejected.provider_not_trusted, 1);

  // Counselor dismisses one; the next run keeps it dismissed and adds nothing new.
  setModelCandidateStatus(stmts, "openai/gpt-6", "dismissed");
  const second = runModelCatalogScout({ catalog, stmts, knownIds: known, trigger: "scheduled", now: new Date("2026-09-05T00:00:00Z") });
  assert.equal(second.added.length, 0);
  assert.equal(second.kept, 3);
  assert.deepEqual(dynamicAllowedModelIds(stmts).sort(), ["deepseek/deepseek-v5-flash", "google/gemma-5-27b-it"]);
  const options = listDynamicModelOptions(stmts, { catalog });
  assert.equal(options.length, 2);
  assert.equal(options[0].discovered, true);
  assert.equal(options[0].available, true);
  assert.equal(options.find((o) => o.id === "google/gemma-5-27b-it").firstSeen, "2026-09-04T00:00:00.000Z");
  assert.equal(listDynamicModelOptions(stmts, { catalog, includeDismissed: true }).length, 3);
  const run = lastModelCatalogRun(stmts);
  assert.equal(run.trigger, "scheduled");
  assert.equal(run.eligible, 3);
  assert.throws(() => setModelCandidateStatus(stmts, "openai/gpt-6", "banned"));
  assert.equal(setModelCandidateStatus(stmts, "nobody/nothing", "listed"), null);

  // The adapter allowlist accepts listed discoveries and nothing else new.
  registerDynamicOpenRouterModels(dynamicAllowedModelIds(stmts));
  assert.equal(isAllowedOpenRouterModel("deepseek/deepseek-v5-flash"), true);
  assert.equal(isAllowedOpenRouterModel("openai/gpt-6"), false);
  assert.ok(listKnownModels("openrouter").includes("google/gemma-5-27b-it"));
  registerDynamicOpenRouterModels([]);
  assert.equal(isAllowedOpenRouterModel("deepseek/deepseek-v5-flash"), false);
});
