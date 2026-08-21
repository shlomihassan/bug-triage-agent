import { defineHook } from "eve/hooks";
import { createRedisStore, type ModelCallRecord } from "../lib/store";
import { calculateCostUsd } from "../lib/pricing";
import { SONNET_MODEL_ID } from "../lib/anthropic";

export interface StepCompletedLike {
  readonly data: {
    readonly usage?: {
      readonly costUsd?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      // Real, flat field names — verified empirically, not from a type file: two rounds of
      // static type-reading guessed wrong (usage.inputTokenDetails.cacheReadTokens, then
      // usage.cachedInputTokens/cacheCreationInputTokens), because eve's step.completed usage
      // object doesn't match any of the AI SDK's documented usage types cleanly. Confirmed by
      // adding a raw JSON.stringify(usage) log and running one real turn through `eve dev`
      // locally: the actual payload is flat — {"inputTokens":11745,"outputTokens":4,
      // "cacheReadTokens":0,"cacheWriteTokens":11743}. Caching itself was working in production
      // the whole time (confirmed separately via `vercel agent-runs trace`); only this hook's
      // field path was wrong, so it always priced input at the full uncached rate.
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
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
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  console.log(
    `[cost-tracking] in=${inputTokens} out=${outputTokens} cacheRead=${cacheReadTokens} cacheWrite=${cacheWriteTokens}`,
  );
  return {
    phase,
    model,
    // Confirmed via live testing (real ~19-20K-token steps, $0 cost every time) that eve's own
    // step.completed usage.costUsd is not populated for a direct (non-AI-Gateway) provider
    // model — this agent calls Anthropic directly via agent/agent.ts, so that field is
    // reliably undefined here. Compute cost ourselves from token counts, the same way the
    // direct-call tools (Tasks 10-12) already do, rather than trust a field this configuration
    // never fills in. cacheReadTokens/cacheWriteTokens carry the real cache read/write split, so
    // a session with an active prompt cache (the large, repeated system instructions + tool
    // defs) is priced at the real, cheaper per-token rate instead of treating every input token
    // as a fresh, full-price one.
    costUsd: calculateCostUsd(model, inputTokens, outputTokens, {
      cacheReadTokens,
      cacheWriteTokens,
    }),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    at: new Date().toISOString(),
  };
}

const store = createRedisStore();

export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      const record = extractCostRecord(event, "fix", SONNET_MODEL_ID);
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
        // eve's own usage accounting is a secondary source for this, not the only one.
      });
    },
  },
});
