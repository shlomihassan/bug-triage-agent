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

// Matches sandbox.Dockerfile's GO_VERSION — Vikunja's go.mod pins `go 1.26.4`.
const GO_VERSION = "1.26.4";

// Every process the agent starts in the Vercel sandbox needs these on PATH/in env, since there
// is no Dockerfile ENV layer to fall back on there (see the `bootstrap` comment below). Standard
// system dirs are included because this *replaces* the default PATH rather than extending it —
// `env` on the Vercel backend sets exact values, it doesn't append.
const VERCEL_SANDBOX_ENV = {
  PATH: "/usr/local/go/bin:/root/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  GOPATH: "/root/go",
  GOTOOLCHAIN: "local",
  CGO_ENABLED: "1",
};

export default defineSandbox({
  // defaultBackend keeps eve's availability chain intact — Vercel Sandbox when deployed, Docker
  // locally — while pointing the Docker arm at an image that actually has the Go toolchain.
  // eve's stock image (ghcr.io/vercel/eve) ships git/node/pnpm but no go and no mage, so a live
  // run hit `which go` → exit 127 and could never satisfy phase 2's "reproduce with a failing Go
  // test" gate. Build it with:
  //   docker build -f sandbox.Dockerfile -t bug-triage-sandbox:latest .
  // The Vercel arm gets the same packages installed at bootstrap time instead (see below) since
  // it cannot boot from a custom image at all — eve's Vercel backend always boots its own
  // published runtime image (`runtime` is deliberately excluded from VercelSandboxCreateOptions).
  backend: defaultBackend({
    docker: { image: process.env.SANDBOX_IMAGE ?? "bug-triage-sandbox:latest" },
    vercel: { env: VERCEL_SANDBOX_ENV },
  }),
  // Template-scoped: runs once when eve builds the Vercel sandbox template, and the resulting
  // snapshot seeds every later session — so this cost (an ~80MB Go download, an apt-get) is paid
  // once, not per session. Gated to Vercel only: the Docker arm already has Go/mage/gcc baked
  // into bug-triage-sandbox:latest via sandbox.Dockerfile, so re-running this there would just
  // slow down every local template build for no benefit.
  //
  // This closes a gap that predates this comment: an earlier fix (see the Docker image note
  // above) added Go only to the custom Docker image and left "the Vercel arm at its default" —
  // which silently meant *production* (Vercel-hosted runs, e.g. real GitHub-triggered issues)
  // never got a Go toolchain at all. A live run against a backend bug (auth/permission fix,
  // requires a Go repro test) sat in "fixing" for 15+ minutes with sparse, unproductive model
  // calls and no forward progress — consistent with the agent fighting a sandbox that has no
  // `go` binary rather than a hung process. Installing gcc/libc6-dev alongside Go (not just Go
  // alone) matters too: Vikunja's go-sqlite3 dependency is a cgo package, and without a C
  // compiler Go silently builds a stub instead of erroring, so even a repro test that gets past
  // `which go` can never meaningfully fail or pass. CGO_ENABLED=1 in VERCEL_SANDBOX_ENV pins
  // that on explicitly.
  async bootstrap({ use }) {
    if (!process.env.VERCEL) return;
    const sandbox = await use();
    const install = await sandbox.run({
      command: [
        "apt-get update",
        "apt-get install -y --no-install-recommends gcc libc6-dev curl",
        "rm -rf /var/lib/apt/lists/*",
        `arch=$(dpkg --print-architecture)`,
        `curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-\${arch}.tar.gz" -o /tmp/go.tgz`,
        "rm -rf /usr/local/go",
        "tar -C /usr/local -xzf /tmp/go.tgz",
        "rm /tmp/go.tgz",
        "/usr/local/go/bin/go install github.com/magefile/mage@v1.17.2",
        "/usr/local/go/bin/go version",
        "/root/go/bin/mage --version",
      ].join(" && "),
    });
    console.log(`[sandbox] bootstrap (Vercel Go/mage/gcc install):\n${install.stdout ?? ""}`);
  },
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
