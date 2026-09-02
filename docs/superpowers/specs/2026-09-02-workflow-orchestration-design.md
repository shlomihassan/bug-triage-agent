# Workflow Orchestration & Pre-Deploy Evals Design

**Goal:** Replace the current single-prompt "trust the model to follow Phase 1/2/3 in order"
control flow with explicit, code-enforced sequencing via a Vercel Workflow — closing the class of
stuck-run/silent-failure bugs already logged in `agent.ts`'s `SESSION_TIMEOUT_MS` history (timeout
kills that don't reach `session.completed`/`session.failed` hooks, runs that show "Completed" on
the dashboard while actually having been force-killed mid-work) — and add a pre-deploy eval gate
(Eve evals) built from a small, manually-labeled dataset of historical issues. **Ax /
prompt-optimization is explicitly out of scope for this design** — deferred to a separate design
once real production data justifies it.

**Architecture:** One continuous Eve session per issue, exactly as today — `/workspace`'s sandbox
filesystem persists across turns within a session but is not confirmed to persist across separate
sessions, so splitting phases into separate Eve sessions was considered and rejected. A new Vercel
Workflow (`workflows/bug-triage-workflow.ts`) becomes the sole owner of phase sequencing: it sends
the one long-lived session a scoped turn per phase (via per-step `defineInstructions` plus
tool-gating — only the tools relevant to that phase are exposed), enforces the "3 attempts before
`escalate_to_opus`" counter in code instead of trusting the model to count, and guarantees
`append_note` fires on every exit path (success, `report_could_not_reproduce`, or after
escalation) instead of relying on the model to remember it on every branch.

The existing human-approval mechanism (`open_pr`'s `pendingPr` park in Redis, resolved later by a
plain REST call to `resolvePendingPr()`, entirely outside any agent session) is **preserved exactly
as-is** — see "Why not a Workflow approval hook" below.

**Tech stack:** `workflow` (Vercel Workflows SDK — `'use workflow'` / `'use step'`), the existing
`eve` session/tool APIs, the existing Redis store (`agent/lib/store.ts`), Eve's built-in `evals/`
test runner (`eve eval`).

## Global Constraints

- No change to the sandbox/session model: one Eve session per issue, unchanged.
- No change to the human-approval mechanism (`pendingPr` / `resolvePendingPr` / the dashboard and
  Slack resolution surfaces) — untouched by this design.
- Ax / prompt optimization and Langfuse online evaluation are out of scope — not referenced by any
  component here; both are candidates for a later, separate design.
- `instructions.md` keeps identity + hard safety constraints ("never push/merge/rebase/checkout
  `main`") as always-on text — defense-in-depth alongside the code-level enforcement below, not a
  replacement for it. Phase-specific guidance moves out of `instructions.md` into per-step
  `defineInstructions` content owned by the Workflow.

## Why not a Workflow approval hook

The original plan for this design used a Vercel Workflow `hook` (a durable, resumable pause) to
wait for human approval on high-blast-radius fixes, instead of the current Redis-park pattern.
This was rejected after reading `agent/tools/open_pr.ts`'s existing comment:

> "Deliberately NOT eve's `approval:` HITL gate... pausing the session and waiting for it to be
> resumed turned out to be architecturally unreachable from our own dashboard. Parking the PR
> request in Redis and letting this turn finish normally means the human decision is a plain REST
> call from the dashboard later, not a resumed agent session."

A Workflow-level hook would reintroduce the same shape of problem one layer up: pausing durable
state and expecting an external surface (dashboard, Slack) to correctly resume it. Nothing in this
design has verified that Vercel Workflow hooks resume correctly when triggered from an arbitrary
external REST caller the way Eve's session-resume did not — and the team has already spent real
effort discovering that failure mode once, at the session layer. Rather than repeat that
experiment at the Workflow layer without first validating it works, this design treats
`solveStep` returning `awaiting_approval` as a **normal terminal state** for that workflow run,
identical to how the Eve session already treats it today. The later human decision continues to be
a plain REST call against Redis, untouched by the Workflow.

## Components

1. **`workflows/bug-triage-workflow.ts`** (new) — owns phase sequencing: `triageStep` →
   (branch on `reproFailed`) → `solveStep` (retry loop, max 3 attempts, real counter) →
   `prStep` → `appendNoteStep` (always, on every exit path).
2. **`agent/tools/create_branch.ts`** (new) — wraps `git checkout -b fix/issue-<number>`,
   replacing the raw git command currently written as prose in `instructions.md`.
3. **`agent/tools/commit_and_push.ts`** (new) — wraps `git add -A && git commit -m ... && git
   push origin fix/issue-<number>`, same rationale as above.
4. **`agent/tools/run_checks.ts`** (new) — wraps the five check commands (`mage lint`, `mage
   test:web`/`test:feature`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`) in a fixed order,
   returning a structured pass/fail per check instead of relying on the model to run all five
   correctly, in the right directory, every time.
5. **Duplicate-query guard for `web_search`** — **open item, needs verification before
   implementation**: `web_search` does not appear among this repo's `agent/tools/*.ts` files, so
   it is presumably an Eve framework-default sandbox tool (like `bash`/`read_file`/`write_file`)
   rather than one defined here. Wrapping a framework-default tool's call pattern (to track and
   block near-duplicate queries) may require a `defineHook` on tool-call events rather than
   editing a tool file directly — this needs confirming against Eve's actual hook API before
   committing to an approach.
6. **`agent/tools/open_pr.ts`** (modified) — drop `severity` and `blastRadiusTier` from
   `openPrInputSchema`; `execute()` reads them from `store.getRun(ctx.session.id)` instead
   (already written by `classify_severity`/`assess_blast_radius` earlier in the same run). Removes
   the tool description's "provide these fields honestly" instruction, which becomes unnecessary
   once the model no longer supplies them.
7. **`agent/instructions.md`** (trimmed) — reduced to agent identity and the hard safety
   constraints only; phase-specific content (triage guidance, solve guidance) moves to the
   Workflow's per-step `defineInstructions`.
8. **`evals/`** (new) — Eve eval files implementing the gate/soft metrics below.
9. **A small manually-labeled dataset** (new, e.g. `evals/fixtures/labeled-issues.json`) — 10-20
   historical issues, each with `expectedSeverity`, a one-sentence `referenceRootCause`, and
   `expectedOutcome` (`auto_resolved` | `awaiting_approval`). Built by hand; no existing labeled
   data currently exists in this project (confirmed during design discussion).

## Eval metrics

| # | Check | Type | Data needed |
|---|---|---|---|
| 1 | `read_notes` called first | Gate | none |
| 2 | `search_codebase_semantic` called before any `grep`/`glob` | Gate | none |
| 3 | `classify_severity` called exactly once, correct `issueNumber` | Gate | none |
| 4 | No git command ever targets `main` | Gate | none |
| 5 | High-blast-radius case → `open_pr` returns `awaiting_approval`, not a `prUrl` | Gate | `expectedOutcome` |
| 6 | Low-risk case → `open_pr` returns a real `prUrl` | Gate | `expectedOutcome` |
| 7 | Total run cost stays under a fixed ceiling (e.g. $3), via existing `totalCost()` | Gate | none |
| 8 | Severity classification accuracy | Soft | `expectedSeverity` |
| 9 | Root-cause explanation quality (LLM-judge) | Soft | `referenceRootCause` |

Checks 1-4 and 7 require no labeled data and can be implemented immediately. Checks 5-6 need only
the `expectedOutcome` label. Checks 8-9 need the full labeled dataset.

## Data flow — one run, start to end

1. GitHub webhook → `agent/channels/github.ts` starts `bugTriageWorkflow(issue)`.
2. `triageStep`: sends the Eve session a turn scoped to `read_notes`, `search_codebase_semantic`,
   `classify_severity` only, with `defineInstructions` covering triage guidance. Returns
   `{ severity, rootCause, reproFailed, factLearned }`.
3. If `reproFailed` is false: `appendNoteStep` runs, workflow ends (`status: no-repro`).
4. Otherwise, `solveStep` runs in a loop, attempt 1 through 3: scoped to `create_branch`,
   `edit_file`/sandbox tools, `run_checks`, `query_code_graph`, `assess_blast_radius`,
   `commit_and_push`. On attempt 3 without success, calls `escalate_to_opus` itself (workflow-side
   counter, not the model's own count) before the final attempt.
5. `prStep`: calls `open_pr` (modified). If the result is `awaiting_approval`, the workflow ends
   there — that is a normal terminal state, not a pause (see "Why not a Workflow approval hook").
   If a `prUrl` came back, proceeds to step 6.
6. `appendNoteStep` runs on every path — success, no-repro, or awaiting-approval — before the
   workflow ends.

## Error handling

- `run_checks` returns structured per-check results; `solveStep`'s retry loop reads these directly
  rather than parsing raw shell output.
- The attempt counter for `escalate_to_opus` lives in the workflow step's own loop variable — it
  cannot be skipped or miscounted by the model, unlike the current prose instruction ("do not call
  before 3 genuine attempts").
- `appendNoteStep`'s guaranteed placement (after every branch, before the workflow returns) removes
  the current failure mode where a model exits early (e.g. via `report_could_not_reproduce`) and
  forgets to also call `append_note`.
- No change to existing error handling in `open_pr`, `classify_severity`, or the Redis store —
  their existing best-effort `.catch()` logging patterns are preserved.

## Testing

- The eval suite (metrics 1-9 above) becomes the acceptance criteria for this redesign itself, not
  only for future changes: replay the labeled dataset through the new Workflow-based pipeline and
  confirm gates 1-7 pass and soft scores 8-9 are no worse than a baseline run through the current
  (pre-redesign) pipeline on the same issues, before removing the old code path.
- Unit test the retry-counter logic and `appendNoteStep`'s guaranteed-call behavior directly,
  independent of a full Eve session (mirrors the existing `open-pr-approval.test.ts` pattern of
  testing extracted logic in isolation).

## Explicitly out of scope

- Ax / prompt optimization for `classify_severity` or any other judgment tool — deferred; those
  tools are unchanged by this design and remain suitable candidates for optimization later.
- Langfuse online evaluation (LLM-as-judge scoring of live production traces) — a valuable
  complement to the pre-deploy eval gate here, but a separate, additive piece of work.
- Any change to the Slack/dashboard approval-resolution surfaces.
