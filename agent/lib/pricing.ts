import { HAIKU_MODEL_ID, SONNET_MODEL_ID, OPUS_MODEL_ID } from "./anthropic";

// Anthropic per-model pricing in USD per million tokens. Base input/output rates verified
// directly against https://platform.claude.com/docs/en/about-claude/pricing on 2026-08-20.
// Anthropic can still change published rates after this date — re-verify before relying on
// these for real budget decisions on a long-running deployment.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [HAIKU_MODEL_ID]: { input: 1.0, output: 5.0 },
  [SONNET_MODEL_ID]: { input: 2.0, output: 10.0 },
  [OPUS_MODEL_ID]: { input: 5.0, output: 25.0 },
};

// Prompt-cache multipliers relative to a model's base input rate, verified against the same
// pricing page: 5-minute cache writes are 1.25x base input, cache reads (either TTL) are 0.1x.
// eve/the AI SDK report `inputTokens` as the total prompt size, with `cacheReadTokens` and
// `cacheWriteTokens` as a breakdown of that total — not additive on top of it. Pricing every
// token at the flat input rate (as this function did before the cache breakdown was wired in)
// overstates real spend whenever caching is active, since eve already tracks cache_read_tokens
// as a routine per-step metric.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number },
): number {
  const rates = PRICING_PER_MILLION_TOKENS[model];
  if (!rates) {
    console.warn(`calculateCostUsd: unrecognized model "${model}", returning $0 cost`);
    return 0;
  }
  const cacheReadTokens = cacheDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = cacheDetails?.cacheWriteTokens ?? 0;
  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  return (
    (uncachedInputTokens / 1_000_000) * rates.input +
    (cacheReadTokens / 1_000_000) * rates.input * CACHE_READ_MULTIPLIER +
    (cacheWriteTokens / 1_000_000) * rates.input * CACHE_WRITE_MULTIPLIER +
    (outputTokens / 1_000_000) * rates.output
  );
}
