import { describe, it, expect } from "vitest";
import { isOpenPrApprovalRequested } from "../agent/hooks/run-status";

describe("isOpenPrApprovalRequested", () => {
  it("returns true when requests include a tool-approval for open_pr", () => {
    expect(
      isOpenPrApprovalRequested({
        data: { requests: [{ kind: "tool-approval", action: { toolName: "open_pr" } }] },
      }),
    ).toBe(true);
  });

  it("returns false for a tool-approval on a different tool", () => {
    expect(
      isOpenPrApprovalRequested({
        data: { requests: [{ kind: "tool-approval", action: { toolName: "some_other_tool" } }] },
      }),
    ).toBe(false);
  });

  it("returns false for a question request", () => {
    expect(
      isOpenPrApprovalRequested({
        data: { requests: [{ kind: "question" }] },
      }),
    ).toBe(false);
  });

  it("returns false for a session-limit request", () => {
    expect(
      isOpenPrApprovalRequested({
        data: { requests: [{ kind: "session-limit" }] },
      }),
    ).toBe(false);
  });

  it("returns false when requests is empty", () => {
    expect(isOpenPrApprovalRequested({ data: { requests: [] } })).toBe(false);
  });

  it("returns true when an open_pr approval is mixed in with unrelated requests", () => {
    expect(
      isOpenPrApprovalRequested({
        data: {
          requests: [
            { kind: "question" },
            { kind: "tool-approval", action: { toolName: "open_pr" } },
          ],
        },
      }),
    ).toBe(true);
  });
});
