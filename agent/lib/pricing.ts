import { HAIKU_MODEL_ID, SONNET_MODEL_ID, OPUS_MODEL_ID } from "./anthropic";

// Anthropic per-model pricing in USD per million tokens. VERIFY AGAINST
// https://www.anthropic.com/pricing BEFORE RELYING ON THESE FOR REAL BUDGET DECISIONS —
// this table is a snapshot as of this plan's writing (2026-08-19), not fetched dynamically,
// and Anthropic can change published rates at any time.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [HAIKU_MODEL_ID]: { input: 1.0, output: 5.0 },
  [SONNET_MODEL_ID]: { input: 3.0, output: 15.0 },
  [OPUS_MODEL_ID]: { input: 15.0, output: 75.0 },
};

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = PRICING_PER_MILLION_TOKENS[model];
  if (!rates) {
    console.warn(`calculateCostUsd: unrecognized model "${model}", returning $0 cost`);
    return 0;
  }
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}
