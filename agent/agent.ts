import { defineAgent } from "eve";
import { anthropic } from "@ai-sdk/anthropic";

// Guardrail added after a real incident: a session with no limits ran ~40 unbounded Sonnet
// steps (~$4-6 real spend) without converging or hitting any cap, because eve's own defaults
// (40,000,000 input tokens, 30-day timeout) are sized for a much larger class of agent than a
// single bug-fix task. These numbers target a hard ceiling of roughly $3 per session at
// Sonnet 5's verified rate ($2/$10 per million input/output tokens, platform.claude.com/docs
// pricing, checked 2026-08-20): 750,000 input tokens (~$1.50) + 150,000 output tokens (~$1.50).
// A well-converging run should use a fraction of this; it's a backstop, not a target.
//
// Raised (2026-08-21, first pass): the original 7-minute sessionTimeoutMs was cutting off
// genuinely converging runs, not just runaway ones. Every run that night showed the identical
// 7m duration in `vercel agent-runs list` regardless of how much real, useful work it had
// done — the signature of a wall-clock cutoff, not a runaway session. instructions.md's triage
// phase (read prior notes, semantic search, reproduce with a real failing test, then classify)
// is legitimately thorough; one observed run spent its whole 7 minutes correctly
// cross-referencing fixture files to build an accurate repro before ever reaching
// classify_severity — real, convergent work, just not finished in time.
//
// Raised again (same day, second pass): 15 minutes was still not enough for phase 2 (build
// environment setup, mage/go test runs, the actual fix, blast-radius assessment) — a live run
// hit the 15-minute wall mid-build. Also discovered the hard way that eve enforces this limit
// through a *separate* sessionTimeoutWorkflow that force-kills the session directly — that kill
// does not reliably reach the application-level session.completed/session.failed hooks (see
// agent/hooks/run-tracking.ts), so a session cut off here can look identical, on our own
// dashboard, to one still actively working. run-tracking.ts's proactive check (on the reliably-
// firing step.completed event, watching elapsed time against SESSION_TIMEOUT_MS) is what
// actually catches this now — extending the ceiling further makes that margin meaningful rather
// than the graceful-mark-off racing the hard kill.
export const SESSION_TIMEOUT_MS = 25 * 60 * 1000;

export default defineAgent({
  model: anthropic("claude-sonnet-5"),
  limits: {
    maxInputTokensPerSession: 2_500_000,
    maxOutputTokensPerSession: 500_000,
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
  },
});
