import { defineHook } from "eve/hooks";
import { createRedisStore } from "../lib/store";

const store = createRedisStore();
const TERMINAL_STATUSES = new Set(["pr_opened", "failed", "escalated"]);

// A session that times out (agent.ts's sessionTimeoutMs) or otherwise ends without reaching a
// real terminal state currently shows up on Vercel's own Agent Runs list as "Completed" — not
// "Failed" — because from eve's perspective the session did end cleanly, it just never produced
// a useful result. Confirmed live tonight: every stalled run showed status "Completed" there.
// Without this, our own dashboard would show such a run stuck at "triaging" forever, which reads
// identically to "still actively working" — exactly the ambiguity that cost hours of guessing.
async function markIncompleteIfNeverFinished(sessionId: string): Promise<void> {
  const run = await store.getRun(sessionId).catch(() => null);
  if (!run) return;
  if (TERMINAL_STATUSES.has(run.status)) return;
  await store
    .updateRun(sessionId, {
      status: "failed",
      outcome: "timed_out",
      completedAt: new Date().toISOString(),
    })
    .catch((err) => {
      console.error(`[run-tracking] ✖ marking incomplete run failed failed:`, err);
    });
}

export default defineHook({
  events: {
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
    },
    // Fires on every session end, including a clean timeout — which is exactly the case that
    // needs catching, since "Completed" here does not imply anything useful happened.
    async "session.completed"(_event, ctx) {
      await markIncompleteIfNeverFinished(ctx.session.id);
    },
    async "session.failed"(_event, ctx) {
      await markIncompleteIfNeverFinished(ctx.session.id);
    },
  },
});
