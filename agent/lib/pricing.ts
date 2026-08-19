import { HAIKU_MODEL_ID, SONNET_MODEL_ID, OPUS_MODEL_ID } from "./anthropic";

// Anthropic per-model pricing in USD per million tokens. Verified directly against
// https://platform.claude.com/docs/en/about-claude/pricing on 2026-08-20 (base input/output
// rates; this project uses neither prompt caching nor batch processing, so those columns don't
// apply). Anthropic can still change published rates after this date — re-verify before relying
// on these for real budget decisions on a long-running deployment.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [HAIKU_MODEL_ID]: { input: 1.0, output: 5.0 },
  [SONNET_MODEL_ID]: { input: 2.0, output: 10.0 },
  [OPUS_MODEL_ID]: { input: 5.0, output: 25.0 },
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
