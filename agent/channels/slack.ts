import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";
import { Octokit } from "@octokit/rest";
import { createRedisStore } from "../lib/store";
import { resolvePendingPr } from "../lib/pr-approval";

const store = createRedisStore();

export function parseApprovalAction(action: {
  readonly actionId: string;
  readonly value?: string;
}): { runId: string; decision: "approve" | "deny" } | null {
  if (action.actionId !== "resolve_pr" || !action.value) return null;
  const separatorIndex = action.value.lastIndexOf(":");
  if (separatorIndex <= 0) return null;
  const runId = action.value.slice(0, separatorIndex);
  const decision = action.value.slice(separatorIndex + 1);
  if (decision !== "approve" && decision !== "deny") return null;
  return { runId, decision };
}

export default slackChannel({
  // Provisioned via `vercel connect create slack --triggers` under the UID
  // "slack/bug-triage-agent" (see docs/superpowers/specs/2026-08-21-slack-integration-design.md
  // for the full setup). Used here only for inbound webhook verification and this channel's own
  // onInteraction dispatch — outbound notifications (agent/lib/slack-notify.ts) use a separate,
  // manually-configured SLACK_BOT_TOKEN instead, since Connect's managed token isn't reachable
  // from the hooks/tools that post those.
  credentials: connectSlackCredentials("slack/bug-triage-agent"),
  // No onMessage/onAppMention: the agent never holds a conversation in Slack. onInteraction is
  // the only inbound behavior — resolving Approve/Deny button clicks directly against
  // run.pendingPr, the same way agent/channels/dashboard.ts's buttons already do (both call
  // resolvePendingPr so the two surfaces can never behave differently).
  async onInteraction(action, ctx) {
    const parsed = parseApprovalAction(action);
    if (!parsed) return;

    const octokit = new Octokit({ auth: process.env.GITHUB_PR_TOKEN });
    const result = await resolvePendingPr(store, parsed.runId, parsed.decision, octokit);

    const outcomeText = !result.ok
      ? `⚠️ ${result.reason}`
      : "denied" in result
        ? `🚫 Denied by <@${action.user.id}>`
        : `✅ Approved by <@${action.user.id}> — <${result.prUrl}|PR opened>`;

    // Updates the clicked message in place (strips the buttons, shows the resolution) rather
    // than posting a new reply — ctx.slack.request is the raw Slack Web API escape hatch,
    // available here because onInteraction runs inside real Slack channel-dispatch context
    // (unlike slack-notify.ts's callers). request() resolves even when Slack's API rejects the
    // call (body.ok: false) — it does not throw — so check .ok explicitly rather than relying
    // on .catch() alone, same as slack-notify.ts's own fetch-based calls do.
    try {
      const response = await ctx.slack.request("chat.update", {
        channel: ctx.slack.channelId,
        ts: action.messageTs,
        text: outcomeText,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: outcomeText } }],
      });
      if (!response.ok) {
        console.error("[slack] ✖ chat.update after resolution failed:", response);
      }
    } catch (err) {
      console.error("[slack] ✖ chat.update after resolution threw:", err);
    }
  },
});
