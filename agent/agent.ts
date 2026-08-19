import { defineAgent } from "eve";
import { anthropic } from "@ai-sdk/anthropic";

// Guardrail added after a real incident: a session with no limits ran ~40 unbounded Sonnet
// steps (~$4-6 real spend) without converging or hitting any cap, because eve's own defaults
// (40,000,000 input tokens, 30-day timeout) are sized for a much larger class of agent than a
// single bug-fix task. These numbers target a hard ceiling of roughly $3 per session at
// Sonnet 5's verified rate ($2/$10 per million input/output tokens, platform.claude.com/docs
// pricing, checked 2026-08-20): 750,000 input tokens (~$1.50) + 150,000 output tokens (~$1.50).
// A well-converging run should use a fraction of this; it's a backstop, not a target.
export default defineAgent({
  model: anthropic("claude-sonnet-5"),
  limits: {
    maxInputTokensPerSession: 750_000,
    maxOutputTokensPerSession: 150_000,
    sessionTimeoutMs: 7 * 60 * 1000,
  },
});
