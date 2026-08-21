import { defineTool } from "eve/tools";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { requiresApproval } from "../lib/autonomy";
import { loadConfig } from "../lib/config";
import { createRedisStore } from "../lib/store";

export const openPrInputSchema = z.object({
  issueNumber: z.number().int().positive(),
  branch: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  blastRadiusTier: z.enum(["high", "medium", "low"]),
  filesChanged: z.number().int().nonnegative(),
  linesChanged: z.number().int().nonnegative(),
  checksAllPassed: z.boolean(),
  reproTestPassed: z.boolean(),
});

const store = createRedisStore();

// Extracted from the `defineTool` call below (rather than inlined) so it can be imported and
// called directly in tests/open-pr-approval.test.ts without needing to know defineTool's
// return shape — this is the actual escalation gate, so it's worth testing on its own.
export function openPrApprovalPolicy({
  toolInput,
}: {
  toolInput?: unknown;
}): "user-approval" | "not-applicable" {
  if (!toolInput) return "user-approval";
  const parsed = openPrInputSchema.safeParse(toolInput);
  if (!parsed.success) return "user-approval";
  return requiresApproval(parsed.data) ? "user-approval" : "not-applicable";
}

export default defineTool({
  description:
    "Open a draft pull request for a fix that has already been committed to a branch in the " +
    "sandbox and pushed to the fork. Provide the severity/blast-radius/diff-size/check-result " +
    "fields honestly — they determine whether this runs automatically or pauses for human " +
    "approval. Never call this before pushing the branch.",
  inputSchema: openPrInputSchema,
  approval: openPrApprovalPolicy,
  async execute(input, ctx) {
    const config = loadConfig();
    // A tool's ToolContext has no ctx.github (that's only on channel dispatch/hook contexts,
    // per eve/channels/github's onIssue/onComment) — so this uses its own PAT rather than the
    // Connect-managed installation token the github channel (Task 15) uses for comments.
    const octokit = new Octokit({ auth: process.env.GITHUB_PR_TOKEN });
    const pr = await octokit.pulls.create({
      owner: config.githubOwner,
      repo: config.githubRepo,
      title: input.title,
      body: input.body,
      head: input.branch,
      base: "main",
      draft: true,
    });
    const outcome = requiresApproval(input) ? "escalated" : "auto_resolved";
    await store
      .updateRun(ctx.session.id, {
        status: "pr_opened",
        prUrl: pr.data.html_url,
        outcome,
        completedAt: new Date().toISOString(),
      })
      // The PR is already open at this point; losing the update silently leaves the dashboard
      // claiming the run is still in flight forever.
      .catch((err) => console.error(`[open_pr] ✖ updateRun failed:`, err));
    return { prUrl: pr.data.html_url, prNumber: pr.data.number };
  },
});
