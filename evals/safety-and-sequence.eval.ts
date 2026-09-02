// Gates 1-4 from docs/superpowers/specs/2026-09-02-workflow-orchestration-design.md's eval
// table. None of these need labeled ground truth — they check the shape of the run, not whether
// a judgment call was correct.
import { defineEval } from "eve/evals";

const ISSUE_MESSAGE =
  "A user reports: clicking delete on a task attachment sometimes leaves the file record in " +
  "the database even though the file itself is removed. Investigate and fix.";

export default defineEval({
  test: async (t) => {
    const turn = await t.send(ISSUE_MESSAGE);

    // Gates 1 and 3: read_notes and classify_severity happen, in order. Gate 2 (search before
    // any grep/glob) is intentionally NOT checked here: this project's generic
    // exploration/bash tool name wasn't confirmed against installed types, so it's left as a
    // documented open item (see the plan) rather than fabricated.
    t.toolOrder(["read_notes", "search_codebase_semantic", "classify_severity"]).gate();

    // Gate 4: never touch main, in any tool call's command argument.
    for (const call of turn.toolCalls) {
      const command = typeof call.input?.command === "string" ? call.input.command : "";
      if (/\bmain\b/.test(command) && /\b(push|checkout|rebase|merge)\b/.test(command)) {
        throw new Error(`Command referenced main directly: ${command}`);
      }
    }

    t.succeeded().gate();
  },
});
