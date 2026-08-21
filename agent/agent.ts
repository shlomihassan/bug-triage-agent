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
// Raised (2026-08-21): the original 7-minute sessionTimeoutMs was cutting off genuinely
// converging runs, not just runaway ones. Every run that night showed the identical 7m
// duration in `vercel agent-runs list` regardless of how much real, useful work it had done —
// the signature of a wall-clock cutoff, not a runaway session. instructions.md's triage phase
// (read prior notes, semantic search, reproduce with a real failing test, then classify) is
// legitimately thorough; one observed run spent its whole 7 minutes correctly cross-referencing
// fixture files to build an accurate repro before ever reaching classify_severity — real,
// convergent work, just not finished in time. Doubled the ceiling in both dimensions rather
// than raising time alone, since either the time or the token backstop could be the actual
// binding constraint and only widening one risks re-hitting the other invisibly.
export default defineAgent({
  model: anthropic("claude-sonnet-5"),
  limits: {
    maxInputTokensPerSession: 1_500_000,
    maxOutputTokensPerSession: 300_000,
    sessionTimeoutMs: 15 * 60 * 1000,
  },
});
