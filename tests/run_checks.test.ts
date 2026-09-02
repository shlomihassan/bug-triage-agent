// tests/run_checks.test.ts
import { describe, it, expect } from "vitest";
import { summarizeCheckResults, type CheckResult } from "../agent/tools/run_checks";

function passing(name: string): CheckResult {
  return { name, exitCode: 0, stdout: "ok", stderr: "" };
}
function failing(name: string): CheckResult {
  return { name, exitCode: 1, stdout: "", stderr: "boom" };
}

describe("summarizeCheckResults", () => {
  it("reports allPassed true when every check exits 0", () => {
    const summary = summarizeCheckResults([passing("mage lint"), passing("pnpm lint")]);
    expect(summary.allPassed).toBe(true);
    expect(summary.failed).toEqual([]);
  });

  it("lists the names of failing checks and sets allPassed false", () => {
    const summary = summarizeCheckResults([passing("mage lint"), failing("pnpm typecheck")]);
    expect(summary.allPassed).toBe(false);
    expect(summary.failed).toEqual(["pnpm typecheck"]);
  });

  it("handles an empty result list as allPassed true (no checks were required)", () => {
    expect(summarizeCheckResults([])).toEqual({ allPassed: true, failed: [] });
  });
});
