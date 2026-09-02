import { describe, it, expect } from "vitest";
import { buildCommitMessage } from "../agent/tools/commit_and_push";

describe("buildCommitMessage", () => {
  it("prefixes the description with fix:", () => {
    expect(buildCommitMessage("null check on task attachment delete")).toBe(
      "fix: null check on task attachment delete",
    );
  });

  it("rejects an empty description", () => {
    expect(() => buildCommitMessage("")).toThrow();
    expect(() => buildCommitMessage("   ")).toThrow();
  });
});
