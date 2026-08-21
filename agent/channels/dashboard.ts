import { defineChannel, GET, POST } from "eve/channels";
import { createRedisStore, totalCost, tokenTotals, type BugRun } from "../lib/store";
import { resolvePendingPr } from "../lib/pr-approval";

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

// Semantic status → pill mapping. "failed"+"cancelled" reads as neutral (an operator choice,
// not a failure); every other "failed" reads as the fail color regardless of which outcome
// string it carries, since the outcome text itself is shown as the pill label.
function statusPill(status: BugRun["status"], outcome: string | undefined): string {
  if (status === "failed" && outcome === "cancelled") {
    return `<span class="pill neutral"><span class="dot"></span>cancelled</span>`;
  }
  if (status === "failed") {
    return `<span class="pill fail"><span class="dot"></span>${escapeHtml(outcome ?? "failed")}</span>`;
  }
  if (status === "awaiting_approval") {
    return `<span class="pill attention"><span class="dot"></span>awaiting approval</span>`;
  }
  if (status === "pr_opened") {
    return `<span class="pill success"><span class="dot"></span>pr opened</span>`;
  }
  if (status === "escalated") {
    return `<span class="pill attention"><span class="dot"></span>escalated</span>`;
  }
  // fixing, triaging
  return `<span class="pill active"><span class="dot"></span>${escapeHtml(status)}</span>`;
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title><style>
    :root {
      --bg: #f3f4f7; --surface: #ffffff; --surface-2: #eceff3;
      --text: #1a1d24; --text-muted: #5c6470; --text-faint: #9aa1ac; --border: #dde1e7;
      --accent: #0f6f75; --accent-soft: #e0f0f0;
      --active: #2563eb; --active-soft: #e3ecfc;
      --attention: #b45309; --attention-soft: #fbf0dd;
      --success: #15803d; --success-soft: #e3f5e9;
      --fail: #b91c1c; --fail-soft: #fbe6e6;
      --neutral: #6b7280; --neutral-soft: #eaecef;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #12151a; --surface: #191d24; --surface-2: #20242c;
        --text: #e8eaef; --text-muted: #99a1b0; --text-faint: #6b7280; --border: #262b34;
        --accent: #5fd6dc; --accent-soft: #17383a;
        --active: #60a5fa; --active-soft: #16233d;
        --attention: #fbbf24; --attention-soft: #3a2c10;
        --success: #4ade80; --success-soft: #163523;
        --fail: #f87171; --fail-soft: #3a1616;
        --neutral: #9aa1ac; --neutral-soft: #262a32;
      }
    }
    :root[data-theme="dark"] {
      --bg: #12151a; --surface: #191d24; --surface-2: #20242c;
      --text: #e8eaef; --text-muted: #99a1b0; --text-faint: #6b7280; --border: #262b34;
      --accent: #5fd6dc; --accent-soft: #17383a;
      --active: #60a5fa; --active-soft: #16233d;
      --attention: #fbbf24; --attention-soft: #3a2c10;
      --success: #4ade80; --success-soft: #163523;
      --fail: #f87171; --fail-soft: #3a1616;
      --neutral: #9aa1ac; --neutral-soft: #262a32;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg); color: var(--text);
      font-family: ui-sans-serif, "Segoe UI", system-ui, -apple-system, sans-serif;
      margin: 0; padding: 32px 24px 80px; font-variant-numeric: tabular-nums;
    }
    .mono { font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace; }
    main { max-width: 1200px; margin: 0 auto; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
    h2 { font-size: 13px; font-family: ui-monospace, monospace; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--text-muted); margin: 24px 0 12px; }
    .subtitle { color: var(--text-muted); font-size: 13.5px; margin: 0 0 20px; }
    .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px;
      margin-bottom: 20px; flex-wrap: wrap; }
    .budget-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 14px 18px; min-width: 260px; }
    .budget-row { display: flex; justify-content: space-between; align-items: baseline;
      font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
    .budget-row strong { color: var(--text); font-family: ui-monospace, monospace; font-size: 13px; }
    .budget-track { height: 7px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
    .budget-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--accent), var(--active)); }
    .table-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      overflow: hidden; margin-bottom: 20px; }
    .table-scroll { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    thead th { text-align: left; font-family: ui-monospace, monospace; font-size: 10.5px;
      text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600;
      padding: 11px 14px; border-bottom: 1px solid var(--border); background: var(--surface-2);
      white-space: nowrap; }
    td { padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap;
      vertical-align: middle; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: var(--surface-2); }
    td.num { font-family: ui-monospace, monospace; text-align: right; }
    td.title { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td.dim { color: var(--text-muted); font-size: 12.5px; }
    td.time { color: var(--text-muted); font-family: ui-monospace, monospace; font-size: 12px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
      padding: 4px 10px; border-radius: 100px; white-space: nowrap; }
    .pill .dot { width: 6px; height: 6px; border-radius: 50%; }
    .pill.active { color: var(--active); background: var(--active-soft); }
    .pill.attention { color: var(--attention); background: var(--attention-soft); }
    .pill.success { color: var(--success); background: var(--success-soft); }
    .pill.fail { color: var(--fail); background: var(--fail-soft); }
    .pill.neutral { color: var(--neutral); background: var(--neutral-soft); }
    .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px;
      margin: 20px 0 8px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 13px 16px; }
    .stat-card .stat-label { font-family: ui-monospace, monospace; font-size: 10.5px;
      text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 6px; }
    .stat-card .stat-value { font-family: ui-monospace, monospace; font-size: 18px; font-weight: 700; }
    .callout { border: 1px solid var(--border); border-left: 3px solid var(--accent);
      background: var(--surface); border-radius: 8px; padding: 12px 16px; margin: 16px 0;
      font-size: 13px; }
    .callout.attention { border-left-color: var(--attention); background: var(--attention-soft); }
    button.btn { border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;
      font-size: 13px; font-weight: 600; color: #fff; }
    button.btn:hover { filter: brightness(0.92); }
    button.btn.danger { background: var(--fail); }
    button.btn.success { background: var(--success); }
    code { font-family: ui-monospace, monospace; font-size: 0.9em; background: var(--surface-2);
      padding: 1px 5px; border-radius: 4px; border: 1px solid var(--border); }
  </style></head><body><main>${body}</main></body></html>`;
}

export default defineChannel({
  routes: [
    GET("/dashboard", async () => {
      const runs = await store.listRuns();
      const totalSpend = runs.reduce((sum, run) => sum + totalCost(run), 0);
      const budgetPct = Math.min(100, (totalSpend / 50) * 100);
      const rows = runs
        .map((run) => {
          const { freshTokens, cachedTokens } = tokenTotals(run);
          return `<tr>
            <td><a class="mono" href="/dashboard/${run.runId}">#${run.issueNumber}</a></td>
            <td class="title">${escapeHtml(run.issueTitle)}</td>
            <td class="dim">${run.severity ?? "-"}</td>
            <td class="dim">${run.blastRadiusTier ?? "-"}</td>
            <td>${statusPill(run.status, run.outcome)}</td>
            <td class="dim">${run.status === "failed" ? "-" : (run.outcome ?? "-")}</td>
            <td class="num">$${totalCost(run).toFixed(4)}</td>
            <td class="time">${formatTime(run.startedAt)}</td>
            <td class="time">${formatTime(run.completedAt)}</td>
            <td class="num">${formatElapsed(run.startedAt, run.completedAt)}</td>
            <td class="num">${formatTokens(freshTokens)}</td>
            <td class="num">${formatTokens(cachedTokens)}</td>
          </tr>`;
        })
        .join("");
      const body = `
        <div class="top">
          <div>
            <h1>Bug Triage Runs</h1>
            <p class="subtitle">${runs.length} runs</p>
          </div>
          <div class="budget-card">
            <div class="budget-row"><span>Spend this session</span><strong>$${totalSpend.toFixed(2)} / $50.00</strong></div>
            <div class="budget-track"><div class="budget-fill" style="width: ${budgetPct.toFixed(1)}%"></div></div>
          </div>
        </div>
        <div class="table-card"><div class="table-scroll">
        <table>
          <thead><tr><th>Issue</th><th>Title</th><th>Severity</th><th>Blast radius</th>
          <th>Status</th><th>Outcome</th><th class="num">Cost</th><th>Started</th><th>Ended</th>
          <th class="num">Elapsed</th><th class="num">Fresh tokens</th><th class="num">Cached tokens</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        </div></div>`;
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
            <td class="time">${formatTime(call.at)}</td><td class="mono">${call.phase}</td><td class="mono">${call.model}</td>
            <td class="num">${call.inputTokens}</td><td class="num">${call.outputTokens}</td>
            <td class="num">${formatTokens(fresh)}</td><td class="num">${formatTokens(call.cacheReadTokens)}</td>
            <td class="num">$${call.costUsd.toFixed(4)}</td>
          </tr>`;
        })
        .join("");
      const { freshTokens, cachedTokens } = tokenTotals(run);
      const stopButton = TERMINAL_STATUSES.includes(run.status)
        ? ""
        : `<form method="post" action="/dashboard/${run.runId}/stop" onsubmit="return confirm('Stop this run now? This cancels the in-flight turn immediately.')">
            <button type="submit" class="btn danger">Stop this run</button>
          </form>`;
      // open_pr.ts parks a high-blast-radius fix (PendingPr, lib/store.ts) instead of asking
      // eve to pause the session for approval — resuming a paused GitHub-channel session from
      // this (dashboard) channel turned out to be architecturally unreachable, confirmed three
      // different ways tonight (2026-08-21): receive() starts an unrelated new session instead
      // of resuming; send() with getSession()'s token throws RuntimeNoActiveSessionError because
      // getSession synthesizes a channel-local "dashboard:..." token; send() with a manually
      // reconstructed *correct* github-format token still throws the same error, because eve
      // prefixes it with the calling channel's own name regardless of the token's content
      // ("dashboard:repo:...", not "repo:..."). Opening a PR needs no live agent session at
      // all — it's just a REST call — so these buttons open/skip it directly via Octokit.
      const pendingPr = run.pendingPr;
      const approvalPanel =
        run.status === "awaiting_approval" && pendingPr
          ? `<div class="callout attention">
              <p style="margin:0 0 6px;"><strong>Awaiting human approval</strong>: ${escapeHtml(pendingPr.title)}</p>
              <p style="margin:0 0 10px;">Branch <code>${escapeHtml(pendingPr.branch)}</code> &rarr; <code>${escapeHtml(
              pendingPr.owner,
            )}/${escapeHtml(pendingPr.repo)}</code>. Review the diff in the latest issue comment before deciding.</p>
              <button type="button" onclick="resolveApproval('${run.runId}','approve')" class="btn success" style="margin-right:0.5rem;">Approve</button>
              <button type="button" onclick="resolveApproval('${run.runId}','deny')" class="btn danger">Deny</button>
              <script>
                async function resolveApproval(runId, decision) {
                  if (!confirm('Really ' + decision + ' this fix?')) return;
                  const secret = prompt('Admin secret:');
                  if (!secret) return;
                  const res = await fetch('/dashboard/admin/resolve-pr/' + runId + '?decision=' + decision, {
                    method: 'POST',
                    headers: { 'x-admin-secret': secret },
                  });
                  if (!res.ok) { alert('Failed: ' + res.status + ' ' + (await res.text())); return; }
                  location.reload();
                }
              </script>
            </div>`
          : "";
      const body = `
        <p><a href="/dashboard">&larr; All runs</a></p>
        <div class="top">
          <div>
            <h1>#${run.issueNumber}: ${escapeHtml(run.issueTitle)}</h1>
            <p class="subtitle">
              ${statusPill(run.status, run.outcome)}
              &nbsp; Severity: <strong class="mono">${run.severity ?? "-"}</strong>
              &nbsp; Blast radius: <strong class="mono">${run.blastRadiusTier ?? "-"}</strong>
              &nbsp; Outcome: <strong class="mono">${run.outcome ?? "-"}</strong>
            </p>
            <p>${run.prUrl ? `<a href="${escapeHtml(run.prUrl)}">Pull request &rarr;</a>` : "No PR yet"}</p>
          </div>
        </div>
        <div class="stat-row">
          <div class="stat-card"><div class="stat-label">Total cost</div><div class="stat-value">$${totalCost(run).toFixed(4)}</div></div>
          <div class="stat-card"><div class="stat-label">Elapsed</div><div class="stat-value">${formatElapsed(run.startedAt, run.completedAt)}</div></div>
          <div class="stat-card"><div class="stat-label">Fresh tokens</div><div class="stat-value">${formatTokens(freshTokens)}</div></div>
          <div class="stat-card"><div class="stat-label">Cached tokens</div><div class="stat-value" style="color:var(--success)">${formatTokens(cachedTokens)}</div></div>
        </div>
        <p class="subtitle">Started ${formatTime(run.startedAt)} &middot; Ended ${formatTime(run.completedAt)}</p>
        ${approvalPanel}
        ${stopButton}
        <h2>Model calls</h2>
        <div class="table-card"><div class="table-scroll">
        <table>
          <thead><tr><th>At</th><th>Phase</th><th>Model</th><th class="num">In tokens</th>
          <th class="num">Out tokens</th><th class="num">Fresh</th><th class="num">Cached</th><th class="num">Cost</th></tr></thead>
          <tbody>${calls}</tbody>
        </table>
        </div></div>`;
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
    // Resolves a run.pendingPr (open_pr.ts's parked high-blast-radius fix, lib/store.ts) —
    // approve opens the real draft PR via Octokit directly, deny just marks the run failed.
    // Neither needs the original agent session alive: opening a PR is a stateless REST call,
    // and denying doesn't require telling the (already-finished) agent turn anything. See the
    // approvalPanel comment on GET /dashboard/:runId for why resuming the session itself isn't
    // viable from this channel.
    POST("/dashboard/admin/resolve-pr/:runId", async (req, { params }) => {
      if (req.headers.get("x-admin-secret") !== process.env.ADMIN_RESET_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      const decision = url.searchParams.get("decision");
      if (decision !== "approve" && decision !== "deny") {
        return new Response("decision=approve|deny query param required", { status: 400 });
      }
      const { Octokit } = await import("@octokit/rest");
      const octokit = new Octokit({ auth: process.env.GITHUB_PR_TOKEN });
      const result = await resolvePendingPr(store, params.runId, decision, octokit);
      if (!result.ok) {
        return new Response(result.reason, { status: 400 });
      }
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    }),
  ],
});
