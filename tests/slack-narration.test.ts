import { describe, it, expect } from "vitest";
import { shouldPostMessage } from "../agent/hooks/slack-narration";

describe("shouldPostMessage", () => {
  it("posts a normal finished text reply", () => {
    expect(shouldPostMessage({ finishReason: "stop", message: "Root cause found." })).toBe(true);
  });

  it("skips when the step ended in tool calls", () => {
    expect(shouldPostMessage({ finishReason: "tool-calls", message: "some text" })).toBe(false);
  });

  it("skips when there is no message text", () => {
    expect(shouldPostMessage({ finishReason: "stop", message: null })).toBe(false);
  });

  it("skips an empty string message", () => {
    expect(shouldPostMessage({ finishReason: "stop", message: "" })).toBe(false);
  });
});
