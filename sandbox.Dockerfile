# Sandbox image for the bug-triage agent.
#
# eve's published runtime image (ghcr.io/vercel/eve) ships git, node and pnpm, which covers the
# frontend half of Vikunja — but it has no Go toolchain. That is not a cosmetic gap: phase 2 of
# agent/instructions.md requires the agent to write a failing Go test and run it with
# `mage test:filter`, and phase 2 is gated on that test reproducing the bug. Without Go the agent
# reaches classify_severity and stops, so assess_blast_radius and open_pr are unreachable for any
# backend bug. A live run confirmed it: `which go` returned exit 127.
#
# Installing Go in the sandbox bootstrap instead would re-download ~80MB on every session; baking
# it into the image pays that once.
#
# Build:  docker build -f sandbox.Dockerfile -t bug-triage-sandbox:latest .
FROM ghcr.io/vercel/eve:latest

# Matches the `go 1.26.4` directive in Vikunja's go.mod. TARGETARCH is supplied by buildkit, so
# this builds correctly on both arm64 (Apple Silicon) and amd64 hosts.
ARG GO_VERSION=1.26.4
ARG TARGETARCH

USER root
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" -o /tmp/go.tgz; \
    rm -rf /usr/local/go; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm /tmp/go.tgz

ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"
ENV GOPATH="/root/go"
ENV GOTOOLCHAIN=local

# Vikunja drives its build and test targets through mage (github.com/magefile/mage v1.17.2), which
# instructions.md invokes directly as `mage test:filter <TestName>`.
RUN go install github.com/magefile/mage@v1.17.2

# Vikunja's test suite hard-requires CGO: go-sqlite3 is a cgo package, and without a C
# compiler Go silently builds its stub, so EVERY `go test` / `mage test:*` invocation fails
# with "go-sqlite3 requires cgo to work. This is a stub" — the repro test can neither fail
# meaningfully nor ever pass, so the agent iterates in the fix loop until its budget dies
# without ever reaching open_pr (observed as runs stuck in "fixing"; matches the 3/3
# wasted-run pattern). gcc + libc headers make cgo real; CGO_ENABLED=1 pins it on
# explicitly so a stray env default can never silently reintroduce the stub.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gcc libc6-dev; \
    rm -rf /var/lib/apt/lists/*
ENV CGO_ENABLED=1

RUN go version && mage --version
