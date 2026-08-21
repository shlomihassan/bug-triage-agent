import { defineChannel, GET, POST } from "eve/channels";
import { createRedisStore, type BugRun } from "../lib/store";

const TERMINAL_STATUSES: BugRun["status"][] = ["pr_opened", "failed"];

const store = createRedisStore();

function totalCost(run: BugRun): number {
  return run.modelCalls.reduce((sum, call) => sum + call.costUsd, 0);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
        .map(
          (run) => `<tr>
            <td><a href="/dashboard/${run.runId}">#${run.issueNumber}</a></td>
            <td>${escapeHtml(run.issueTitle)}</td>
            <td>${run.severity ?? "-"}</td>
            <td>${run.blastRadiusTier ?? "-"}</td>
            <td>${run.status}</td>
            <td>${run.outcome ?? "-"}</td>
            <td>$${totalCost(run).toFixed(4)}</td>
          </tr>`,
        )
        .join("");
      const body = `
        <h1>Bug Triage Runs</h1>
        <p>Total spend: $${totalSpend.toFixed(4)} of $50.00 budget</p>
        <table>
          <thead><tr><th>Issue</th><th>Title</th><th>Severity</th><th>Blast radius</th>
          <th>Status</th><th>Outcome</th><th>Cost</th></tr></thead>
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
        .map(
          (call) => `<tr>
            <td>${call.at}</td><td>${call.phase}</td><td>${call.model}</td>
            <td>${call.inputTokens}</td><td>${call.outputTokens}</td>
            <td>$${call.costUsd.toFixed(4)}</td>
          </tr>`,
        )
        .join("");
      const stopButton = TERMINAL_STATUSES.includes(run.status)
        ? ""
        : `<form method="post" action="/dashboard/${run.runId}/stop" onsubmit="return confirm('Stop this run now? This cancels the in-flight turn immediately.')">
            <button type="submit" style="background:#c0392b;color:#fff;border:none;padding:0.5rem 1rem;border-radius:4px;cursor:pointer;">Stop this run</button>
          </form>`;
      const body = `
        <p><a href="/dashboard">&larr; All runs</a></p>
        <h1>#${run.issueNumber}: ${escapeHtml(run.issueTitle)}</h1>
        <p>Status: ${run.status} | Severity: ${run.severity ?? "-"} | Blast radius: ${
        run.blastRadiusTier ?? "-"
      } | Outcome: ${run.outcome ?? "-"}</p>
        <p>${run.prUrl ? `<a href="${escapeHtml(run.prUrl)}">Pull request</a>` : "No PR yet"}</p>
        <p>Total cost: $${totalCost(run).toFixed(4)}</p>
        ${stopButton}
        <h2>Model calls</h2>
        <table>
          <thead><tr><th>At</th><th>Phase</th><th>Model</th><th>In tokens</th>
          <th>Out tokens</th><th>Cost</th></tr></thead>
          <tbody>${calls}</tbody>
        </table>`;
      return new Response(layout(`#${run.issueNumber}`, body), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }),
    POST("/dashboard/:runId/stop", async (_req, { params, getSession }) => {
      const session = getSession(params.runId);
      await session.cancel();
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
