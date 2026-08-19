import { describe, it, expect } from "vitest";
import { calculateCostUsd } from "../agent/lib/pricing";

describe("calculateCostUsd", () => {
  it("computes cost from input and output tokens at the model's published rates", () => {
    // 1,000,000 input + 1,000,000 output tokens at Haiku's $1.00/$5.00 per million.
    expect(calculateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBeCloseTo(6.0);
  });

  it("scales linearly for partial-million token counts", () => {
    // 500,000 input tokens at Sonnet's $3.00/million = $1.50; 0 output tokens = $0.
    expect(calculateCostUsd("claude-sonnet-5", 500_000, 0)).toBeCloseTo(1.5);
  });

  it("returns 0 for an unknown model rather than throwing", () => {
    expect(calculateCostUsd("some-unknown-model", 1_000_000, 1_000_000)).toBe(0);
  });
});
