import { describe, it, expect } from "vitest";
import { extractCostRecord } from "../agent/hooks/cost-tracking";

describe("extractCostRecord", () => {
  it("computes cost from token counts, ignoring any usage.costUsd field", () => {
    // Sonnet: $3.00/$15.00 per million. 1200 input + 300 output tokens.
    // (1200/1e6)*3 + (300/1e6)*15 = 0.0036 + 0.0045 = 0.0081
    const record = extractCostRecord(
      { data: { usage: { costUsd: 0.0034, inputTokens: 1200, outputTokens: 300 } } },
      "fix",
      "claude-sonnet-5",
    );
    expect(record).toEqual({
      phase: "fix",
      model: "claude-sonnet-5",
      costUsd: 0.0081,
      inputTokens: 1200,
      outputTokens: 300,
      at: record?.at,
    });
    expect(record?.at).toBeTruthy();
  });

  it("returns null when the event has no usage", () => {
    const record = extractCostRecord({ data: {} }, "fix", "claude-sonnet-5");
    expect(record).toBeNull();
  });

  it("defaults missing numeric fields to 0, and cost to 0 with zero tokens", () => {
    const record = extractCostRecord({ data: { usage: {} } }, "fix", "claude-sonnet-5");
    expect(record).toEqual({
      phase: "fix",
      model: "claude-sonnet-5",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      at: record?.at,
    });
  });

  it("returns 0 cost for an unrecognized model, not a thrown error", () => {
    const record = extractCostRecord(
      { data: { usage: { inputTokens: 1000, outputTokens: 100 } } },
      "fix",
      "some-unknown-model",
    );
    expect(record?.costUsd).toBe(0);
  });
});
