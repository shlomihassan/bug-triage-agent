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
//
// Returns the posted message's own `ts` (or undefined if the post was skipped/failed) so a
// caller that needs to edit that exact message later (e.g. run-tracking.ts's session.started
// placeholder, later edited by classify_severity.ts via updateRunThreadMessage) can capture it
// without a second, duplicate Slack call. Existing callers that don't need this simply ignore
// the return value — this is additive, not a contract change for them.
export async function postToRunThread(
  store: BugRunStore,
  runId: string,
  message: SlackMessage,
): Promise<string | undefined> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!token || !channelId) {
    // Not a true error condition — e.g. local dev without Slack configured — so warn, not error.
    console.warn("[slack-notify] ✖ SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not set — skipping post");
    return undefined;
  }

  const run = await store.getRun(runId).catch(() => null);
  if (!run) return undefined;

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
      return undefined;
    }
    if (!run.slackThreadTs && body.ts) {
      await store
        .updateRun(runId, { slackChannelId: channelId, slackThreadTs: body.ts })
        .catch((err) => console.error(`[slack-notify] ✖ updateRun (thread) failed:`, err));
    }
    return body.ts;
  } catch (err) {
    console.error(`[slack-notify] ✖ chat.postMessage threw:`, err);
    return undefined;
  }
}

// Updates a specific already-posted message in place (Slack's chat.update), mirroring
// postToRunThread's env-var checks and best-effort/non-fatal error handling exactly. Takes the
// target message's own `ts` (not the thread root) because this is used both to edit the
// session.started placeholder root message and, separately, to edit other specific messages
// (e.g. the approval-request message) — the caller always knows which message it wants updated.
export async function updateRunThreadMessage(
  store: BugRunStore,
  runId: string,
  ts: string,
  message: SlackMessage,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!token || !channelId) {
    console.warn("[slack-notify] ✖ SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not set — skipping update");
    return;
  }

  const run = await store.getRun(runId).catch(() => null);
  if (!run) return;

  try {
    const response = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: run.slackChannelId ?? channelId,
        ts,
        text: message.text,
        blocks: message.blocks,
      }),
    });
    const body = (await response.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
      console.error(`[slack-notify] ✖ chat.update failed: ${body.error}`);
    }
  } catch (err) {
    console.error(`[slack-notify] ✖ chat.update threw:`, err);
  }
}
