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
    expect(openPrApprovalPolicy({ toolInput: validInput })).toBe("not-applicable");
  });

  it("requires approval for a high-blast-radius fix", () => {
    expect(
      openPrApprovalPolicy({ toolInput: { ...validInput, blastRadiusTier: "high" } }),
    ).toBe("user-approval");
  });

  it("fails closed when toolInput is undefined", () => {
    expect(openPrApprovalPolicy({ toolInput: undefined })).toBe("user-approval");
  });

  it("fails closed when toolInput doesn't match the schema", () => {
    expect(openPrApprovalPolicy({ toolInput: { nonsense: true } })).toBe("user-approval");
  });
});
