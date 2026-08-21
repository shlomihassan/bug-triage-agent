# Slack Integration Design

**Goal:** Give the bug-triage agent a presence in Slack — a dedicated channel that mirrors every run's triage/fix narration and lets a human approve or deny high-blast-radius fixes from Slack, in addition to the existing dashboard.

**Architecture:** Slack is a notification + approval surface, not a second conversational agent. The agent's sessions stay anchored to the GitHub channel (that's what triggers them); Slack never tries to resume that session. Messages are posted proactively via the Slack Web API from our own hooks/tools, and the Approve/Deny buttons are resolved by a Slack interactivity webhook calling the same shared resolution logic the dashboard's buttons already use.

**Tech stack:** `eve/channels/slack` (`slackChannel()`) for Connect-managed bot token + inbound webhook verification only; direct Slack Web API calls (`chat.postMessage`, `chat.update`) from existing hooks for everything else.

## Global Constraints

- Slack is additive: nothing about the GitHub-triggered pipeline, the dashboard, or existing approval resolution changes in behavior — Slack is a second way to see updates and a second way to click Approve/Deny.
- No new eve session/channel is used for the agent's actual work. The GitHub-anchored session remains the only live agent session per bug run.
- Follows the pattern already proven tonight: a paused, high-blast-radius fix is resolved by a direct API call against `pendingPr` in Redis, never by resuming an eve session.

---

## Why not eve's native Slack HITL buttons

eve's Slack channel has a first-class feature: it turns pending tool-approval questions into Slack buttons automatically, and clicking them resumes the session — but only for sessions the Slack channel itself owns. Our bug-triage sessions are owned by the GitHub channel (they start when a GitHub issue is opened). Resuming a GitHub-owned session from a Slack button click hits the exact same wall we hit tonight trying to resume it from the dashboard: eve scopes session resumption strictly to the channel that owns the session. So Slack's native HITL feature doesn't apply here — this design uses the same direct-resolution pattern already built for the dashboard instead.

## Components

**`agent/channels/slack.ts`** (new) — `slackChannel({ credentials: connectSlackCredentials("slack/bug-triage-agent") })`, used for Connect-managed inbound webhook signature verification (interactivity payloads) and outbound-token infrastructure, even though outbound posting itself uses a separate manual token (see `slack-notify.ts` below). No `onMessage`/`onAppMention` handlers are defined (the agent doesn't hold conversations in Slack). `onInteraction(action, ctx)` is the one handler defined: it parses the clicked button's `runId`/`decision` out of the interaction payload, calls the shared `resolvePendingPr()` (below), and updates the original Slack message in place (`chat.update`, available on `ctx` inside this real channel-dispatch context) to show the resolved state (who decided, when, and the resulting PR link or denial) instead of leaving stale buttons visible.

**`agent/lib/pr-approval.ts`** (new) — extracts the approve/deny logic currently inline in `dashboard.ts`'s `POST /dashboard/admin/resolve-pr/:runId` route into a standalone `resolvePendingPr(runId, decision)` function: reads `run.pendingPr`, either opens the draft PR via Octokit (approve) or marks the run failed with `outcome: "denied"` (deny), same as today. Both the dashboard route and Slack's `onInteraction` call this one function — no duplicated logic, no risk of the two surfaces drifting apart.

**`agent/lib/slack-notify.ts`** (new) — a small helper wrapping Slack's Web API (`chat.postMessage`, `chat.update`) using a plain, manually-configured `SLACK_BOT_TOKEN` env var — not a Connect-managed token. `ctx.getToken()`/Connect's credential refresh is only available inside a tool's `execute()` or channel-dispatch context; the notification calls in this design run from `defineHook` handlers and the dashboard's plain HTTP route, neither of which has that context. This mirrors the existing `GITHUB_PR_TOKEN` pattern exactly (`agent/tools/open_pr.ts` already uses a separately-managed PAT for the identical reason: Connect's managed GitHub token isn't reachable from a tool either). `SLACK_BOT_TOKEN` comes from the Slack app's own OAuth install (`chat:write` scope), configured once outside Connect. Exposes `postToRunThread(runId, text, blocks?)`, which looks up `run.slackChannelId`/`run.slackThreadTs` from the store and either starts a new thread (storing the returned `ts`) or replies in the existing one.

**Store additions** (`agent/lib/store.ts`) — `BugRun` gets optional `slackChannelId?: string` and `slackThreadTs?: string`, set the first time a Slack message is posted for that run.

## Data flow

1. **Run starts** (`run-tracking.ts`'s `session.started`, same place the dashboard's eager placeholder is created): post a placeholder message to the dedicated channel ("🔍 Investigating a new issue…"), store the returned thread `ts`.
2. **Triage completes** (`classify_severity.ts`): edit the placeholder (`chat.update`) with the real issue number/title, then post the triage summary (root cause, severity, repro) as a threaded reply — mirroring what already goes into the GitHub issue comment.
3. **Agent's narration** (a new, channel-agnostic `defineHook` on the generic `message.completed` session event — not tied to the GitHub channel): forwards each of the agent's plain-text replies into the run's Slack thread, the same content GitHub's `message.completed` built-in already posts as an issue comment. One new hook, reused for every run regardless of channel.
4. **High-blast-radius fix parked** (`open_pr.ts`, when `pendingPr` is set): post a threaded message with the fix summary and **Approve**/**Deny** buttons (Block Kit), with `runId` and `decision` encoded in each button's `value`.
5. **Human clicks a button**: Slack's interactivity webhook hits `onInteraction`, which calls `resolvePendingPr()` and updates the message to show the outcome. Same function the dashboard's buttons call — whichever surface is clicked first wins; the other is a no-op afterward since `pendingPr` is already cleared.
6. **Run finishes** (`open_pr.ts`'s auto-resolved path, or `run-tracking.ts`'s failure/timeout/cost-cap paths): post the final outcome (PR link, or why it stopped) as a threaded reply.

## Error handling

- Every Slack API call is best-effort and non-fatal, matching the existing pattern for GitHub comment posting and Redis writes throughout the codebase (log and continue, never let a notification failure break the actual triage/fix work).
- If `run.slackChannelId`/`slackThreadTs` is missing when a later hook tries to post (e.g. Slack was added after a run already started), that hook skips posting for that run rather than starting a new, disconnected thread.

## Testing

- Unit test `resolvePendingPr()` directly (approve path opens a PR via a mocked Octokit, deny path marks the run failed) — mirrors the existing `open-pr-approval.test.ts` pattern.
- Unit test the `onInteraction` payload-parsing (extracting `runId`/`decision` from a Slack button click payload, including malformed/missing cases).
- Manual end-to-end verification against the real Slack workspace and a real (or seeded-demo, as done tonight for the dashboard) `pendingPr`, same low-cost verification style used throughout tonight's session.
