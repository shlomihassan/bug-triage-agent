// Anthropic per-model pricing in USD per million tokens. VERIFY AGAINST
// https://www.anthropic.com/pricing BEFORE RELYING ON THESE FOR REAL BUDGET DECISIONS —
// this table is a snapshot as of this plan's writing (2026-08-19), not fetched dynamically,
// and Anthropic can change published rates at any time.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-5": { input: 15.0, output: 75.0 },
};

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = PRICING_PER_MILLION_TOKENS[model];
  if (!rates) return 0;
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}
