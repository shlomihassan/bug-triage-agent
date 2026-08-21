import type { BugRunStore } from "./store";

export interface SlackMessage {
  readonly text: string;
  readonly blocks?: readonly unknown[];
}

// Posts to the dedicated Slack channel using a plain bot token, not eve's Connect-managed
// Slack credentials — those are only reachable from inside a tool's execute() or a Slack
// channel-dispatch context (agent/channels/slack.ts's onInteraction), and this is called from
// defineHook handlers and tool execute() bodies that aren't Slack-anchored at all. Mirrors the
// existing GITHUB_PR_TOKEN pattern (agent/tools/open_pr.ts) for the identical reason.
//
// Every call is best-effort: a Slack outage must never break triage/fix work, matching the
// error-handling style used throughout the codebase for GitHub comments and Redis writes.
export async function postToRunThread(
  store: BugRunStore,
  runId: string,
  message: SlackMessage,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!token || !channelId) {
    console.error("[slack-notify] ✖ SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not set — skipping post");
    return;
  }

  const run = await store.getRun(runId).catch(() => null);
  if (!run) return;

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: run.slackChannelId ?? channelId,
        thread_ts: run.slackThreadTs,
        text: message.text,
        blocks: message.blocks,
      }),
    });
    const body = (await response.json()) as { ok: boolean; ts?: string; error?: string };
    if (!body.ok) {
      console.error(`[slack-notify] ✖ chat.postMessage failed: ${body.error}`);
      return;
    }
    if (!run.slackThreadTs && body.ts) {
      await store
        .updateRun(runId, { slackChannelId: channelId, slackThreadTs: body.ts })
        .catch((err) => console.error(`[slack-notify] ✖ updateRun (thread) failed:`, err));
    }
  } catch (err) {
    console.error(`[slack-notify] ✖ chat.postMessage threw:`, err);
  }
}
