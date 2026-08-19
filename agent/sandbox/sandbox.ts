import { defineSandbox } from "eve/sandbox";

// This does NOT clone the repo itself — eve's GitHub channel (agent/channels/github.ts)
// already does that automatically, authenticated, on every turn (see the Task 6 correction
// note in docs/superpowers/plans/2026-08-19-agentic-bug-triage.md for why a second custom
// clone here would be wrong). This exists only to fix a real deploy-time failure discovered
// via live testing: eve's own checkout fails with "detected dubious ownership in repository
// at '/workspace'" because the sandbox volume's UID doesn't match the process UID. Marking
// /workspace as a safe.directory once per session, before the channel's first checkout runs,
// resolves it.
export default defineSandbox({
  async onSession({ use }) {
    const sandbox = await use();
    await sandbox.run({ command: "git config --global --add safe.directory /workspace" });
  },
});
