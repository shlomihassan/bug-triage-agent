import { defineChannel, GET, POST } from "eve/channels";
import { createRedisStore, totalCost, tokenTotals, type BugRun } from "../lib/store";

const TERMINAL_STATUSES: BugRun["status"][] = ["pr_opened", "failed"];

const store = createRedisStore();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

// completedAt is unset for a still-running run — elapsed counts up to now instead, so an
// in-progress run's row shows live-growing elapsed time rather than a blank.
function formatElapsed(startedAt: string, completedAt: string | undefined): string {
  const startMs = new Date(startedAt).getTime();
  const endMs = completedAt ? new Date(completedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s${completedAt ? "" : " (running)"}`;
}

function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title><style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
    a { color: #0060df; }
  </style></head><body>${body}</body></html>`;
}

export default defineChannel({
  routes: [
    GET("/dashboard", async () => {
      const runs = await store.listRuns();
      const totalSpend = runs.reduce((sum, run) => sum + totalCost(run), 0);
      const rows = runs
        .map((run) => {
          const { freshTokens, cachedTokens } = tokenTotals(run);
          return `<tr>
            <td><a href="/dashboard/${run.runId}">#${run.issueNumber}</a></td>
            <td>${escapeHtml(run.issueTitle)}</td>
            <td>${run.severity ?? "-"}</td>
            <td>${run.blastRadiusTier ?? "-"}</td>
            <td>${run.status}</td>
            <td>${run.outcome ?? "-"}</td>
            <td>$${totalCost(run).toFixed(4)}</td>
            <td>${formatTime(run.startedAt)}</td>
            <td>${formatTime(run.completedAt)}</td>
            <td>${formatElapsed(run.startedAt, run.completedAt)}</td>
            <td>${formatTokens(freshTokens)}</td>
            <td>${formatTokens(cachedTokens)}</td>
          </tr>`;
        })
        .join("");
      const body = `
        <h1>Bug Triage Runs</h1>
        <p>Total spend: $${totalSpend.toFixed(4)} of $50.00 budget</p>
        <table>
          <thead><tr><th>Issue</th><th>Title</th><th>Severity</th><th>Blast radius</th>
          <th>Status</th><th>Outcome</th><th>Cost</th><th>Started</th><th>Ended</th>
          <th>Elapsed</th><th>Fresh tokens</th><th>Cached tokens</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      return new Response(layout("Bug Triage Runs", body), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }),
    GET("/dashboard/:runId", async (_req, { params }) => {
      const run = await store.getRun(params.runId);
      if (!run) return new Response("Not found", { status: 404 });
      const calls = run.modelCalls
        .map((call) => {
          const fresh = Math.max(0, call.inputTokens - call.cacheReadTokens);
          return `<tr>
            <td>${formatTime(call.at)}</td><td>${call.phase}</td><td>${call.model}</td>
            <td>${call.inputTokens}</td><td>${call.outputTokens}</td>
            <td>${formatTokens(fresh)}</td><td>${formatTokens(call.cacheReadTokens)}</td>
            <td>$${call.costUsd.toFixed(4)}</td>
          </tr>`;
        })
        .join("");
      const { freshTokens, cachedTokens } = tokenTotals(run);
      const stopButton = TERMINAL_STATUSES.includes(run.status)
        ? ""
        : `<form method="post" action="/dashboard/${run.runId}/stop" onsubmit="return confirm('Stop this run now? This cancels the in-flight turn immediately.')">
            <button type="submit" style="background:#c0392b;color:#fff;border:none;padding:0.5rem 1rem;border-radius:4px;cursor:pointer;">Stop this run</button>
          </form>`;
      // No button here calls a route directly: send()/getSession() are scoped to the calling
      // channel, so a route on this (dashboard) channel can never resume a session parked on
      // the github channel — confirmed live (2026-08-21) when that exact approach threw
      // RuntimeNoActiveSessionError for continuationToken "dashboard:" instead of the real
      // github-channel token. The only channel that can legitimately resume this session is the
      // one that owns it, via a real GitHub comment (agent/channels/github.ts's onComment,
      // wired to eve's defaultOnComment) — this panel links there instead of faking a button
      // that can't actually work.
      const approvalPanel =
        run.status === "awaiting_approval" && run.issueNumber > 0
          ? `<div style="margin:1rem 0;padding:1rem;border:1px solid #e0a800;background:#fff8e1;border-radius:4px;">
              <p><strong>Awaiting human approval</strong> — open_pr paused this run (see agent/lib/autonomy.ts's requiresApproval). Review the diff in the latest issue comment, then reply on the issue:</p>
              <p><a href="https://github.com/${escapeHtml(process.env.GITHUB_OWNER ?? "")}/${escapeHtml(
              process.env.GITHUB_REPO ?? "",
            )}/issues/${run.issueNumber}"><code>@bug-triage-agent approve</code></a> or <code>@bug-triage-agent deny</code></p>
            </div>`
          : "";
      const body = `
        <p><a href="/dashboard">&larr; All runs</a></p>
        <h1>#${run.issueNumber}: ${escapeHtml(run.issueTitle)}</h1>
        <p>Status: ${run.status} | Severity: ${run.severity ?? "-"} | Blast radius: ${
        run.blastRadiusTier ?? "-"
      } | Outcome: ${run.outcome ?? "-"}</p>
        <p>${run.prUrl ? `<a href="${escapeHtml(run.prUrl)}">Pull request</a>` : "No PR yet"}</p>
        <p>Started: ${formatTime(run.startedAt)} | Ended: ${formatTime(run.completedAt)} |
        Elapsed: ${formatElapsed(run.startedAt, run.completedAt)}</p>
        <p>Total cost: $${totalCost(run).toFixed(4)} | Fresh tokens: ${formatTokens(
        freshTokens,
      )} | Cached tokens: ${formatTokens(cachedTokens)}</p>
        ${approvalPanel}
        ${stopButton}
        <h2>Model calls</h2>
        <table>
          <thead><tr><th>At</th><th>Phase</th><th>Model</th><th>In tokens</th>
          <th>Out tokens</th><th>Fresh</th><th>Cached</th><th>Cost</th></tr></thead>
          <tbody>${calls}</tbody>
        </table>`;
      return new Response(layout(`#${run.issueNumber}`, body), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }),
    POST("/dashboard/:runId/stop", async (_req, { params, getSession }) => {
      const session = getSession(params.runId);
      await session.cancel();
      // session.cancel() stops execution but does not itself touch our own run tracking —
      // found live tonight (agent/hooks/run-tracking.ts) when a manually-stopped run sat
      // showing "triaging" on the dashboard indefinitely, looking identical to one still
      // actively working, even though no further cost was accruing. Mark it explicitly rather
      // than leave that same ambiguity for every future manual stop.
      await store
        .updateRun(params.runId, {
          status: "failed",
          outcome: "cancelled",
          completedAt: new Date().toISOString(),
        })
        .catch((err) => {
          console.error(`[dashboard] ✖ marking stopped run failed failed:`, err);
        });
      return Response.redirect(
        new URL(`/dashboard/${params.runId}`, _req.url),
        303,
      );
    }),
    // Temporary operator tooling: retires a GitHub-channel session so its next webhook
    // starts fresh with a new sandbox, rather than trying to resume one whose sandbox
    // snapshot no longer exists. Needed once, after clearing Vercel Sandbox snapshot
    // storage manually invalidated the session backing issue #1 ("Cannot resume sandbox:
    // no snapshot available", 410). Safe to delete once no session needs a manual reset.
    POST("/dashboard/admin/reset-github-session", async (req, { reset }) => {
      if (req.headers.get("x-admin-secret") !== process.env.ADMIN_RESET_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      const repositoryId = url.searchParams.get("repositoryId");
      const issueNumber = url.searchParams.get("issueNumber");
      if (!repositoryId || !issueNumber) {
        return new Response("repositoryId and issueNumber query params required", {
          status: 400,
        });
      }
      // Continuation-token format for a GitHub "issue" conversation, read directly out of
      // eve's compiled githubContinuationToken() (public/channels/github/inbound.js). Not
      // part of eve's public export surface, so reproduced rather than imported — reverify
      // against the installed eve version before reusing this route after an eve upgrade.
      const continuationToken = `repo:${repositoryId}:issue:${issueNumber}`;
      const result = await reset({
        continuationToken,
        reason: "manual reset after sandbox snapshot storage cleanup",
      });
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    }),
  ],
});
