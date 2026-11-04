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
  modelTierStatus,
  tierStatusProblems,
  MODEL_SCOUT_VERSION,
} from "../scouts/model-catalog-scout.js";
import { scoutRunDue } from "../scouts/scout-cadence.js";
import { registerDynamicOpenRouterModels, isAllowedOpenRouterModel, listKnownModels } from "../llm-adapters/index.js";

const model = (id, { input = 0.2, output = 0.6, context = 128_000, free = false, modalities = { input: ["text"], output: ["text"] }, createdAt = "2026-08-01T00:00:00.000Z" } = {}) => ({
  id, name: id.split("/")[1] || id, contextLength: context, pricing: { inputPerMTok: input, outputPerMTok: output }, free, modalities, createdAt,
});

const NOW = new Date("2026-09-04T00:00:00Z");

test("candidates are trusted, recent, text-in/text-out, priced chat models sorted into price bands", () => {
  assert.deepEqual(classifyModelCandidate(model("google/gemma-5-27b-it", { input: 0.1, output: 0.3 }), NOW).tier, "small");
  assert.equal(classifyModelCandidate(model("deepseek/deepseek-v5-flash", { input: 0.5, output: 2 }), NOW).tier, "medium");
  assert.equal(classifyModelCandidate(model("openai/gpt-6", { input: 5, output: 15 }), NOW).tier, "large");
  const untrusted = classifyModelCandidate(model("unknownlab/chat-9b"), NOW);
  assert.equal(untrusted.eligible, false);
  assert.ok(untrusted.reasons.includes("provider_not_trusted"));
  // Routing variants (:free, :batch, :thinking…), unstable channels, and
  // non-chat models never qualify.
  for (const id of ["openai/gpt-6:free", "openai/gpt-6:batch", "google/gemini-4-preview", "openai/gpt-6-realtime", "openai/text-embedding-4", "meta-llama/llama-5-70b-base", "anthropic/claude-6:thinking", "nvidia/nemotron-3.5-content-safety"]) {
    assert.equal(classifyModelCandidate(model(id), NOW).eligible, false, id);
  }
  assert.ok(classifyModelCandidate(model("openai/gpt-6", { context: 8_000 }), NOW).reasons.includes("context_too_small"));
  assert.ok(classifyModelCandidate(model("openai/gpt-6", { modalities: { input: ["image"], output: ["image"] } }), NOW).reasons.includes("no_text_output"));
  assert.ok(classifyModelCandidate(model("openai/gpt-6", { input: null, output: null }), NOW).reasons.includes("no_pricing"));
  // Only models that appeared within the last year count as additions.
  assert.ok(classifyModelCandidate(model("openai/gpt-6", { createdAt: "2024-01-01T00:00:00.000Z" }), NOW).reasons.includes("older_than_a_year"));
  assert.ok(classifyModelCandidate(model("openai/gpt-6", { createdAt: null }), NOW).reasons.includes("no_creation_date"));
  // Unknown modalities (older catalog rows) are not held against a model.
  assert.equal(classifyModelCandidate(model("openai/gpt-6", { modalities: { input: [], output: [] } }), NOW).eligible, true);
});

test("the picker shows the newest candidates per tier, while every listed one stays allowed", () => {
  const db = new Database(":memory:");
  initModelCatalogScout(db);
  const stmts = prepareModelCatalogStatements(db);
  const models = Array.from({ length: 20 }, (_, i) => model(`openai/gpt-6-mini-${i}`, { input: 0.1, output: 0.3, createdAt: `2026-0${1 + (i % 8)}-0${1 + (i % 9)}T00:00:00.000Z` }));
  const catalog = { models, byId: new Map(models.map((m) => [m.id, m])), reachable: true };
  runModelCatalogScout({ catalog, stmts, trigger: "boot", now: NOW });
  const shown = listDynamicModelOptions(stmts, { catalog, perTierLimit: 5 });
  assert.equal(shown.length, 5);
  assert.ok(shown.every((o) => o.tier === "small"));
  assert.equal(shown[0].createdAt >= shown[4].createdAt, true, "newest first");
  assert.equal(dynamicAllowedModelIds(stmts).length, 20);
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

test("rows a run no longer confirms leave the picker; dismissals survive; an empty catalog prunes nothing", () => {
  const db = new Database(":memory:");
  initModelCatalogScout(db);
  const stmts = prepareModelCatalogStatements(db);
  const gone = model("openai/gpt-6-nano", { input: 0.1, output: 0.3 });
  const kept = model("google/gemini-4-flash", { input: 0.3, output: 1.2 });
  const dismissedLater = model("qwen/qwen4-flash", { input: 0.1, output: 0.3 });
  const first = runModelCatalogScout({ catalog: { models: [gone, kept, dismissedLater], byId: new Map(), reachable: true }, stmts, trigger: "boot", now: NOW });
  assert.equal(first.added.length, 3);
  assert.equal(first.pruned, 0);
  setModelCandidateStatus(stmts, "qwen/qwen4-flash", "dismissed");

  // Next check: "gone" fell out of the catalog, a newcomer appears.
  const newcomer = model("deepseek/deepseek-v5-flash", { input: 0.2, output: 0.8 });
  const second = runModelCatalogScout({ catalog: { models: [kept, dismissedLater, newcomer], byId: new Map(), reachable: true }, stmts, trigger: "scheduled", now: new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000) });
  assert.equal(second.pruned, 1);
  assert.deepEqual(second.added.map((a) => a.id), ["deepseek/deepseek-v5-flash"]);
  const ids = listDynamicModelOptions(stmts, { includeDismissed: true }).map((o) => [o.id, o.status]).sort();
  assert.deepEqual(ids, [["deepseek/deepseek-v5-flash", "listed"], ["google/gemini-4-flash", "listed"], ["qwen/qwen4-flash", "dismissed"]]);

  // A row an earlier, looser rule set let in (a ":batch" variant) drops out
  // the same way: the rules no longer confirm it, so it is not upserted.
  stmts.upsert.run("openai/gpt-6:batch", "openai", "gpt-6 batch", "large", 1, 3, 200000, "2026-08-01T00:00:00.000Z", "2026-08-15T00:00:00.000Z", "2026-08-15T00:00:00.000Z");
  assert.ok(dynamicAllowedModelIds(stmts).includes("openai/gpt-6:batch"));
  const third = runModelCatalogScout({ catalog: { models: [kept, dismissedLater, newcomer, model("openai/gpt-6:batch")], byId: new Map(), reachable: true }, stmts, trigger: "scheduled", now: new Date(NOW.getTime() + 28 * 24 * 60 * 60 * 1000) });
  assert.equal(third.pruned, 1);
  assert.ok(!dynamicAllowedModelIds(stmts).includes("openai/gpt-6:batch"));

  // OpenRouter unreachable → empty catalog → nothing is removed.
  const offline = runModelCatalogScout({ catalog: { models: [], byId: new Map(), reachable: false }, stmts, trigger: "scheduled", now: new Date(NOW.getTime() + 42 * 24 * 60 * 60 * 1000) });
  assert.equal(offline.pruned, 0);
  assert.equal(dynamicAllowedModelIds(stmts).length, 2);
  db.close();
});

test("runs record the rule version; rows from before versioning read back as version 1", () => {
  const db = new Database(":memory:");
  initModelCatalogScout(db);
  const stmts = prepareModelCatalogStatements(db);
  stmts.insertRun.run("old-run", "2026-09-01T00:00:00.000Z", "boot", JSON.stringify({ added: [] }));
  stmts.finishRun.run("2026-09-01T00:00:05.000Z", 250, 254, 254, JSON.stringify({ added: [] }), "old-run");
  assert.equal(lastModelCatalogRun(stmts).scoutVersion, 1);
  runModelCatalogScout({ catalog: { models: [model("openai/gpt-6-nano")], byId: new Map(), reachable: true }, stmts, trigger: "boot", now: new Date("2026-09-05T00:00:00Z") });
  const latest = lastModelCatalogRun(stmts);
  assert.equal(latest.scoutVersion, MODEL_SCOUT_VERSION);
  assert.equal(latest.pruned, 0);
  db.close();
});

// A model the counselor picked when it was new turned one year old while
// OpenRouter still served it; the next run pruned its row, the allowlist
// dropped it, and every call on that tier failed with model_not_allowed.
test("a model a tier uses is never aged out or pruned while the live catalog lists it", () => {
  const db = new Database(":memory:");
  initModelCatalogScout(db);
  const stmts = prepareModelCatalogStatements(db);
  const picked = model("google/gemini-4-flash", { input: 0.3, output: 1.2, createdAt: "2026-11-10T00:00:00.000Z" });
  const other = model("qwen/qwen4-flash", { input: 0.1, output: 0.3, createdAt: "2026-11-10T00:00:00.000Z" });
  const catalog = { models: [picked, other], byId: new Map(), reachable: true };
  runModelCatalogScout({ catalog, stmts, trigger: "boot", now: new Date("2026-11-20T00:00:00Z") });
  assert.deepEqual(dynamicAllowedModelIds(stmts).sort(), ["google/gemini-4-flash", "qwen/qwen4-flash"]);

  // A year and two weeks later both are past the age cap. The one a tier
  // uses stays listed and allowed; the unused one is pruned as before.
  const later = new Date("2027-11-24T00:00:00Z");
  const run = runModelCatalogScout({ catalog, stmts, inUseIds: ["google/gemini-4-flash", "deepseek/deepseek-v4-flash-0731"], trigger: "scheduled", now: later });
  assert.equal(run.pruned, 1);
  assert.deepEqual(dynamicAllowedModelIds(stmts), ["google/gemini-4-flash"]);
  assert.deepEqual(run.inUseKept, [{ id: "google/gemini-4-flash", reasons: ["older_than_a_year"] }]);
  assert.equal(stmts.get.get("google/gemini-4-flash").last_seen, later.toISOString(), "the row is refreshed from the live catalog");
  registerDynamicOpenRouterModels(dynamicAllowedModelIds(stmts));
  assert.equal(isAllowedOpenRouterModel("google/gemini-4-flash"), true);
  assert.equal(isAllowedOpenRouterModel("qwen/qwen4-flash"), false);
  registerDynamicOpenRouterModels([]);

  // Without inUseIds the age cap applies to it like any other row.
  const dayAfter = new Date(later.getTime() + 24 * 60 * 60 * 1000);
  const unused = runModelCatalogScout({ catalog, stmts, trigger: "scheduled", now: dayAfter });
  assert.equal(unused.pruned, 1);
  assert.deepEqual(dynamicAllowedModelIds(stmts), []);

  // A pick the age cap already pruned comes back while a tier uses it.
  const recovered = runModelCatalogScout({ catalog, stmts, inUseIds: ["google/gemini-4-flash"], trigger: "scheduled", now: dayAfter });
  assert.deepEqual(recovered.added.map((a) => a.id), ["google/gemini-4-flash"]);
  assert.deepEqual(dynamicAllowedModelIds(stmts), ["google/gemini-4-flash"]);
  db.close();
});

test("a model a tier uses that OpenRouter stopped listing is kept and reported, not silently dropped", () => {
  const db = new Database(":memory:");
  initModelCatalogScout(db);
  const stmts = prepareModelCatalogStatements(db);
  const picked = model("google/gemini-4-flash", { input: 0.3, output: 1.2 });
  const stays = model("qwen/qwen4-flash", { input: 0.1, output: 0.3 });
  runModelCatalogScout({ catalog: { models: [picked, stays], byId: new Map(), reachable: true }, stmts, trigger: "boot", now: NOW });
  const run = runModelCatalogScout({ catalog: { models: [stays], byId: new Map(), reachable: true }, stmts, inUseIds: ["google/gemini-4-flash"], trigger: "scheduled", now: new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000) });
  assert.equal(run.pruned, 0);
  assert.deepEqual(run.inUseKept, [{ id: "google/gemini-4-flash", reasons: ["not_in_catalog"] }]);
  assert.ok(dynamicAllowedModelIds(stmts).includes("google/gemini-4-flash"));
  assert.deepEqual(lastModelCatalogRun(stmts).inUseKept, run.inUseKept);
  // The same row unused is pruned.
  const unused = runModelCatalogScout({ catalog: { models: [stays], byId: new Map(), reachable: true }, stmts, trigger: "scheduled", now: new Date(NOW.getTime() + 28 * 24 * 60 * 60 * 1000) });
  assert.equal(unused.pruned, 1);
  db.close();
});

test("a check with no live catalog is recorded as failed and retried within the hour, not a fortnight later", () => {
  const db = new Database(":memory:");
  initModelCatalogScout(db);
  const stmts = prepareModelCatalogStatements(db);
  const cadenceMs = 14 * 24 * 60 * 60 * 1000;
  const good = runModelCatalogScout({ catalog: { models: [model("qwen/qwen4-flash")], byId: new Map(), reachable: true }, stmts, trigger: "boot", now: NOW });
  assert.equal(good.outcome, "completed");
  assert.equal(lastModelCatalogRun(stmts).outcome, "completed");

  const empty = runModelCatalogScout({ catalog: { models: [], byId: new Map(), reachable: false }, stmts, trigger: "scheduled", now: new Date(NOW.getTime() + cadenceMs) });
  assert.equal(empty.outcome, "failed");
  const last = lastModelCatalogRun(stmts);
  assert.equal(last.outcome, "failed");
  assert.equal(last.failedStreak, 1);
  const finished = Date.parse(last.finishedAt);
  assert.equal(scoutRunDue({ lastRun: last, cadenceMs, now: finished + 30 * 60 * 1000 }).due, false);
  assert.equal(scoutRunDue({ lastRun: last, cadenceMs, now: finished + 61 * 60 * 1000 }).reason, "previous_run_failed");

  // A last-known catalog from the disk (OpenRouter unreachable) still feeds
  // the picker but does not count as the check: the streak grows.
  const cached = runModelCatalogScout({ catalog: { models: [model("qwen/qwen4-flash")], byId: new Map(), reachable: false }, stmts, trigger: "scheduled", now: new Date(NOW.getTime() + cadenceMs + 3600_000) });
  assert.equal(cached.outcome, "failed");
  assert.equal(lastModelCatalogRun(stmts).failedStreak, 2);
  db.close();
});

test("each tier's status says why a call on it would be refused", () => {
  const live = model("google/gemini-4-flash", { input: 0.3, output: 1.2 });
  const catalog = { byId: new Map([[live.id, live], ["deepseek/deepseek-v4-flash-0731", model("deepseek/deepseek-v4-flash-0731")], ["openai/gpt-5.6-luna", model("openai/gpt-5.6-luna")]]) };
  const allowed = new Set(["google/gemini-4-flash", "deepseek/deepseek-v4-flash-0731"]);
  const priced = new Set(["google/gemini-4-flash"]);
  const status = modelTierStatus({
    targets: { small: "google/gemini-4-flash", medium: "deepseek/deepseek-v4-flash-0731", large: "openai/gpt-5.6-luna" },
    catalog,
    isAllowed: (id) => allowed.has(id),
    pricingLookup: (id) => (priced.has(id) ? { input: 1, output: 1 } : null),
  });
  assert.deepEqual(status, {
    small: { model: "google/gemini-4-flash", status: "ok" },
    medium: { model: "deepseek/deepseek-v4-flash-0731", status: "no_price" },
    large: { model: "openai/gpt-5.6-luna", status: "not_in_allowlist" },
  });
  const retired = modelTierStatus({ targets: { small: "google/gone-model", medium: "google/gemini-4-flash", large: "google/gemini-4-flash" }, catalog, isAllowed: () => true, pricingLookup: () => ({}) });
  assert.equal(retired.small.status, "not_in_catalog");
  assert.deepEqual(tierStatusProblems(retired), [{ tier: "small", model: "google/gone-model", status: "not_in_catalog" }]);
  // Before the catalog has loaded nothing is "not in the catalog".
  assert.equal(modelTierStatus({ targets: { small: "google/gone-model" }, catalog: { byId: new Map() }, isAllowed: () => true, pricingLookup: () => ({}) }).small.status, "ok");
});
