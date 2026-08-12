// Packaged OpenRouter model registry. Changes are reviewed and released with
// the application instead of being accepted from a client at runtime.
export const TIER_DEFAULTS = Object.freeze({
  openrouter: Object.freeze({
    small: 'google/gemma-4-26b-a4b-it',
    medium: 'deepseek/deepseek-v4-flash-0731',
    large: 'openai/gpt-5.6-luna',
  }),
});

// Curated against OpenRouter's public model pages on 2026-08-11. The live
// catalog refresh can update availability and pricing, while this reviewed
// list controls which model IDs may be persisted by a counselor.
export const OPENROUTER_MODEL_OPTIONS = Object.freeze([
  Object.freeze({ id: 'google/gemma-4-26b-a4b-it', label: 'Google Gemma 4 26B A4B', source: 'https://openrouter.ai/google/gemma-4-26b-a4b-it' }),
  Object.freeze({ id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731', source: 'https://openrouter.ai/deepseek/deepseek-v4-flash-0731' }),
  Object.freeze({ id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', source: 'https://openrouter.ai/deepseek/deepseek-v4-pro' }),
  Object.freeze({ id: 'openai/gpt-5.6-luna', label: 'OpenAI GPT-5.6 Luna', source: 'https://openrouter.ai/openai/gpt-5.6-luna' }),
  Object.freeze({ id: 'openai/gpt-5.6-terra', label: 'OpenAI GPT-5.6 Terra', source: 'https://openrouter.ai/openai/gpt-5.6-terra' }),
  Object.freeze({ id: 'openai/gpt-5.6-sol', label: 'OpenAI GPT-5.6 Sol', source: 'https://openrouter.ai/openai/gpt-5.6-sol' }),
  Object.freeze({ id: 'anthropic/claude-sonnet-5', label: 'Anthropic Claude Sonnet 5', source: 'https://openrouter.ai/anthropic/claude-sonnet-5' }),
  Object.freeze({ id: 'google/gemini-3.6-flash', label: 'Google Gemini 3.6 Flash', source: 'https://openrouter.ai/google/gemini-3.6-flash' }),
  Object.freeze({ id: 'google/gemini-3.5-flash-lite', label: 'Google Gemini 3.5 Flash Lite', source: 'https://openrouter.ai/google/gemini-3.5-flash-lite' }),
]);

// Existing installations may still have one of these historical selections.
// Keep them request-compatible without showing them in the counselor picker.
const LEGACY_OPENROUTER_MODEL_IDS = Object.freeze([
  'deepseek/deepseek-v4-flash',
  'google/gemma-4-31b-it',
  'z-ai/glm-5.1',
  'z-ai/glm-4.6',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-2.5-pro',
  'deepseek/deepseek-chat',
  'meta-llama/llama-3.3-70b-instruct',
  'qwen/qwen-2.5-72b-instruct',
]);

export const PROVIDER_META = Object.freeze([
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    keyPrefix: 'sk-or-',
    baseUrlOptional: false,
    baseUrl: 'https://openrouter.ai/api/v1',
    knownModels: Object.freeze([
      ...OPENROUTER_MODEL_OPTIONS.map(({ id }) => id),
      ...LEGACY_OPENROUTER_MODEL_IDS,
    ]),
  }),
]);

// Compatibility metadata for the one remaining wire protocol.
export const PROVIDER_WIRE_PROTOCOL = Object.freeze({ openrouter: 'openai' });

const REASONING_MODEL_PATTERNS = [
  /^deepseek\/deepseek-r1/i,
  /^deepseek\/deepseek-v4-(?:pro|flash)/i,
  /^openai\/gpt-5\.[4-9]/i,
  /^anthropic\/claude-(?:sonnet|opus)-5/i,
  /^openai\/o1/i,
  /^openai\/o3/i,
  /^z-ai\/glm-.*-reasoning/i,
];

export function isReasoningModel(modelId) {
  return typeof modelId === 'string'
    && REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

export function resolveTierDefault(providerId, tier) {
  if (providerId !== 'openrouter') return null;
  return TIER_DEFAULTS.openrouter[tier] || null;
}
