import { defineTool } from "eve/tools";
import { z } from "zod";

export function buildCommitMessage(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new Error("buildCommitMessage: description must not be empty");
  }
  return `fix: ${trimmed}`;
}

export default defineTool({
  description:
    "Stage all changes, commit with a fix: <description> message, and push the branch to the " +
    "fork. Call this once the repro test and full check suite both pass.",
  inputSchema: z.object({
    branch: z.string().min(1),
    description: z.string().min(1).describe("Short summary of the fix, e.g. 'null check on task attachment delete'"),
  }),
  outputSchema: z.object({ ok: z.literal(true) }),
  async execute({ branch, description }, ctx) {
    const message = buildCommitMessage(description);
    const sandbox = await ctx.getSandbox();

    const add = await sandbox.run({ command: "git add -A", workingDirectory: "/workspace" });
    if (add.exitCode !== 0) {
      throw new Error(`git add -A failed (exit ${add.exitCode}): ${add.stderr}`);
    }

    const commit = await sandbox.run({
      command: `git commit -m ${JSON.stringify(message)}`,
      workingDirectory: "/workspace",
    });
    if (commit.exitCode !== 0) {
      throw new Error(`git commit failed (exit ${commit.exitCode}): ${commit.stderr}`);
    }

    const push = await sandbox.run({
      command: `git push origin ${branch}`,
      workingDirectory: "/workspace",
    });
    if (push.exitCode !== 0) {
      throw new Error(`git push origin ${branch} failed (exit ${push.exitCode}): ${push.stderr}`);
    }

    return { ok: true as const };
  },
});
