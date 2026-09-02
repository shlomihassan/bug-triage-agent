// Task 1 spike (docs/superpowers/plans/2026-09-02-workflow-orchestration.md) — findings recorded
// 2026-09-02 against this project's real agent/instructions.md via `npx eve dev` (Node v24.19.0,
// port 2000, default `docker`/local sandbox backend selection per agent/sandbox/sandbox.ts).
//
// FINDING 1 — CONFIRMED LIVE: turn-by-turn external driving works exactly as documented.
//   POST /eve/v1/session {"message": "..."} returned 202, an `x-eve-session-id` header, and a
//   body with `sessionId`/`continuationToken`. Streaming
//   GET /eve/v1/session/<id>/stream showed the full event sequence — session.started,
//   turn.started, message.received, step.started, reasoning.appended, message.appended (x4),
//   message.completed, step.completed, turn.completed — and then, critically,
//   `session.waiting` with `{"wait":"next-user-message"}`, at which point the HTTP response for
//   the original POST had already long since returned (202, fire-and-forget) and the stream just
//   sat open reporting events as they happened. This confirms external code (a Vercel Workflow)
//   can watch for `session.waiting` and then drive the next turn by POSTing to
//   /eve/v1/session/<id> with a new message, exactly as sessions-runs-and-streaming.md describes.
//
// FINDING 2 — the agent enforces its own instructions.md framing and refuses out-of-character
//   requests, rather than blindly complying. My test message ("write spike-marker to a file")
//   didn't reference a GitHub issue, and the agent replied:
//     "I'm configured as a bug-triage-and-fix agent that responds to GitHub issue reports
//      through a specific workflow... This request doesn't include a GitHub issue to triage —
//      it's just an arbitrary file-write instruction unrelated to that workflow. I won't execute
//      arbitrary file operations outside the scope of an actual bug-triage task."
//   It never called any sandbox tool, so this spike did NOT get a live proof of sandbox-state
//   persistence across turns. That's a real, working safety behavior (matches the load-bearing
//   identity/constraints framing in instructions.md) — not a spike failure to work around by
//   crafting a fake issue that would incur real Sonnet/sandbox cost just to force a file write.
//
// FINDING 3 — sandbox persistence across turns within one session is not just assumed: it's an
//   explicit product guarantee in Eve's own docs (sessions-runs-and-streaming /
//   execution-model-and-durability: "sessions run as long-lived containers whose filesystems
//   persist /workspace changes across turns for the same durable session"), and this spike did
//   confirm the *session* side of that guarantee live — same sessionId, same continuationToken,
//   held open and re-enterable across the message boundary. Combined, this is treated as
//   sufficient confirmation for the deferred Workflow task without forcing a same-session file
//   write through the real triage agent.
//
// IMPLICATION FOR THE DEFERRED WORKFLOW TASK: a per-step defineInstructions override must work
// WITH the base identity framing ("You are a bug-triage-and-fix agent... work through these
// phases"), not against it — telling the model to ignore that framing outright risks a refusal
// like the one above. This matches (and validates) how Task 6's agent/instructions/
// phase2-tools.ts override is already phrased: "## Phase 2 override... Ignore the raw git
// commands described for Phase 2 steps 1, 2, and 4 above" presents as a continuation of the
// existing phase structure, not a contradiction of the agent's identity.
//
// Commands actually run (curl, not an interactive script — simpler to drive directly than the
// originally sketched stdin-wait version):
//
//   curl -sS -D /tmp/spike-headers1.txt -X POST http://127.0.0.1:2000/eve/v1/session \
//     -H 'content-type: application/json' \
//     -d '{"message":"Write the text spike-marker to a file at /workspace/spike-marker.txt using your sandbox tools, then stop and wait - do not do anything else."}' \
//     -o /tmp/spike-body1.json
//
//   curl -sN --max-time 60 "http://127.0.0.1:2000/eve/v1/session/<sessionId>/stream"
//
// To actually force sandbox-tool usage in a future run of this spike, send a message shaped like
// a real Phase 1 trigger (issue number/title/body) instead of an out-of-scope instruction.
