import { describe, it, expect } from "vitest";
import { parseApprovalAction } from "../agent/channels/slack";

describe("parseApprovalAction", () => {
  it("parses a valid approve action", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr", value: "run-123:approve" })).toEqual({
      runId: "run-123",
      decision: "approve",
    });
  });

  it("parses a valid deny action", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr", value: "run-123:deny" })).toEqual({
      runId: "run-123",
      decision: "deny",
    });
  });

  it("returns null for a different actionId", () => {
    expect(parseApprovalAction({ actionId: "something_else", value: "run-123:approve" })).toBeNull();
  });

  it("returns null when value is missing", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr" })).toBeNull();
  });

  it("returns null when the decision isn't approve or deny", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr", value: "run-123:maybe" })).toBeNull();
  });

  it("returns null when the runId is empty", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr", value: ":approve" })).toBeNull();
  });
});
