// Estimated pricing per 1M tokens (USD)
// These are approximate — UI should label as "Est. Cost"
const PRICING = {
  'openai:gpt-5-nano':                    { inputPer1M: 0.10,  outputPer1M: 0.40 },
  'openai:gpt-5-mini':                    { inputPer1M: 0.15,  outputPer1M: 0.60 },
  'openai:gpt-5.2':                       { inputPer1M: 2.50,  outputPer1M: 10.00 },
  'anthropic:claude-haiku-4-5-20251001':   { inputPer1M: 0.80,  outputPer1M: 4.00 },
  'anthropic:claude-sonnet-4-5-20250929':  { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'anthropic:claude-opus-4-5-20251101':    { inputPer1M: 15.00, outputPer1M: 75.00 },
  'gemini:gemini-2.5-flash-lite':           { inputPer1M: 0.075, outputPer1M: 0.30 },
  'gemini:gemini-3-flash-preview':         { inputPer1M: 0.075, outputPer1M: 0.30 },
  'gemini:gemini-3-pro-preview':           { inputPer1M: 1.25,  outputPer1M: 5.00 },
  'kimi:kimi-k2.5':                        { inputPer1M: 0.00,  outputPer1M: 0.00 },
  'openai:text-embedding-3-small':         { inputPer1M: 0.02,  outputPer1M: 0.00 },
};

/**
 * Compute estimated cost in cents.
 * Returns 0 for unknown provider:model combos.
 */
export function computeCostCents(provider, model, promptTokens, completionTokens) {
  const key = `${provider}:${model}`;
  const price = PRICING[key];
  if (!price) return 0;
  const inputCost = (promptTokens / 1_000_000) * price.inputPer1M;
  const outputCost = (completionTokens / 1_000_000) * price.outputPer1M;
  return Math.round((inputCost + outputCost) * 100 * 100) / 100; // cents, 2 decimal places
}

export { PRICING };
