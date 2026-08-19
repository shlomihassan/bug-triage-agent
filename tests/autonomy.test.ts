import { describe, it, expect } from "vitest";
import { requiresApproval, type AutonomyInput } from "../agent/lib/autonomy";

const baseline: AutonomyInput = {
  severity: "medium",
  blastRadiusTier: "low",
  filesChanged: 1,
  linesChanged: 20,
  checksAllPassed: true,
  reproTestPassed: true,
};

describe("requiresApproval", () => {
  it("allows auto-open when everything is small, safe, and passing", () => {
    expect(requiresApproval(baseline)).toBe(false);
  });

  it("forces approval when blast radius is high", () => {
    expect(requiresApproval({ ...baseline, blastRadiusTier: "high" })).toBe(true);
  });

  it("forces approval when severity is critical", () => {
    expect(requiresApproval({ ...baseline, severity: "critical" })).toBe(true);
  });

  it("forces approval when any check failed", () => {
    expect(requiresApproval({ ...baseline, checksAllPassed: false })).toBe(true);
  });

  it("forces approval when the repro test doesn't pass", () => {
    expect(requiresApproval({ ...baseline, reproTestPassed: false })).toBe(true);
  });

  it("forces approval when the diff touches too many files", () => {
    expect(requiresApproval({ ...baseline, filesChanged: 4 })).toBe(true);
  });

  it("forces approval when the diff is too large", () => {
    expect(requiresApproval({ ...baseline, linesChanged: 151 })).toBe(true);
  });

  it("allows auto-open exactly at the caps", () => {
    expect(requiresApproval({ ...baseline, filesChanged: 3, linesChanged: 150 })).toBe(false);
  });
});
