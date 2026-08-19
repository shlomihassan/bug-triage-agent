import { defineHook } from "eve/hooks";
import { createRedisStore } from "../lib/store";

export interface InputRequestedLike {
  readonly data: {
    readonly requests: readonly {
      readonly kind: "question" | "session-limit" | "tool-approval";
      readonly action?: {
        readonly toolName?: string;
      };
    }[];
  };
}

// True when this input.requested event is asking the human to approve the open_pr tool
// call — the one HITL pause the dashboard needs to surface as "awaiting_approval". Other
// input requests (a plain question, a session-limit prompt, or a tool-approval for some
// other tool) don't change the run's visible status.
export function isOpenPrApprovalRequested(event: InputRequestedLike): boolean {
  return event.data.requests.some(
    (request) => request.kind === "tool-approval" && request.action?.toolName === "open_pr",
  );
}

const store = createRedisStore();

export default defineHook({
  events: {
    async "input.requested"(event, ctx) {
      if (!isOpenPrApprovalRequested(event)) return;
      // ctx.session.id is the runId elsewhere (see agent/hooks/cost-tracking.ts); the run row
      // is created lazily by classify_severity's (or report_could_not_reproduce's) first tool
      // call, so an input.requested event firing before that has nothing to update yet —
      // dropping it here is acceptable for the same reason cost-tracking.ts drops its own.
      await store.updateRun(ctx.session.id, { status: "awaiting_approval" }).catch(() => {});
    },
  },
});
