// Gate 7 from the spec's eval table: total run cost stays under a fixed ceiling. Cost isn't
// part of Eve's own eval API — it's tracked in our Redis store by run-tracking.ts's hooks, which
// fire for real against the live target this eval drives, so this reads it back the same way
// the dashboard does.
import { defineEval } from "eve/evals";
import { createRedisStore, totalCost } from "../agent/lib/store";

const COST_CEILING_USD = 3.0;
const store = createRedisStore();

const ISSUE_MESSAGE =
  "A user reports: clicking delete on a task attachment sometimes leaves the file record in " +
  "the database even though the file itself is removed. Investigate and fix.";

export default defineEval({
  test: async (t) => {
    const turn = await t.send(ISSUE_MESSAGE);
    t.succeeded().gate();

    const run = await store.getRun(turn.sessionId);
    if (!run) {
      throw new Error(`No run record found in the store for session ${turn.sessionId}`);
    }
    const spend = totalCost(run);
    if (spend >= COST_CEILING_USD) {
      throw new Error(`Run cost $${spend.toFixed(2)} met or exceeded the $${COST_CEILING_USD} ceiling`);
    }
  },
});
