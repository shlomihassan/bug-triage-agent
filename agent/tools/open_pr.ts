import { defineTool } from "eve/tools";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { requiresApproval } from "../lib/autonomy";
import { loadConfig } from "../lib/config";
import { createRedisStore } from "../lib/store";
import { postToRunThread } from "../lib/slack-notify";

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

// Extracted (rather than inlined in execute()) so it can be imported and called directly in
// tests/open-pr-approval.test.ts without needing to exercise the whole tool — this is the
// actual escalation gate, so it's worth testing on its own. No longer wired as defineTool's
// `approval:` option (see execute()'s comment and PendingPr in lib/store.ts for why); the
// "user-approval"/"not-applicable" return shape is kept only because it already matches eve's
// own vocabulary and the existing tests assert on it.
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
    "fields honestly — they determine whether this runs automatically or is parked for human " +
    "approval on the dashboard. Never call this before pushing the branch.",
  inputSchema: openPrInputSchema,
  async execute(input, ctx) {
    const config = loadConfig();
    // Deliberately NOT eve's `approval:` HITL gate (see PendingPr's comment in lib/store.ts for
    // why): pausing the session and waiting for it to be resumed turned out to be architecturally
    // unreachable from our own dashboard. Parking the PR request in Redis and letting this turn
    // finish normally means the human decision is a plain REST call from the dashboard later,
    // not a resumed agent session.
    if (openPrApprovalPolicy({ toolInput: input }) === "user-approval") {
      await store
        .updateRun(ctx.session.id, {
          status: "awaiting_approval",
          pendingPr: {
            owner: config.githubOwner,
            repo: config.githubRepo,
            title: input.title,
            body: input.body,
            branch: input.branch,
          },
        })
        .catch((err) => console.error(`[open_pr] ✖ updateRun (pendingPr) failed:`, err));
      await postToRunThread(store, ctx.session.id, {
        text: `🚧 *${input.title}* needs approval before the PR opens.`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `🚧 *${input.title}* needs approval before the PR opens.\nBranch \`${input.branch}\`` },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "resolve_pr",
                text: { type: "plain_text", text: "Approve" },
                style: "primary",
                value: `${ctx.session.id}:approve`,
              },
              {
                type: "button",
                action_id: "resolve_pr",
                text: { type: "plain_text", text: "Deny" },
                style: "danger",
                value: `${ctx.session.id}:deny`,
              },
            ],
          },
        ],
      }).catch((err) => console.error(`[open_pr] ✖ Slack post (approval) failed:`, err));
      return {
        status: "awaiting_approval" as const,
        message:
          "This change touches auth/permissions (or otherwise needs review) and has been " +
          "parked for a maintainer to approve on the dashboard — no PR has been opened yet. " +
          "Your work is done here; stop and report this in your final reply.",
      };
    }
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
    await store
      .updateRun(ctx.session.id, {
        status: "pr_opened",
        prUrl: pr.data.html_url,
        outcome: "auto_resolved",
        completedAt: new Date().toISOString(),
      })
      // The PR is already open at this point; losing the update silently leaves the dashboard
      // claiming the run is still in flight forever.
      .catch((err) => console.error(`[open_pr] ✖ updateRun failed:`, err));
    await postToRunThread(store, ctx.session.id, {
      text: `✅ PR opened: ${pr.data.html_url}`,
    }).catch((err) => console.error(`[open_pr] ✖ Slack post (outcome) failed:`, err));
    return { prUrl: pr.data.html_url, prNumber: pr.data.number };
  },
});
