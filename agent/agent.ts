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
// dashboard, to one still actively working.
//
// Raised again, much further (2026-08-21, third pass): 25 minutes silently killed a run that
// was correctly PAUSED waiting on a human to approve a high-blast-radius fix (open_pr's
// requiresApproval gate, agent/lib/autonomy.ts) — confirmed live via `vercel agent-runs inspect`
// showing Status: Completed, Duration: 25m, with the run's last events being a plain timeout
// disposal, not an approval response. eve enforces sessionTimeoutMs as a flat wall-clock
// deadline from session start (docs/concepts/sessions-runs-and-streaming.md: "Sessions last 30
// days by default"), with no distinction between actively-executing time and time spent idle
// waiting on a human — so any approval-gated fix was guaranteed to die before a human could
// realistically review and respond, silently, with no way to recover the paused session
// afterward (its continuationToken has no active session left to resume against). A session
// idle on a pending approval accrues no further cost (no model calls happen while waiting), so
// extending this is safe — the real spend guard is now run-tracking.ts's cost cap alone (see
// its own comment on why the old proactive time-based kill was removed), not this ceiling. This
// exists only as an absolute backstop for a session that hangs without ever completing a step
// at all. 24 hours is a realistic upper bound for a human to notice and act on a pending
// approval; still finite, unlike disabling it outright (`false`), because there's no other
// backstop for a session that never advances at all (a cost cap can't catch zero-cost hangs).
export const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Cost analysis (2026-08-21, run #16 real data): 49 model calls, 2,507,396 total input tokens,
// $5.13, and 99.98% of that cost was input tokens, not output. Per-call input tokens grew
// ~1,315/call, from 11,525 to 74,665 — the whole conversation is resent on every step, so cost
// grows worse than linearly with call count. eve already ships a fix for exactly this
// (harness/compaction.js: summarizes older turns into a checkpoint once the live conversation
// crosses thresholdPercent of the model's context window) but it never fired all night: eve's
// default is 0.9 (90% of Sonnet's ~200K window, ~180K tokens) and no run's live conversation
// got anywhere near that — #16's largest call was 74,665 tokens, ~37% of the window. Lowering
// the threshold makes compaction actually engage during a normal-length session instead of only
// protecting against genuinely runaway ones.
export default defineAgent({
  model: anthropic("claude-sonnet-5"),
  limits: {
    maxInputTokensPerSession: 2_500_000,
    maxOutputTokensPerSession: 500_000,
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
  },
  compaction: {
    thresholdPercent: 0.2,
  },
});
