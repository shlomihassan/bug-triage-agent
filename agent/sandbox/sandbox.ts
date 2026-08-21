import { defineSandbox } from "eve/sandbox";
import { defaultBackend } from "eve/sandbox";

// Two jobs, in order.
//
// 1. Mark /workspace as a git safe.directory. This fixes a real deploy-time failure found via
//    live testing: eve's own checkout fails with "detected dubious ownership in repository at
//    '/workspace'" because the sandbox volume's UID doesn't match the process UID. It has to
//    happen before the GitHub channel's first checkout runs.
//
// 2. Populate /workspace *only when it is empty*. On a GitHub-triggered turn eve's GitHub
//    channel (agent/channels/github.ts) has already cloned the repo, authenticated — a second
//    unconditional clone here would be wrong, which is what the original Task 6 correction note
//    warned about. But a turn started any other way (`eve invoke`, `eve dev`, an eval) never
//    goes through that channel, so nothing checks the repo out and the agent spends its whole
//    budget spelunking an empty directory. That was not hypothetical: the first successful local
//    run did exactly that, with `git log` exiting 128 against an empty /workspace.
//
//    The emptiness guard is what keeps both paths correct: a no-op when the channel already
//    checked out, a shallow clone when nothing did.
const OWNER = process.env.GITHUB_OWNER ?? "shlomihassan";
const REPO = process.env.GITHUB_REPO ?? "vikunja";

export default defineSandbox({
  // defaultBackend keeps eve's availability chain intact — Vercel Sandbox when deployed, Docker
  // locally — while pointing the Docker arm at an image that actually has the Go toolchain.
  // eve's stock image (ghcr.io/vercel/eve) ships git/node/pnpm but no go and no mage, so a live
  // run hit `which go` → exit 127 and could never satisfy phase 2's "reproduce with a failing Go
  // test" gate. Build it with:
  //   docker build -f sandbox.Dockerfile -t bug-triage-sandbox:latest .
  // The vercel arm is left at its default; on Vercel the published image applies as before.
  backend: defaultBackend({
    docker: { image: process.env.SANDBOX_IMAGE ?? "bug-triage-sandbox:latest" },
  }),
  async onSession({ use }) {
    const sandbox = await use();
    await sandbox.run({ command: "git config --global --add safe.directory /workspace" });

    // `git clone` refuses a non-empty target, so the guard is also what makes this safe to
    // retry. A shallow clone keeps a cold start to seconds rather than minutes; the agent only
    // ever reads history one commit deep.
    const clone = await sandbox.run({
      command:
        `if [ -d /workspace/.git ] || [ -n "$(ls -A /workspace 2>/dev/null)" ]; then ` +
        `echo "workspace-already-populated"; else ` +
        `git clone --depth 1 https://github.com/${OWNER}/${REPO}.git /workspace ` +
        `&& echo "workspace-cloned"; fi`,
    });
    console.log(`[sandbox] /workspace: ${String(clone.stdout ?? "").trim() || "(no output)"}`);
  },
});
