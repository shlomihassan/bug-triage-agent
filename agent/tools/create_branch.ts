import { defineTool } from "eve/tools";
import { z } from "zod";

export function branchNameForIssue(issueNumber: number): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`branchNameForIssue: issueNumber must be a positive integer, got ${issueNumber}`);
  }
  return `fix/issue-${issueNumber}`;
}

export default defineTool({
  description:
    "Create and check out a fix branch named fix/issue-<issueNumber> in the sandbox. Call this " +
    "once, before editing any files.",
  inputSchema: z.object({ issueNumber: z.number().int().positive() }),
  outputSchema: z.object({ branch: z.string(), ok: z.literal(true) }),
  async execute({ issueNumber }, ctx) {
    const branch = branchNameForIssue(issueNumber);
    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({
      command: `git checkout -b ${branch}`,
      workingDirectory: "/workspace",
    });
    if (result.exitCode !== 0) {
      throw new Error(`git checkout -b ${branch} failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    return { branch, ok: true as const };
  },
});
