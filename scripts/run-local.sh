#!/bin/bash
# Run the agent on this machine instead of on Vercel.
#
# Why this exists: eve's defaultSandbox picks a backend by availability —
# Vercel Sandbox only when process.env.VERCEL is set, then Docker, then
# microsandbox, then just-bash. Running locally with Docker present means the
# agent gets a real container with real git/go/pnpm, and never touches Vercel
# Sandbox or the AI Gateway. That sidesteps both paid gates.
#
# Usage:  ./scripts/run-local.sh dev             # dev server + TUI
#         ./scripts/run-local.sh invoke "..."    # one-shot, no UI
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_BIN="$HOME/.nvm/versions/node/v24.19.0/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "Node 24 not found at $NODE_BIN"
  echo "eve requires Node >=24. Install with: nvm install 24"
  exit 1
fi

if [ ! -f .env.local ]; then
  echo "Missing .env.local — run: vercel env pull --yes"
  exit 1
fi

# Load .env.local into the environment (handles quoted values and '=' in values).
set -a
# shellcheck disable=SC1091
. ./.env.local
set +a

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  cat <<'EOF'
ANTHROPIC_API_KEY is not set locally.

It is marked Sensitive in Vercel (Production/Preview only), so `vercel env pull`
deliberately cannot retrieve it. Add it to .env.local yourself:

    echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local

.env.local is gitignored, so it will not be committed.
EOF
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable — start Docker Desktop."
  echo "Without it eve falls back to just-bash, which has no real git/go/pnpm."
  exit 1
fi

echo "node    $($NODE_BIN --version)"
echo "docker  reachable"
echo "sandbox backend: docker (VERCEL unset, so Vercel Sandbox is skipped)"
echo

CMD="${1:-dev}"
shift || true
exec "$NODE_BIN" node_modules/eve/bin/eve.js "$CMD" "$@"
