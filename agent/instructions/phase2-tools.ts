// Feature-flagged override for Phase 2 of agent/instructions.md. Flag off (default): this
// resolver returns undefined, contributing nothing — agent/instructions.md's existing raw
// git-command prose applies exactly as it does today, completely unaffected. Flag on: this
// appends override text telling the model to use create_branch/commit_and_push/run_checks
// instead. agent/instructions.md itself is never edited, so flipping the env var back off
// instantly restores the old, currently-running behavior with zero code changes.
import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "session.started": (_event, _ctx) => {
      if (process.env.ENABLE_DETERMINISTIC_PHASE2 !== "true") return undefined;
      return defineInstructions({
        markdown:
          "## Phase 2 override\n\n" +
          "Ignore the raw git commands described for Phase 2 steps 1, 2, and 4 above. Instead:\n" +
          "- Step 1: call `create_branch` with the issue number.\n" +
          '- Step 2: after editing code, call `run_checks` with `scope` set to "backend", ' +
          '"frontend", or "both".\n' +
          "- Step 4: call `commit_and_push` with the branch name and a short description of " +
          "the fix.\n" +
          "- Step 5: you no longer need to report severity/blastRadiusTier to `open_pr` — they " +
          "are read automatically from this run's record.",
      });
    },
  },
});
