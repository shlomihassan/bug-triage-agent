import { defineHook } from "eve/hooks";
import { createRedisStore, totalCost } from "../lib/store";
import { postToRunThread } from "../lib/slack-notify";

const store = createRedisStore();
const TERMINAL_STATUSES = new Set(["pr_opened", "failed", "escalated"]);

// Real data (2026-08-21): three real GitHub-triggered runs (#14/#16/#17) each spent their full
// time budget — $3.14, $5.13, $5.23 — without ever reaching open_pr. 100% waste, 3/3. A time
// cutoff alone doesn't stop a run that's genuinely still working step-by-step but just never
// converging; this catches that case directly, on spend rather than wall-clock time.
//
// This is now the ONLY proactive stop mechanism — a prior version also killed a run at 90% of
// agent.ts's sessionTimeoutMs, but with cost-tracking.ts's field-name bug fixed and real caching
// confirmed working, cost is the fairer signal: a cache-heavy run doing legitimate work can
// safely run long, while a run burning fresh tokens fast should stop sooner regardless of clock
// time. agent.ts's sessionTimeoutMs (25 min) still exists as eve's own absolute last-resort
// backstop for a session that hangs without ever completing a step at all — but it is no longer
// something this hook proactively races against.
const COST_CAP_USD = 3.0;

// A session that times out (agent.ts's sessionTimeoutMs), exceeds the cost cap, or otherwise
// ends without reaching a real terminal state currently shows up on Vercel's own Agent Runs list
// as "Completed" — not "Failed" — because from eve's perspective the session did end cleanly, it
// just never produced a useful result. Confirmed live tonight: every stalled run showed status
// "Completed" there. Without this, our own dashboard would show such a run stuck at "triaging"
// forever, which reads identically to "still actively working" — exactly the ambiguity that cost
// hours of guessing.
async function markIncompleteIfNeverFinished(
  sessionId: string,
  outcome: "timed_out" | "cost_capped",
): Promise<void> {
  const run = await store.getRun(sessionId).catch(() => null);
  if (!run) return;
  if (TERMINAL_STATUSES.has(run.status)) return;
  await store
    .updateRun(sessionId, {
      status: "failed",
      outcome,
      completedAt: new Date().toISOString(),
    })
    .catch((err) => {
      console.error(`[run-tracking] ✖ marking incomplete run failed failed:`, err);
    });
  await postToRunThread(store, sessionId, {
    text: `⏹️ Run stopped: ${outcome}.`,
  }).catch((err) => console.error(`[run-tracking] ✖ Slack post (outcome) failed:`, err));
}

// Best-effort proactive cancel. Reuses the same session.cancel() path the dashboard's own Stop
// button already calls (agent/channels/dashboard.ts) via a self-HTTP-call, rather than a second,
// unverified way of stopping a session — that route is the one piece of stop functionality
// already proven working live. Deliberately non-fatal: if this fails (network hiccup, cold
// start), markIncompleteIfNeverFinished has already fixed the dashboard's visibility of the
// problem regardless, and eve's own hard kill still lands eventually as the final backstop.
async function requestGracefulCancel(sessionId: string): Promise<void> {
  const host = process.env.VERCEL_URL;
  if (!host) return; // No self-callable URL outside Vercel (e.g. local `eve invoke`).
  await fetch(`https://${host}/dashboard/${sessionId}/stop`, { method: "POST" }).catch((err) => {
    console.error(`[run-tracking] ✖ graceful cancel request failed:`, err);
  });
}

export default defineHook({
  events: {
    // step.completed is known to fire reliably for the duration of a session — it's what has
    // been powering the live cost tracking on /dashboard all night (agent/hooks/cost-tracking.ts)
    // — unlike session.completed/session.failed, which a hard timeout kill does not reliably
    // reach. Checking spend here, on every step, is what actually catches a non-converging run
    // while the session is still alive to be gracefully stopped, instead of only ever finding
    // out about it after an external, unpredictable kill already happened.
    async "step.completed"(_event, ctx) {
      const run = await store.getRun(ctx.session.id).catch(() => null);
      if (!run || TERMINAL_STATUSES.has(run.status)) return;

      const spend = totalCost(run);
      if (spend < COST_CAP_USD) return;
      console.log(
        `[run-tracking] 💸 session ${ctx.session.id} spent $${spend.toFixed(2)} ` +
          `(>= $${COST_CAP_USD.toFixed(2)} cap) — marking failed and requesting cancel`,
      );
      await markIncompleteIfNeverFinished(ctx.session.id, "cost_capped");
      await requestGracefulCancel(ctx.session.id);
    },
    async "session.started"(_event, ctx) {
      // Creates a placeholder row the instant a session starts, so /dashboard shows "something
      // is running" from the first moment instead of nothing at all until classify_severity
      // happens to execute — which can be minutes into a long, legitimately convergent triage,
      // or may never happen if the session times out first. That gap was real: a run watched
      // live tonight spent its whole 15-minute budget correctly cross-referencing fixture files
      // before ever reaching classify_severity, and the dashboard showed nothing the entire
      // time — not even that a run was in flight, let alone that it had timed out.
      //
      // issueNumber/issueTitle aren't known yet at session.started (that event carries only
      // runtime identity, not the parsed message) — classify_severity fills them in for real
      // once it does. createRun's NX semantics mean this is a true no-op on a resumed session
      // that already has a row.
      await store
        .createRun({ runId: ctx.session.id, issueNumber: 0, issueTitle: "(investigating…)" })
        .catch((err) => {
          console.error(`[run-tracking] ✖ eager createRun failed:`, err);
        });
      // Capture the placeholder message's own ts (not just the thread ts postToRunThread already
      // stores) so classify_severity.ts can later edit this exact message in place, per the
      // design's step 2, once the real issue number/title are known.
      const placeholderTs = await postToRunThread(store, ctx.session.id, {
        text: "🔍 Investigating a new issue…",
      }).catch((err) => {
        console.error(`[run-tracking] ✖ Slack post (start) failed:`, err);
        return undefined;
      });
      if (placeholderTs) {
        await store
          .updateRun(ctx.session.id, { slackPlaceholderTs: placeholderTs })
          .catch((err) =>
            console.error(`[run-tracking] ✖ updateRun (slackPlaceholderTs) failed:`, err),
          );
      }
    },
    // Fires on every session end, including a clean timeout — which is exactly the case that
    // needs catching, since "Completed" here does not imply anything useful happened.
    async "session.completed"(_event, ctx) {
      // Reason is unknown at this generic backstop (unlike step.completed's targeted checks
      // above); "timed_out" is the more common real cause in practice, but this is a fallback
      // path, not the primary mechanism — see the module comment on why it isn't fully trusted.
      await markIncompleteIfNeverFinished(ctx.session.id, "timed_out");
    },
    async "session.failed"(_event, ctx) {
      await markIncompleteIfNeverFinished(ctx.session.id, "timed_out");
    },
  },
});
