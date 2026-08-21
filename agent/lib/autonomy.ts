export type Severity = "critical" | "high" | "medium" | "low";
export type BlastRadiusTier = "high" | "medium" | "low";

export interface AutonomyInput {
  readonly severity: Severity;
  readonly blastRadiusTier: BlastRadiusTier;
  readonly filesChanged: number;
  readonly linesChanged: number;
  readonly checksAllPassed: boolean;
  readonly reproTestPassed: boolean;
}

const MAX_AUTO_FILES = 3;
const MAX_AUTO_LINES = 150;

/**
 * Deterministic override applied after the model's own severity/blast-radius
 * judgment. Mirrors the "risk = impact x probability, with a forced override
 * for the unambiguous cases" pattern: the model's classification is a signal,
 * never the final word on whether a human must sign off.
 */
export function requiresApproval(input: AutonomyInput): boolean {
  if (input.blastRadiusTier === "high") return true;
  if (input.severity === "critical") return true;
  if (!input.checksAllPassed) return true;
  if (!input.reproTestPassed) return true;
  if (input.filesChanged > MAX_AUTO_FILES) return true;
  if (input.linesChanged > MAX_AUTO_LINES) return true;
  return false;
}
