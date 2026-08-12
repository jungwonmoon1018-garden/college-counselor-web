import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrchestration } from '../orchestration-engine.js';
import { TIER_DEFAULTS } from '../llm-adapters/index.js';

test('orchestration ignores runtime model overrides and selects OpenRouter', () => {
  const result = buildOrchestration({
    query: 'How can I improve my extracurricular profile?',
    studentContext: {},
    catalog: {},
    config: {
      LLM_SMALL_MODEL: 'attacker/small',
      LLM_MEDIUM_MODEL: 'attacker/medium',
      LLM_LARGE_MODEL: 'attacker/large',
    },
  });
  assert.equal(result.executionPlan.requiresModel, true);
  assert.equal(result.executionPlan.provider, 'openrouter');
  assert.equal(result.executionPlan.model, TIER_DEFAULTS.openrouter.medium);
});

test('orchestration applies counselor-configured workload tiers', () => {
  const result = buildOrchestration({
    query: 'How can I improve my extracurricular profile?',
    studentContext: {},
    catalog: {},
    modelConfig: {
      small: 'google/gemma-4-26b-a4b-it',
      medium: 'openai/gpt-5.6-terra',
      large: 'openai/gpt-5.6-luna',
    },
  });
  assert.equal(result.executionPlan.tier, 'sonnet');
  assert.equal(result.executionPlan.model, 'openai/gpt-5.6-terra');
});
