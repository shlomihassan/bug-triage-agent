import { defineTool } from "eve/tools";
import { z } from "zod";
import { createRedisStore } from "../lib/store";

const store = createRedisStore();

export default defineTool({
  description:
    "Call this and stop, instead of attempting a fix, when you cannot get a failing test to " +
    "reproduce the bug reported in the issue after a reasonable effort. Ends the run — never " +
    "guess at a fix for a bug you couldn't reproduce.",
  inputSchema: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    whatWasTried: z.string().min(1),
  }),
  outputSchema: z.object({ ok: z.literal(true) }),
  async execute({ issueNumber, issueTitle, whatWasTried }, ctx) {
    // Lazily creates the run row exactly like classify_severity (Task 10) does, for the same
    // reason — this can be the very first tool call of a run that never reaches triage's
    // severity step at all.
    await store.createRun({ runId: ctx.session.id, issueNumber, issueTitle }).catch(() => {});
    await store
      .updateRun(ctx.session.id, {
        status: "failed",
        outcome: "could_not_reproduce",
        completedAt: new Date().toISOString(),
      })
      .catch(() => {});
    void whatWasTried; // surfaced in the agent's own reply comment, not stored structurally
    return { ok: true };
  },
});
