import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENROUTER_MODEL_OPTIONS,
  TIER_DEFAULTS,
} from "../llm-adapters/tier-defaults.js";

test("reviewed OpenRouter choices contain every counselor tier default", () => {
  const ids = new Set(OPENROUTER_MODEL_OPTIONS.map(({ id }) => id));
  assert.equal(OPENROUTER_MODEL_OPTIONS.length, 9);
  for (const tier of ["small", "medium", "large"]) {
    assert.equal(ids.has(TIER_DEFAULTS.openrouter[tier]), true, `${tier} default must be selectable`);
  }
});

test("reviewed OpenRouter choices have unique ids and first-party catalog links", () => {
  const ids = OPENROUTER_MODEL_OPTIONS.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.includes("google/gemma-4-26b-a4b-it"), true);
  for (const option of OPENROUTER_MODEL_OPTIONS) {
    assert.match(option.id, /^[a-z0-9-]+\/[a-z0-9._-]+$/i);
    assert.match(option.source, /^https:\/\/openrouter\.ai\//);
  }
});
