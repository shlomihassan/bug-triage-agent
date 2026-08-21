import type { BugRunStore } from "./store";

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
export async function resolvePendingPr(
  store: BugRunStore,
  runId: string,
  decision: "approve" | "deny",
  octokit: PrClient,
): Promise<ResolvePendingPrResult> {
  const run = await store.getRun(runId);
  if (!run?.pendingPr) {
    return { ok: false, reason: "No pendingPr recorded for this run" };
  }

  if (decision === "deny") {
    await store.updateRun(runId, {
      status: "failed",
      outcome: "denied",
      completedAt: new Date().toISOString(),
    });
    return { ok: true, denied: true };
  }

  const pr = await octokit.pulls.create({
    owner: run.pendingPr.owner,
    repo: run.pendingPr.repo,
    title: run.pendingPr.title,
    body: run.pendingPr.body,
    head: run.pendingPr.branch,
    base: "main",
    draft: true,
  });
  await store.updateRun(runId, {
    status: "pr_opened",
    prUrl: pr.data.html_url,
    outcome: "escalated",
    completedAt: new Date().toISOString(),
  });
  return { ok: true, prUrl: pr.data.html_url };
}
