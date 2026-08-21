import { describe, it, expect } from "vitest";
import { haikuModel, sonnetModel, opusModel } from "../agent/lib/anthropic";

describe("model routing", () => {
  it("routes each phase to a distinct, correctly-named model", () => {
    expect(haikuModel().modelId).toBe("claude-haiku-4-5-20251001");
    expect(sonnetModel().modelId).toBe("claude-sonnet-5");
    expect(opusModel().modelId).toBe("claude-opus-5");
  });
});
