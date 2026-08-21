import { defineSandbox } from "eve/sandbox";
import { defaultBackend } from "eve/sandbox";

// Two jobs, in order.
//
// 1. Mark /workspace as a git safe.directory. This fixes a real deploy-time failure found via
//    live testing: eve's own checkout fails with "detected dubious ownership in repository at
//    '/workspace'" because the sandbox volume's UID doesn't match the process UID. It has to
//    happen before the GitHub channel's first checkout runs.
//
// 2. Populate /workspace *only outside Vercel*. `onSession` fires when the sandbox SESSION
//    opens, before any TURN starts — the GitHub channel's own authenticated checkout (Eve's
//    `checkoutRepositoryForTurn`, called from its `turn.started` handler) runs strictly later.
//    An earlier version of this file gated on "/workspace is empty," reasoning that would be a
//    no-op once the channel had already checked out — but /workspace is *always* empty at
//    onSession time regardless of channel, since the channel's checkout hasn't run yet. That
//    guard never actually protected anything on a GitHub-triggered run: this code would clone
//    unauthenticated into /workspace first, and the channel's own checkout would then run
//    against a directory it didn't create, with a remote it doesn't control — precisely the
//    dual-checkout conflict the original Task 6 correction note warned about, just introduced
//    by fixing the wrong condition. Gating on `!process.env.VERCEL` instead is correct because
//    it names the actual distinguishing fact: only a non-Vercel invocation (`eve invoke`,
//    `eve dev`, an eval) has no channel to do this at all. That was not hypothetical — the
//    first successful local run spelunked an empty /workspace, `git log` exiting 128, before
//    this existed.
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

    if (process.env.VERCEL) {
      // On Vercel the GitHub channel owns /workspace entirely — nothing to do here. Cloning
      // now would race its later, authenticated checkout against a directory this code
      // populated first with the wrong remote.
      return;
    }

    // Local-only: no channel means nothing else will ever populate /workspace. `git clone`
    // refuses a non-empty target, so this stays safe to retry across repeated `eve invoke`
    // calls against the same sandbox. A shallow clone keeps a cold start to seconds; the
    // agent only ever reads history one commit deep.
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
