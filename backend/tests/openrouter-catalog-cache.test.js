import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENROUTER_CATALOG,
  configureOpenRouterCatalogCache,
  ensureOpenRouterCatalog,
  getOpenRouterPricingUSDPerMTok,
  loadOpenRouterCatalogCache,
  refreshOpenRouterCatalog,
} from "../openrouter-model-refresh.js";

const catalogResponse = (ids) => async () => ({
  ok: true,
  json: async () => ({ data: ids.map((id) => ({ id, name: id, context_length: 32768, pricing: { prompt: "0.000001", completion: "0.000002" } })) }),
});
const failing = async () => { throw new Error("connect ETIMEDOUT"); };

function resetCatalog() {
  OPENROUTER_CATALOG.models = [];
  OPENROUTER_CATALOG.byId = new Map();
  OPENROUTER_CATALOG.reachable = null;
  OPENROUTER_CATALOG.lastFetched = null;
  OPENROUTER_CATALOG.fromCache = null;
}

test("a failed refresh with nothing in memory serves the last-known catalog from disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "or-catalog-"));
  const cachePath = path.join(dir, "nested", "openrouter-catalog.json");
  configureOpenRouterCatalogCache(cachePath);
  resetCatalog();

  // A good refresh writes the cache and prices the model.
  await refreshOpenRouterCatalog({ fetchImpl: catalogResponse(["deepseek/deepseek-v4-flash-0731"]) });
  assert.equal(OPENROUTER_CATALOG.reachable, true);
  assert.deepEqual(getOpenRouterPricingUSDPerMTok("deepseek/deepseek-v4-flash-0731"), { input: 1, output: 2 });
  assert.equal(loadOpenRouterCatalogCache().models.length, 1);

  // A bad boot: nothing in memory, OpenRouter unreachable → the cache stands
  // in, marked unreachable, and the price lookup still works.
  resetCatalog();
  await refreshOpenRouterCatalog({ fetchImpl: failing });
  assert.equal(OPENROUTER_CATALOG.reachable, false);
  assert.equal(OPENROUTER_CATALOG.models.length, 1);
  assert.ok(OPENROUTER_CATALOG.fromCache);
  assert.deepEqual(getOpenRouterPricingUSDPerMTok("deepseek/deepseek-v4-flash-0731"), { input: 1, output: 2 });

  // An empty response is a failure too, not a wipe of the last-known list.
  await refreshOpenRouterCatalog({ fetchImpl: catalogResponse([]) });
  assert.equal(OPENROUTER_CATALOG.models.length, 1);

  // A later good refresh replaces the cached list.
  await refreshOpenRouterCatalog({ fetchImpl: catalogResponse(["a/one", "b/two"]) });
  assert.equal(OPENROUTER_CATALOG.reachable, true);
  assert.equal(OPENROUTER_CATALOG.models.length, 2);
  assert.equal(OPENROUTER_CATALOG.fromCache, null);

  configureOpenRouterCatalogCache(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensureOpenRouterCatalog refreshes only when the catalog is empty, at most once a minute", async () => {
  configureOpenRouterCatalogCache(null);
  resetCatalog();
  let calls = 0;
  const counting = async (...args) => { calls++; return catalogResponse(["a/one"])(...args); };
  await ensureOpenRouterCatalog({ fetchImpl: counting });
  assert.equal(calls, 1);
  assert.equal(OPENROUTER_CATALOG.models.length, 1);
  await ensureOpenRouterCatalog({ fetchImpl: counting });
  assert.equal(calls, 1, "a populated catalog is not refreshed on the request path");

  resetCatalog();
  await ensureOpenRouterCatalog({ fetchImpl: counting });
  assert.equal(calls, 1, "a second empty-catalog attempt inside the interval is skipped");
  await ensureOpenRouterCatalog({ fetchImpl: counting, minIntervalMs: 0 });
  assert.equal(calls, 2);
});
