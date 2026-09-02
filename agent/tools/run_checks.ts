import { defineTool } from "eve/tools";
import { z } from "zod";

export interface CheckResult {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function summarizeCheckResults(
  results: readonly CheckResult[],
): { allPassed: boolean; failed: readonly string[] } {
  const failed = results.filter((r) => r.exitCode !== 0).map((r) => r.name);
  return { allPassed: failed.length === 0, failed };
}

interface CheckSpec {
  readonly name: string;
  readonly command: string;
  readonly workingDirectory: string;
}

const BACKEND_CHECKS: readonly CheckSpec[] = [
  { name: "mage lint", command: "mage lint", workingDirectory: "/workspace" },
  { name: "mage test:web", command: "mage test:web", workingDirectory: "/workspace" },
];

const FRONTEND_CHECKS: readonly CheckSpec[] = [
  { name: "pnpm lint", command: "pnpm lint", workingDirectory: "/workspace/frontend" },
  { name: "pnpm typecheck", command: "pnpm typecheck", workingDirectory: "/workspace/frontend" },
  { name: "pnpm test:unit", command: "pnpm test:unit", workingDirectory: "/workspace/frontend" },
];

function checksForScope(scope: "backend" | "frontend" | "both"): readonly CheckSpec[] {
  if (scope === "backend") return BACKEND_CHECKS;
  if (scope === "frontend") return FRONTEND_CHECKS;
  return [...BACKEND_CHECKS, ...FRONTEND_CHECKS];
}

export default defineTool({
  description:
    "Run the fixed check suite for backend, frontend, or both, in order, and report a " +
    "structured pass/fail per check. Call this once per fix attempt, after editing code.",
  inputSchema: z.object({ scope: z.enum(["backend", "frontend", "both"]) }),
  outputSchema: z.object({
    allPassed: z.boolean(),
    failed: z.array(z.string()),
    results: z.array(
      z.object({
        name: z.string(),
        exitCode: z.number(),
        stdout: z.string(),
        stderr: z.string(),
      }),
    ),
  }),
  async execute({ scope }, ctx) {
    const sandbox = await ctx.getSandbox();
    const results: CheckResult[] = [];
    for (const check of checksForScope(scope)) {
      const outcome = await sandbox.run({
        command: check.command,
        workingDirectory: check.workingDirectory,
      });
      results.push({
        name: check.name,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      });
    }
    const summary = summarizeCheckResults(results);
    return { ...summary, results };
  },
});
