import { describe, it, expect } from "vitest";
import {
  parseApprovalAction,
  parseApproverAllowlist,
  isAuthorizedApprover,
} from "../agent/channels/slack";

describe("parseApprovalAction", () => {
  // Two distinct action_ids because Slack rejects a message where two elements share one
  // (confirmed live against the real API: "action_id \"resolve_pr\" already exists").
  it("parses a valid approve action (resolve_pr_approve)", () => {
    expect(
      parseApprovalAction({ actionId: "resolve_pr_approve", value: "run-123:approve" }),
    ).toEqual({ runId: "run-123", decision: "approve" });
  });

  it("parses a valid deny action (resolve_pr_deny)", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr_deny", value: "run-123:deny" })).toEqual({
      runId: "run-123",
      decision: "deny",
    });
  });

  it("returns null for a different actionId", () => {
    expect(
      parseApprovalAction({ actionId: "something_else", value: "run-123:approve" }),
    ).toBeNull();
  });

  it("returns null when value is missing", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr_approve" })).toBeNull();
  });

  it("returns null when the decision isn't approve or deny", () => {
    expect(
      parseApprovalAction({ actionId: "resolve_pr_approve", value: "run-123:maybe" }),
    ).toBeNull();
  });

  it("returns null when the runId is empty", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr_approve", value: ":approve" })).toBeNull();
  });
});

describe("parseApproverAllowlist", () => {
  it("returns an empty array when envValue is undefined", () => {
    expect(parseApproverAllowlist(undefined)).toEqual([]);
  });

  it("returns an empty array when envValue is empty string", () => {
    expect(parseApproverAllowlist("")).toEqual([]);
  });

  it("returns an empty array when envValue is only whitespace", () => {
    expect(parseApproverAllowlist("   ")).toEqual([]);
  });

  it("parses a single user ID", () => {
    expect(parseApproverAllowlist("U012ABC")).toEqual(["U012ABC"]);
  });

  it("parses multiple comma-separated user IDs", () => {
    expect(parseApproverAllowlist("U012ABC,U034DEF,U056GHI")).toEqual([
      "U012ABC",
      "U034DEF",
      "U056GHI",
    ]);
  });

  it("trims whitespace around user IDs", () => {
    expect(parseApproverAllowlist("U012ABC, U034DEF , U056GHI")).toEqual([
      "U012ABC",
      "U034DEF",
      "U056GHI",
    ]);
  });

  it("filters out empty strings after trimming", () => {
    expect(parseApproverAllowlist("U012ABC, , U034DEF")).toEqual(["U012ABC", "U034DEF"]);
  });

  it("handles leading and trailing whitespace in input", () => {
    expect(parseApproverAllowlist("  U012ABC, U034DEF  ")).toEqual(["U012ABC", "U034DEF"]);
  });
});

describe("isAuthorizedApprover", () => {
  it("returns true when user is in the allowlist", () => {
    const allowlist = ["U012ABC", "U034DEF"];
    expect(isAuthorizedApprover("U012ABC", allowlist)).toBe(true);
  });

  it("returns false when user is not in the allowlist", () => {
    const allowlist = ["U012ABC", "U034DEF"];
    expect(isAuthorizedApprover("U999ZZZ", allowlist)).toBe(false);
  });

  it("returns false when allowlist is empty", () => {
    expect(isAuthorizedApprover("U012ABC", [])).toBe(false);
  });

  it("returns false when allowlist is empty array", () => {
    const allowlist: readonly string[] = [];
    expect(isAuthorizedApprover("U012ABC", allowlist)).toBe(false);
  });

  it("is case-sensitive", () => {
    const allowlist = ["U012ABC"];
    expect(isAuthorizedApprover("u012abc", allowlist)).toBe(false);
  });
});
