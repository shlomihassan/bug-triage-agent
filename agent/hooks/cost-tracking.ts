import { defineHook } from "eve/hooks";
import { createRedisStore, type ModelCallRecord } from "../lib/store";

export interface StepCompletedLike {
  readonly data: {
    readonly usage?: {
      readonly costUsd?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    };
  };
}

export function extractCostRecord(
  event: StepCompletedLike,
  phase: ModelCallRecord["phase"],
  model: string,
): ModelCallRecord | null {
  const usage = event.data.usage;
  if (!usage) return null;
  return {
    phase,
    model,
    costUsd: usage.costUsd ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    at: new Date().toISOString(),
  };
}

const store = createRedisStore();

export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      const record = extractCostRecord(event, "fix", "claude-sonnet-5");
      if (!record) return;
      // ctx.session.id is used as the runId elsewhere (see agent/channels/github.ts, Task 15) —
      // the primary agent-loop model calls (reproduction + fix-writing) are attributed to "fix"
      // here; classify_severity/assess_blast_radius/escalate_to_opus record their own direct
      // AI SDK calls explicitly (see Tasks 10, 11, 12), since those bypass eve's model step
      // entirely and never emit step.completed.
      await store.recordModelCall(ctx.session.id, record).catch(() => {
        // The run row is created lazily by classify_severity's first tool call (Task 10), since
        // that's the earliest point both ctx.session.id and the issue's number/title are known
        // together (see the BugRunStore.createRun note in Task 8). A step.completed firing before
        // that first tool call — the model's initial reasoning, or a local dev chat session with
        // no run at all — has nothing to record against yet; dropping it here is acceptable, since
        // it is never the only place a call's cost is observable, eve's own usage accounting still
        // holds it.
      });
    },
  },
});
