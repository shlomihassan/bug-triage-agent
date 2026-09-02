import { describe, it, expect } from "vitest";
import { branchNameForIssue } from "../agent/tools/create_branch";

describe("branchNameForIssue", () => {
  it("formats the branch name from an issue number", () => {
    expect(branchNameForIssue(42)).toBe("fix/issue-42");
  });

  it("rejects a non-positive issue number", () => {
    expect(() => branchNameForIssue(0)).toThrow();
    expect(() => branchNameForIssue(-1)).toThrow();
  });
});
