import type { BugRunStore } from "./store";
import { postToRunThread } from "./slack-notify";

export interface PrClient {
  pulls: {
    create(params: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      head: string;
      base: string;
      draft: boolean;
    }): Promise<{ data: { html_url: string } }>;
  };
}

export type ResolvePendingPrResult =
  | { ok: true; denied: true }
  | { ok: true; prUrl: string }
  | { ok: false; reason: string };

// Single place that turns a human's approve/deny decision into either a real draft PR or a
// denied run. Called from both agent/channels/dashboard.ts's resolve-pr route and Slack's
// onInteraction (agent/channels/slack.ts) — extracted so the two surfaces can never drift into
// different behavior. Neither caller needs the original agent session alive: opening a PR is a
// stateless REST call, and denying just updates the run record (see PendingPr's comment in
// lib/store.ts for why this bypasses eve's session-based approval entirely).
//
// Idempotency: the status guard below (run.status !== "awaiting_approval") is what makes it safe
// for the dashboard and Slack to click Approve/Deny on the same run concurrently. pendingPr
// itself can NOT be used as that guard — and can never be cleared to signal "already resolved" —
// because updateRun's patch is JSON.stringify'd (which drops `undefined` keys) and the Redis Lua
// merge script (lib/store.ts's UPDATE_RUN_SCRIPT) only assigns keys present in the patch, so
// there is no way to unset pendingPr through the existing store API. Without this guard, a stale
// click (e.g. a Slack button clicked after the dashboard already denied the run) would silently
// re-run the approve/deny logic against an already-resolved run — confirmed as a real bug in
// review: a dashboard denial followed by a stale Slack approval click would call octokit.pulls
// .create and overwrite the denial with pr_opened/escalated.
export async function resolvePendingPr(
  store: BugRunStore,
  runId: string,
  decision: "approve" | "deny",
  octokit: PrClient,
): Promise<ResolvePendingPrResult> {
  const run = await store.getRun(runId);
  if (run?.status !== "awaiting_approval") {
    return { ok: false, reason: `Run already resolved (${run?.status})` };
  }
  if (!run?.pendingPr) {
    return { ok: false, reason: "No pendingPr recorded for this run" };
  }

  if (decision === "deny") {
    await store.updateRun(runId, {
      status: "failed",
      outcome: "denied",
      completedAt: new Date().toISOString(),
    });
    await postToRunThread(store, runId, { text: "🚫 Denied" }).catch((err) =>
      console.error(`[pr-approval] ✖ Slack post (denied) failed:`, err),
    );
    return { ok: true, denied: true };
  }

  // Confirmed live (2026-08-21): a real GitHub API rejection here (invalid branch, permissions,
  // rate limit) previously propagated as an uncaught exception out of Slack's onInteraction
  // handler ("custom interaction handler failed"), leaving the click with no user-facing
  // feedback at all — the run stayed correctly at awaiting_approval (nothing corrupted, since
  // this throw happens before any updateRun call below), but the human had no way to know their
  // click didn't work. Catching it here means both callers (dashboard route, Slack
  // onInteraction) get a normal { ok: false, reason } instead of a thrown error to handle
  // themselves — one failure-reporting path instead of two.
  let pr: { data: { html_url: string } };
  try {
    pr = await octokit.pulls.create({
      owner: run.pendingPr.owner,
      repo: run.pendingPr.repo,
      title: run.pendingPr.title,
      body: run.pendingPr.body,
      head: run.pendingPr.branch,
      base: "main",
      draft: true,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[pr-approval] ✖ octokit.pulls.create failed for ${runId}:`, err);
    return { ok: false, reason: `Failed to open PR: ${reason}` };
  }
  await store.updateRun(runId, {
    status: "pr_opened",
    prUrl: pr.data.html_url,
    outcome: "escalated",
    completedAt: new Date().toISOString(),
  });
  await postToRunThread(store, runId, {
    text: `✅ Approved — PR opened: ${pr.data.html_url}`,
  }).catch((err) => console.error(`[pr-approval] ✖ Slack post (approved) failed:`, err));
  return { ok: true, prUrl: pr.data.html_url };
}
