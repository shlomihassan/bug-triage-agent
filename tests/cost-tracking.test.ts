import { describe, it, expect } from "vitest";
import { extractCostRecord } from "../agent/hooks/cost-tracking";

describe("extractCostRecord", () => {
  it("builds a record from a step.completed event with usage", () => {
    const record = extractCostRecord(
      { data: { usage: { costUsd: 0.0034, inputTokens: 1200, outputTokens: 300 } } },
      "fix",
      "claude-sonnet-5",
    );
    expect(record).toEqual({
      phase: "fix",
      model: "claude-sonnet-5",
      costUsd: 0.0034,
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

  it("defaults missing numeric fields to 0", () => {
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
});
