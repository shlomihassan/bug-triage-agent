import { describe, it, expect } from "vitest";
import { openPrApprovalPolicy } from "../agent/tools/open_pr";

const validInput = {
  issueNumber: 1,
  branch: "fix/issue-1",
  title: "Fix it",
  body: "Body",
  severity: "medium",
  blastRadiusTier: "low",
  filesChanged: 1,
  linesChanged: 10,
  checksAllPassed: true,
  reproTestPassed: true,
};

describe("openPrApprovalPolicy", () => {
  it("allows a small, safe, passing fix through without approval", () => {
    expect(
      openPrApprovalPolicy({ toolInput: validInput, severity: "medium", blastRadiusTier: "low" }),
    ).toBe("not-applicable");
  });

  it("requires approval for a high-blast-radius fix", () => {
    expect(
      openPrApprovalPolicy({ toolInput: validInput, severity: "medium", blastRadiusTier: "high" }),
    ).toBe("user-approval");
  });

  it("fails closed when toolInput is undefined", () => {
    expect(
      openPrApprovalPolicy({ toolInput: undefined, severity: "low", blastRadiusTier: "low" }),
    ).toBe("user-approval");
  });

  it("fails closed when toolInput doesn't match the schema", () => {
    expect(
      openPrApprovalPolicy({
        toolInput: { nonsense: true },
        severity: "low",
        blastRadiusTier: "low",
      }),
    ).toBe("user-approval");
  });

  it("fails closed when severity or blastRadiusTier weren't resolved", () => {
    expect(
      openPrApprovalPolicy({ toolInput: validInput, severity: undefined, blastRadiusTier: "low" }),
    ).toBe("user-approval");
    expect(
      openPrApprovalPolicy({ toolInput: validInput, severity: "low", blastRadiusTier: undefined }),
    ).toBe("user-approval");
  });
});
