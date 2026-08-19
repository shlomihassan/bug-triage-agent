# Agentic Bug Triage & Resolution — Design

## Purpose

Technical assignment (Director of Engineering, AI role): build an agentic workflow that,
triggered by a GitHub issue on a forked open-source app, reproduces the reported bug, analyzes
root cause, classifies severity, routes it, and — where safe — implements and opens a PR for the
fix, with a clear human escalation path where it isn't safe to act alone.

Evaluation criteria (from the assignment): functionality, autonomy level appropriate to risk,
human-in-the-loop/escalation, measurement, context & memory across bugs, and taste (would a real
developer actually want this running, or mute it after a day).

**Ground rule: this is a blank-repo build.** Two new repos, no shared code, no shared git
history, no shared Vercel project/environment, with any prior related work (MonkeyAgent,
MonkeyReviewer, MonkeyAgentConsole). Those projects are referenced below only as prior-art
patterns — the same way a blog post or a paper would be — never as a starting point to fork,
vendor, or copy from.

## Non-goals

- Not a general-purpose coding agent — scoped to one triggering event shape (a GitHub issue on
  one allowlisted repo) and one output shape (a draft PR or an escalation comment).
- Not an auto-merge system. The agent never merges, never approves, never pushes to a protected
  branch directly.
- No RAG/embeddings/vector store for cross-bug memory — an append-only structured notes log,
  summarized into the prompt, is enough for two seeded bugs and is honest about the actual scale
  needed here.
- No enterprise-grade Console (auth, encrypted-reveal audits, retention crons) — the dashboard is
  a same-app view over the same store the agent already writes to, not a separate service.

## Repo layout

- **`vikunja`** — a real fork of [Vikunja](https://github.com/kolaente/vikunja) (Go backend, Vue
  frontend, Postgres/SQLite) under the candidate's GitHub account, with 2 deliberately-seeded
  bugs committed on top (1 backend, 1 frontend). Exact bugs are chosen once the fork exists and
  the real code layout is visible — see "Bug seeding" below for the selection criteria.
- **`bug-triage-agent`** — a new, blank Eve/Vercel service repo (this repo) containing the
  webhook, triage/solve agent, job store, and dashboard.

## High-level flow

```
GitHub issue opened on `vikunja`
  → HMAC-verified webhook (pattern: MonkeyReviewer's github-webhook route, adapted from
    `pull_request` to `issues` events, allowlisted to this one repo)
  → bug-triage-agent starts an Eve agent session
    (conversational session, not a stateless pipeline — this workflow needs elicitation/pause,
    so it follows MonkeyAgent's session shape rather than MonkeyReviewer's deterministic
    pipeline)
  → Triage phase (read-only)
  → Solve phase (only if triage reproduced the bug)
  → Draft PR, or an escalation comment + wait for a human signal
```

## Triage phase

Always runs first, read-only against the repo (no commits).

1. **Reproduce.** Read the issue body, locate the relevant code, write a targeted failing test
   that demonstrates the reported bug (a Go test hitting the buggy handler/endpoint for backend
   bugs, a Vitest/component test for frontend bugs). Run it in the sandbox and confirm it
   actually fails on current `main`. If the agent cannot get a failing test to reproduce the
   reported behavior, that is itself a valid triage outcome (see step 4), not a silent dead end.
2. **Root cause.** Read around the failing test's stack trace / implicated code paths; produce a
   short root-cause explanation tied to specific file:line references.
3. **Severity classification.** User-facing impact: `critical` / `high` / `medium` / `low`, with
   a one-line rationale — same shape as MonkeyReviewer's `riskAssessment.tier`/`rationale`
   fields, reused deliberately for schema consistency between the two projects' design language
   (not shared code).
4. **Routing decision.** Post a triage verdict as a GitHub issue comment before any fix is
   attempted: severity, root cause, the failing test as evidence, and whether the agent will
   proceed to the solve phase automatically or is blocked (couldn't reproduce, or the report
   needs human clarification — distinct from the blast-radius escalation path in the solve
   phase).

## Solve phase

Only runs if triage produced a reproducing failing test.

1. **Attempt fix.** Edit code in the sandbox until the repro test passes, then run the full check
   suite (`test`/`lint`/`typecheck`/`build`) to confirm nothing else broke.
2. **Blast-radius assessment.** Same `impact × probability` shape as the triage severity/risk
   model, applied to the fix's diff rather than to the reported bug: does it touch
   auth/permissions, DB migrations, public API contracts, or payment-like code; is it a small,
   isolated diff or does it spread across unrelated files; is it reversible.
3. **Routing decision, with a deterministic override** (pattern: `applyRiskOverride` — a small,
   pure, unit-testable function that runs after the model's own assessment and can force a
   different outcome regardless of what the model concluded):
   - **Auto-open draft PR** when: the repro test now passes, the full check suite is green, the
     diff is small/isolated (default caps: ≤3 files changed, ≤150 changed lines — configurable
     via env, same shape as `MAX_DIFF_BYTES`/`MAX_CHANGED_FILES` elsewhere), and blast radius is
     low/medium.
   - **Forced escalation**, regardless of model confidence, when: blast radius is high
     (auth/migrations/public API), or any check fails, or severity was `critical`, or the agent
     didn't converge on a passing fix within a bounded number of attempts.
4. **Escalation mechanism.** Post a comment on the issue: what was tried, why it's pausing, what
   it needs (approval to proceed, or input on an ambiguous point). Wait for a specific human
   signal (a reply comment or a label) before resuming — the GitHub-native stand-in for Eve's
   Linear `elicitation` activity, since there is no Linear session here. An optional mirrored
   Slack notification sits on top as a visibility nice-to-have, not the primary gate (GitHub has
   to be the source of truth, since that's what's graded; Slack is explicitly optional in the
   assignment).
5. **Delivery.** Draft PR only, never auto-merge. Body includes: issue link, root cause, the
   repro test, verification results, and blast-radius rationale.

## Model routing & cost management

- **Haiku** — severity classification, blast-radius classification, root-cause summarization
  once the failing test + stack trace are already in hand. Cheap, structured, low reasoning
  depth.
- **Sonnet** — the actual code-fix generation and iteration loop; the part that needs real
  reasoning about Go/Vue code.
- **Opus** — reserved; only escalated to if Sonnet fails to converge on a passing fix after 3
  attempts (configurable via env, mirroring `MAX_REPAIR_ATTEMPTS`-style knobs elsewhere). A
  deliberate "spend more only when stuck" step, itself logged as a routing decision.

Every model call is logged: `{jobId, bugId, phase, model, inputTokens, outputTokens, costUsd}`.

## Cross-bug memory

After each triage/solve run (successful or not), append a short structured note to a persistent
"codebase notes" log: file locations, patterns, and gotchas actually discovered (e.g. "auth
checks live in `pkg/web/middleware/auth.go`, not the handler layer"). Every subsequent triage run
loads the accumulated notes into its prompt before starting. No RAG/embeddings — an append-only
log summarized into context is sufficient at this scale, and it's directly demoable: bug #2's
triage can visibly reference what bug #1 taught it.

## Measurement (dashboard)

A `/dashboard` route inside this same app, reading directly from the same durable job store the
agent already writes to — no separate ingestion service, no signed telemetry pipeline (that
pattern exists elsewhere specifically because a separate deployment receives events from a
different app over the network; not needed when the dashboard and the agent share a trust
boundary). No separate Postgres/ORM stack — extend the existing job-store record shape with the
metrics fields below. Gated by Vercel's own deployment protection rather than a full OAuth flow.

Two views:
- **List** — every bug run: severity, blast radius, outcome (auto-resolved / escalated /
  couldn't-reproduce), resolution time (issue-opened → PR-opened or escalated), cost, running
  total against the $50 budget.
- **Detail** — full triage/solve timeline for one run, the repro test, cost per model call, link
  to the resulting PR or escalation comment.

No retention cron, no pricing-snapshot refresh, no encrypted-reveal audit — those solve "protect
a human's real production secrets over time," which doesn't apply to a demo dashboard holding
only synthetic data about two seeded bugs.

## Bug seeding

Exact bugs are picked once the fork exists and the real code layout is visible, not locked in
here. Selection criteria:
- **Backend (Go):** a logic bug in an API handler with real user-facing impact and a clean
  API-level repro (e.g. a permission/filter check, validation, or pagination bug) — something a
  Go test can catch cleanly.
- **Frontend (Vue):** a bug in a computed property, filter, or event handler causing visibly
  wrong UI state — something a Vitest/component test can catch cleanly.
- Both bugs should be real and plausible (not contrived one-liners), so triage's root-cause
  reasoning has something genuine to work with, and different enough in severity/blast-radius
  that the demo shows the autonomy policy actually branching — e.g. one auto-resolves, one
  escalates. Two bugs that both take the identical path would be a weaker demo of the autonomy
  criterion.

## Testing

- Unit tests for the deterministic override function (both trigger conditions individually, both
  together, neither) — mirrors the existing `applyRiskOverride` test shape.
- Unit tests for cost-logging and model-routing decisions.
- Integration test for the webhook → triage → solve flow against fixture repos/issues, with the
  LLM call faked (network-free), matching the existing e2e pattern used elsewhere: exercise real
  policy/context-assembly/delivery code, fake only the genuinely network-bound steps (LLM calls,
  sandbox check runner).
- Two real end-to-end runs against the actual `vikunja` fork's two seeded bugs, for the video
  walkthrough.
