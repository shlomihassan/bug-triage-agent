import { describe, it, expect } from "vitest";
import { calculateCostUsd } from "../agent/lib/pricing";

describe("calculateCostUsd", () => {
  it("computes cost from input and output tokens at the model's published rates", () => {
    // 1,000,000 input + 1,000,000 output tokens at Haiku's $1.00/$5.00 per million.
    expect(calculateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBeCloseTo(6.0);
  });

  it("scales linearly for partial-million token counts", () => {
    // 500,000 input tokens at Sonnet's $2.00/million = $1.00; 0 output tokens = $0.
    expect(calculateCostUsd("claude-sonnet-5", 500_000, 0)).toBeCloseTo(1.0);
  });

  it("returns 0 for an unknown model rather than throwing", () => {
    expect(calculateCostUsd("some-unknown-model", 1_000_000, 1_000_000)).toBe(0);
  });

  it("prices cache-read tokens at 0.1x the base input rate", () => {
    // Sonnet, 1,000,000 total input tokens, all served from cache.
    // (1,000,000/1e6) * 2.00 * 0.1 = 0.20
    expect(
      calculateCostUsd("claude-sonnet-5", 1_000_000, 0, { cacheReadTokens: 1_000_000 }),
    ).toBeCloseTo(0.2);
  });

  it("prices cache-write tokens at 1.25x the base input rate", () => {
    // Sonnet, 1,000,000 total input tokens, all a fresh cache write.
    // (1,000,000/1e6) * 2.00 * 1.25 = 2.50
    expect(
      calculateCostUsd("claude-sonnet-5", 1_000_000, 0, { cacheWriteTokens: 1_000_000 }),
    ).toBeCloseTo(2.5);
  });

  it("splits a mixed input of cached, cache-write, and fresh tokens correctly", () => {
    // Sonnet, 1,000,000 total input: 700k cache reads, 100k cache write, 200k fresh.
    // (200k/1e6)*2.00 + (700k/1e6)*2.00*0.1 + (100k/1e6)*2.00*1.25
    // = 0.40 + 0.14 + 0.25 = 0.79
    expect(
      calculateCostUsd("claude-sonnet-5", 1_000_000, 0, {
        cacheReadTokens: 700_000,
        cacheWriteTokens: 100_000,
      }),
    ).toBeCloseTo(0.79);
  });
});
