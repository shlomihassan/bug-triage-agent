import { describe, it, expect } from "vitest";
import { openPrApprovalPolicy } from "../agent/tools/open_pr";

// Regression guard: adding Slack posting to open_pr.ts's execute() must not change
// openPrApprovalPolicy's pure decision logic, which tests/open-pr-approval.test.ts already
// covers in full. This test exists to be the first thing that fails if a future edit
// accidentally couples the two.
describe("openPrApprovalPolicy after Slack wiring", () => {
  it("is unaffected by Slack posting (still a pure decision)", () => {
    expect(
      openPrApprovalPolicy({
        toolInput: {
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
        },
      }),
    ).toBe("not-applicable");
  });
});
