# Slack Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the bug-triage agent a presence in Slack — a dedicated channel that mirrors every run's triage/fix narration and lets a human approve or deny high-blast-radius fixes from Slack, in addition to the existing dashboard.

**Architecture:** Slack is a notification + approval surface, not a second conversational agent. The agent's sessions stay anchored to the GitHub channel; Slack never tries to resume that session. A shared `resolvePendingPr()` function (extracted from the dashboard's existing route) is the single place that turns a human decision into either a real PR or a "denied" outcome — the dashboard's buttons and Slack's `onInteraction` both call it. Everything else is proactive `chat.postMessage`/`chat.update` calls from existing hooks/tools, using a plain `SLACK_BOT_TOKEN` (not eve's session-scoped Slack credentials, which aren't reachable from those call sites).

**Tech stack:** `eve/channels/slack` (`slackChannel()`, `connectSlackCredentials`) for the channel's inbound webhook + `onInteraction`; Slack Web API (`chat.postMessage`, `chat.update`) called directly via `fetch` from hooks/tools using `SLACK_BOT_TOKEN`.

## Global Constraints

- Slack is additive: the GitHub-triggered pipeline, the dashboard, and existing approval resolution keep working exactly as they do today.
- No new eve session/channel is used for the agent's actual work — the GitHub-anchored session remains the only live agent session per bug run.
- A paused, high-blast-radius fix is resolved by a direct API call against `run.pendingPr`, never by resuming an eve session (see `agent/lib/store.ts`'s `PendingPr` comment for why).
- Every Slack API call is best-effort and non-fatal: log and continue, never let a notification failure break triage/fix work (matches the existing GitHub-comment and Redis-write error handling throughout the codebase).

---

### Task 1: Extract `resolvePendingPr()` into `agent/lib/pr-approval.ts`

**Files:**
- Create: `agent/lib/pr-approval.ts`
- Modify: `agent/channels/dashboard.ts:221-267` (the `POST /dashboard/admin/resolve-pr/:runId` route body)
- Test: `tests/pr-approval.test.ts`

**Interfaces:**
- Consumes: `BugRunStore`, `BugRun`, `createMemoryStore` from `agent/lib/store.ts` (existing).
- Produces: `PrClient` interface and `resolvePendingPr(store: BugRunStore, runId: string, decision: "approve" | "deny", octokit: PrClient): Promise<ResolvePendingPrResult>` where `ResolvePendingPrResult = { ok: true; denied: true } | { ok: true; prUrl: string } | { ok: false; reason: string }`. Later tasks (Task 3) import this exact function and type.

This is a pure refactor — the dashboard route's behavior must not change. Isolating it first, with its own tests, means Task 3 (Slack's `onInteraction`) can call the same tested logic instead of a second copy that could drift.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/pr-approval.test.ts
import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../agent/lib/store";
import { resolvePendingPr, type PrClient } from "../agent/lib/pr-approval";

const pendingPr = {
  owner: "acme",
  repo: "widgets",
  title: "fix: something",
  body: "body",
  branch: "fix/issue-1",
};

function fakeOctokit(prUrl: string): PrClient {
  return {
    pulls: {
      create: async () => ({ data: { html_url: prUrl } }),
    },
  };
}

describe("resolvePendingPr", () => {
  it("opens a draft PR and marks the run pr_opened on approve", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-1", issueNumber: 1, issueTitle: "Bug" });
    await store.updateRun("run-1", { status: "awaiting_approval", pendingPr });

    const result = await resolvePendingPr(
      store,
      "run-1",
      "approve",
      fakeOctokit("https://github.com/acme/widgets/pull/9"),
    );

    expect(result).toEqual({ ok: true, prUrl: "https://github.com/acme/widgets/pull/9" });
    const run = await store.getRun("run-1");
    expect(run?.status).toBe("pr_opened");
    expect(run?.outcome).toBe("escalated");
    expect(run?.prUrl).toBe("https://github.com/acme/widgets/pull/9");
  });

  it("marks the run failed/denied on deny, without calling Octokit", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-2", issueNumber: 2, issueTitle: "Bug" });
    await store.updateRun("run-2", { status: "awaiting_approval", pendingPr });

    let called = false;
    const octokit: PrClient = {
      pulls: { create: async () => { called = true; return { data: { html_url: "unused" } }; } },
    };

    const result = await resolvePendingPr(store, "run-2", "deny", octokit);

    expect(result).toEqual({ ok: true, denied: true });
    expect(called).toBe(false);
    const run = await store.getRun("run-2");
    expect(run?.status).toBe("failed");
    expect(run?.outcome).toBe("denied");
  });

  it("returns ok:false when the run has no pendingPr", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-3", issueNumber: 3, issueTitle: "Bug" });

    const result = await resolvePendingPr(store, "run-3", "approve", fakeOctokit("unused"));

    expect(result).toEqual({ ok: false, reason: "No pendingPr recorded for this run" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pr-approval.test.ts`
Expected: FAIL — `agent/lib/pr-approval.ts` does not exist yet.

- [ ] **Step 3: Implement `resolvePendingPr()`**

```typescript
// agent/lib/pr-approval.ts
import type { BugRunStore } from "./store";

export interface PrClient {
  pulls: {
    create(params: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      head: string;
      base: string;
      draft: boolean;
    }): Promise<{ data: { html_url: string } }>;
  };
}

export type ResolvePendingPrResult =
  | { ok: true; denied: true }
  | { ok: true; prUrl: string }
  | { ok: false; reason: string };

// Single place that turns a human's approve/deny decision into either a real draft PR or a
// denied run. Called from both agent/channels/dashboard.ts's resolve-pr route and Slack's
// onInteraction (agent/channels/slack.ts) — extracted so the two surfaces can never drift into
// different behavior. Neither caller needs the original agent session alive: opening a PR is a
// stateless REST call, and denying just updates the run record (see PendingPr's comment in
// lib/store.ts for why this bypasses eve's session-based approval entirely).
export async function resolvePendingPr(
  store: BugRunStore,
  runId: string,
  decision: "approve" | "deny",
  octokit: PrClient,
): Promise<ResolvePendingPrResult> {
  const run = await store.getRun(runId);
  if (!run?.pendingPr) {
    return { ok: false, reason: "No pendingPr recorded for this run" };
  }

  if (decision === "deny") {
    await store.updateRun(runId, {
      status: "failed",
      outcome: "denied",
      completedAt: new Date().toISOString(),
    });
    return { ok: true, denied: true };
  }

  const pr = await octokit.pulls.create({
    owner: run.pendingPr.owner,
    repo: run.pendingPr.repo,
    title: run.pendingPr.title,
    body: run.pendingPr.body,
    head: run.pendingPr.branch,
    base: "main",
    draft: true,
  });
  await store.updateRun(runId, {
    status: "pr_opened",
    prUrl: pr.data.html_url,
    outcome: "escalated",
    completedAt: new Date().toISOString(),
  });
  return { ok: true, prUrl: pr.data.html_url };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pr-approval.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Rewire the dashboard route to call `resolvePendingPr()`**

Replace the body of `POST("/dashboard/admin/resolve-pr/:runId", ...)` in `agent/channels/dashboard.ts` (currently lines 221-267) with:

```typescript
    POST("/dashboard/admin/resolve-pr/:runId", async (req, { params }) => {
      if (req.headers.get("x-admin-secret") !== process.env.ADMIN_RESET_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      const decision = url.searchParams.get("decision");
      if (decision !== "approve" && decision !== "deny") {
        return new Response("decision=approve|deny query param required", { status: 400 });
      }
      const { Octokit } = await import("@octokit/rest");
      const octokit = new Octokit({ auth: process.env.GITHUB_PR_TOKEN });
      const result = await resolvePendingPr(store, params.runId, decision, octokit);
      if (!result.ok) {
        return new Response(result.reason, { status: 400 });
      }
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    }),
```

Add the import at the top of `agent/channels/dashboard.ts`:

```typescript
import { resolvePendingPr } from "../lib/pr-approval";
```

- [ ] **Step 6: Typecheck and run the full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — no new type errors, all existing tests (including `tests/open-pr-approval.test.ts`, untouched) still pass.

- [ ] **Step 7: Manual verification**

The dashboard's Approve/Deny buttons must behave identically to before. If a `pendingPr` demo run is still present (e.g. `demo-approval-ui` from earlier verification), click Deny on it via the live dashboard and confirm the run marks `failed`/`denied` exactly as before this refactor.

- [ ] **Step 8: Commit**

```bash
git add agent/lib/pr-approval.ts tests/pr-approval.test.ts agent/channels/dashboard.ts
git commit -m "refactor: extract resolvePendingPr so Slack can reuse dashboard's approval logic"
```

---

### Task 2: Slack notification helper (`agent/lib/slack-notify.ts`) + store fields

**Files:**
- Modify: `agent/lib/store.ts` (add `slackChannelId`/`slackThreadTs` to `BugRun`)
- Create: `agent/lib/slack-notify.ts`
- Test: `tests/slack-notify.test.ts`

**Interfaces:**
- Consumes: `BugRunStore`, `BugRun` from `agent/lib/store.ts`.
- Produces: `postToRunThread(store: BugRunStore, runId: string, message: SlackMessage): Promise<void>` where `SlackMessage = { text: string; blocks?: unknown[] }`. Later tasks (4, 5) call this from hooks/tools. Also produces `SLACK_CHANNEL_ID` env var contract (the dedicated channel's id, read inside this file) and `SLACK_BOT_TOKEN` env var contract (the bot token, read inside this file).

`postToRunThread` is the only way any other file talks to Slack — it owns thread bookkeeping (start vs. reply) so callers never touch `slackChannelId`/`slackThreadTs` directly.

- [ ] **Step 1: Add the store fields**

In `agent/lib/store.ts`, add to the `BugRun` interface (after `pendingPr?: PendingPr;`):

```typescript
  // Set the first time a Slack message is posted for this run (agent/lib/slack-notify.ts).
  // slackThreadTs anchors every later message for the run as a threaded reply instead of a new
  // top-level message.
  slackChannelId?: string;
  slackThreadTs?: string;
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/slack-notify.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryStore } from "../agent/lib/store";
import { postToRunThread } from "../agent/lib/slack-notify";

describe("postToRunThread", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.thread_ts === undefined) {
        return new Response(JSON.stringify({ ok: true, ts: "1000.001" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, ts: "1000.002" }), { status: 200 });
    }));
  });

  it("starts a new thread on the first post and stores the ts", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-1", issueNumber: 1, issueTitle: "Bug" });

    await postToRunThread(store, "run-1", { text: "Investigating…" });

    const run = await store.getRun("run-1");
    expect(run?.slackChannelId).toBe("C123");
    expect(run?.slackThreadTs).toBe("1000.001");
  });

  it("replies in the existing thread on a later post", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-2", issueNumber: 2, issueTitle: "Bug" });
    await store.updateRun("run-2", { slackChannelId: "C123", slackThreadTs: "1000.001" });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await postToRunThread(store, "run-2", { text: "Root cause found." });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.thread_ts).toBe("1000.001");
    expect(body.channel).toBe("C123");
  });

  it("does not throw when SLACK_BOT_TOKEN is unset", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const store = createMemoryStore();
    await store.createRun({ runId: "run-3", issueNumber: 3, issueTitle: "Bug" });

    await expect(postToRunThread(store, "run-3", { text: "hi" })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/slack-notify.test.ts`
Expected: FAIL — `agent/lib/slack-notify.ts` does not exist yet.

- [ ] **Step 4: Implement `postToRunThread()`**

```typescript
// agent/lib/slack-notify.ts
import type { BugRunStore } from "./store";

export interface SlackMessage {
  readonly text: string;
  readonly blocks?: readonly unknown[];
}

// Posts to the dedicated Slack channel using a plain bot token, not eve's Connect-managed
// Slack credentials — those are only reachable from inside a tool's execute() or a Slack
// channel-dispatch context (agent/channels/slack.ts's onInteraction), and this is called from
// defineHook handlers and tool execute() bodies that aren't Slack-anchored at all. Mirrors the
// existing GITHUB_PR_TOKEN pattern (agent/tools/open_pr.ts) for the identical reason.
//
// Every call is best-effort: a Slack outage must never break triage/fix work, matching the
// error-handling style used throughout the codebase for GitHub comments and Redis writes.
export async function postToRunThread(
  store: BugRunStore,
  runId: string,
  message: SlackMessage,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!token || !channelId) {
    console.error("[slack-notify] ✖ SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not set — skipping post");
    return;
  }

  const run = await store.getRun(runId).catch(() => null);
  if (!run) return;

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: run.slackChannelId ?? channelId,
        thread_ts: run.slackThreadTs,
        text: message.text,
        blocks: message.blocks,
      }),
    });
    const body = (await response.json()) as { ok: boolean; ts?: string; error?: string };
    if (!body.ok) {
      console.error(`[slack-notify] ✖ chat.postMessage failed: ${body.error}`);
      return;
    }
    if (!run.slackThreadTs && body.ts) {
      await store
        .updateRun(runId, { slackChannelId: channelId, slackThreadTs: body.ts })
        .catch((err) => console.error(`[slack-notify] ✖ updateRun (thread) failed:`, err));
    }
  } catch (err) {
    console.error(`[slack-notify] ✖ chat.postMessage threw:`, err);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/slack-notify.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add agent/lib/store.ts agent/lib/slack-notify.ts tests/slack-notify.test.ts
git commit -m "feat: add Slack notification helper and thread-tracking store fields"
```

---

### Task 3: Slack channel + interactive Approve/Deny buttons

**Files:**
- Create: `agent/channels/slack.ts`
- Test: `tests/slack-channel.test.ts`

**Interfaces:**
- Consumes: `resolvePendingPr`, `PrClient` from `agent/lib/pr-approval.ts` (Task 1); `createRedisStore` from `agent/lib/store.ts`.
- Produces: `parseApprovalAction(action: { actionId: string; value?: string }): { runId: string; decision: "approve" | "deny" } | null`, exported for its own test and reused nowhere else — `onInteraction` is the only caller.

Button `value`s encode `"<runId>:<decision>"` (e.g. `"run-123:approve"`) with a fixed `actionId` of `"resolve_pr"`, decoded by `parseApprovalAction`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/slack-channel.test.ts
import { describe, it, expect } from "vitest";
import { parseApprovalAction } from "../agent/channels/slack";

describe("parseApprovalAction", () => {
  it("parses a valid approve action", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr", value: "run-123:approve" })).toEqual({
      runId: "run-123",
      decision: "approve",
    });
  });

  it("parses a valid deny action", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr", value: "run-123:deny" })).toEqual({
      runId: "run-123",
      decision: "deny",
    });
  });

  it("returns null for a different actionId", () => {
    expect(parseApprovalAction({ actionId: "something_else", value: "run-123:approve" })).toBeNull();
  });

  it("returns null when value is missing", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr" })).toBeNull();
  });

  it("returns null when the decision isn't approve or deny", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr", value: "run-123:maybe" })).toBeNull();
  });

  it("returns null when the runId is empty", () => {
    expect(parseApprovalAction({ actionId: "resolve_pr", value: ":approve" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack-channel.test.ts`
Expected: FAIL — `agent/channels/slack.ts` does not exist yet.

- [ ] **Step 3: Implement the Slack channel**

```typescript
// agent/channels/slack.ts
import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";
import { Octokit } from "@octokit/rest";
import { createRedisStore } from "../lib/store";
import { resolvePendingPr } from "../lib/pr-approval";

const store = createRedisStore();

export function parseApprovalAction(action: {
  readonly actionId: string;
  readonly value?: string;
}): { runId: string; decision: "approve" | "deny" } | null {
  if (action.actionId !== "resolve_pr" || !action.value) return null;
  const separatorIndex = action.value.lastIndexOf(":");
  if (separatorIndex <= 0) return null;
  const runId = action.value.slice(0, separatorIndex);
  const decision = action.value.slice(separatorIndex + 1);
  if (decision !== "approve" && decision !== "deny") return null;
  return { runId, decision };
}

export default slackChannel({
  // Provisioned via `vercel connect create slack --triggers` under the UID
  // "slack/bug-triage-agent" (see docs/superpowers/specs/2026-08-21-slack-integration-design.md
  // for the full setup). Used here only for inbound webhook verification and this channel's own
  // onInteraction dispatch — outbound notifications (agent/lib/slack-notify.ts) use a separate,
  // manually-configured SLACK_BOT_TOKEN instead, since Connect's managed token isn't reachable
  // from the hooks/tools that post those.
  credentials: connectSlackCredentials("slack/bug-triage-agent"),
  // No onMessage/onAppMention: the agent never holds a conversation in Slack. onInteraction is
  // the only inbound behavior — resolving Approve/Deny button clicks directly against
  // run.pendingPr, the same way agent/channels/dashboard.ts's buttons already do (both call
  // resolvePendingPr so the two surfaces can never behave differently).
  async onInteraction(action, ctx) {
    const parsed = parseApprovalAction(action);
    if (!parsed) return;

    const octokit = new Octokit({ auth: process.env.GITHUB_PR_TOKEN });
    const result = await resolvePendingPr(store, parsed.runId, parsed.decision, octokit);

    const outcomeText = !result.ok
      ? `⚠️ ${result.reason}`
      : "denied" in result
        ? `🚫 Denied by <@${action.user.id}>`
        : `✅ Approved by <@${action.user.id}> — <${result.prUrl}|PR opened>`;

    // Updates the clicked message in place (strips the buttons, shows the resolution) rather
    // than posting a new reply — ctx.slack.request is the raw Slack Web API escape hatch,
    // available here because onInteraction runs inside real Slack channel-dispatch context
    // (unlike slack-notify.ts's callers). request() resolves even when Slack's API rejects the
    // call (body.ok: false) — it does not throw — so check .ok explicitly rather than relying
    // on .catch() alone, same as slack-notify.ts's own fetch-based calls do.
    try {
      const response = await ctx.slack.request("chat.update", {
        channel: ctx.slack.channelId,
        ts: action.messageTs,
        text: outcomeText,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: outcomeText } }],
      });
      if (!response.ok) {
        console.error("[slack] ✖ chat.update after resolution failed:", response);
      }
    } catch (err) {
      console.error("[slack] ✖ chat.update after resolution threw:", err);
    }
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slack-channel.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. If `@vercel/connect`/`eve/channels/slack` type-check against a different `onInteraction`/`ctx.slack.request` shape than assumed here, fix the call to match the installed package's actual types (check `node_modules/eve/dist/src/public/channels/slack/slackChannel.d.ts` and `.../api.d.ts`) — the behavior (update the clicked message with the outcome) is the requirement, not this exact call shape.

- [ ] **Step 6: One-time Slack + Connect setup (not code — do this against the real workspace)**

```bash
vercel connect create slack --name bug-triage-agent --triggers
vercel connect detach slack/bug-triage-agent --yes
vercel connect attach slack/bug-triage-agent --triggers --trigger-path /eve/v1/slack --yes
```

In the Connect dashboard's **Advanced** section for this connector, ensure `chat:write` is included in Bot Scopes (needed for `chat.postMessage`/`chat.update`), and that Event Subscriptions include `app_mention`/interactivity (the `--triggers` flag above turns this on for the standard set).

Create a **separate** Slack Bot Token for `agent/lib/slack-notify.ts`'s proactive posting (Task 2) — either reuse the same Slack app's OAuth token from its **OAuth & Permissions** page (same `chat:write` scope) or install a lightweight second app if you'd rather keep the two token lifecycles independent. Set as Vercel project env vars:

```bash
vercel env add SLACK_BOT_TOKEN production
vercel env add SLACK_CHANNEL_ID production
```

(`SLACK_CHANNEL_ID` is the dedicated channel's id — right-click the channel in Slack → View channel details → copy the ID at the bottom.)

- [ ] **Step 7: Commit**

```bash
git add agent/channels/slack.ts tests/slack-channel.test.ts
git commit -m "feat: add Slack channel with Approve/Deny button handling"
```

---

### Task 4: Post triage/approval/outcome updates from existing hooks and tools

**Files:**
- Modify: `agent/hooks/run-tracking.ts` (add posting on `session.started` and inside `markIncompleteIfNeverFinished`)
- Modify: `agent/tools/classify_severity.ts` (add posting after severity is known)
- Modify: `agent/tools/open_pr.ts` (add posting for both the parked-for-approval path and the auto-resolved path)
- Test: `tests/run-tracking-slack.test.ts` (new — see below; existing `tests/run-status.test.ts` and `tests/open-pr-approval.test.ts` must keep passing unchanged)

**Interfaces:**
- Consumes: `postToRunThread` from `agent/lib/slack-notify.ts` (Task 2).
- Produces: nothing new — this task only adds call sites.

This task wires the data-flow steps from the design spec (steps 1, 2, 4, 6) into the four places that already own those lifecycle transitions. Each call is fire-and-forget (`.catch(...)`), matching how every other side effect in these files is already handled.

- [ ] **Step 1: `run-tracking.ts` — placeholder message on session start, final outcome on failure**

In `agent/hooks/run-tracking.ts`, add the import:

```typescript
import { postToRunThread } from "../lib/slack-notify";
```

In `markIncompleteIfNeverFinished` (after the `store.updateRun(...)` call that marks the run failed, still inside the function, after the existing `.catch(...)` block for that call), add:

```typescript
  await postToRunThread(store, sessionId, {
    text: `⏹️ Run stopped: ${outcome}.`,
  }).catch((err) => console.error(`[run-tracking] ✖ Slack post (outcome) failed:`, err));
```

In the `"session.started"` handler, after the existing `store.createRun(...)` call's `.catch(...)` block, add:

```typescript
      await postToRunThread(store, ctx.session.id, {
        text: "🔍 Investigating a new issue…",
      }).catch((err) => console.error(`[run-tracking] ✖ Slack post (start) failed:`, err));
```

- [ ] **Step 2: `classify_severity.ts` — triage summary once severity is known**

In `agent/tools/classify_severity.ts`, add the import:

```typescript
import { postToRunThread } from "../lib/slack-notify";
```

After the existing `store.updateRun(ctx.session.id, { severity: object.severity, status: "fixing" })` call's `.catch(...)` block, add:

```typescript
    await postToRunThread(store, ctx.session.id, {
      text:
        `*#${issueNumber}: ${issueTitle}*\n` +
        `Severity: *${object.severity}* — ${object.rationale}\n` +
        `Root cause: ${rootCause}`,
    }).catch((err) => console.error(`[classify_severity] ✖ Slack post failed:`, err));
```

- [ ] **Step 3: `open_pr.ts` — approval-request message with buttons, and the auto-resolved outcome**

In `agent/tools/open_pr.ts`, add the import:

```typescript
import { postToRunThread } from "../lib/slack-notify";
```

In the `if (openPrApprovalPolicy({ toolInput: input }) === "user-approval")` branch, after the existing `store.updateRun(...)` call's `.catch(...)` block (still before the `return`), add:

```typescript
      await postToRunThread(store, ctx.session.id, {
        text: `🚧 *${input.title}* needs approval before the PR opens.`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `🚧 *${input.title}* needs approval before the PR opens.\nBranch \`${input.branch}\`` },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "resolve_pr",
                text: { type: "plain_text", text: "Approve" },
                style: "primary",
                value: `${ctx.session.id}:approve`,
              },
              {
                type: "button",
                action_id: "resolve_pr",
                text: { type: "plain_text", text: "Deny" },
                style: "danger",
                value: `${ctx.session.id}:deny`,
              },
            ],
          },
        ],
      }).catch((err) => console.error(`[open_pr] ✖ Slack post (approval) failed:`, err));
```

In the auto-resolved path (after the final `store.updateRun(...)` call's `.catch(...)` block, still before `return { prUrl: pr.data.html_url, prNumber: pr.data.number };`), add:

```typescript
    await postToRunThread(store, ctx.session.id, {
      text: `✅ PR opened: ${pr.data.html_url}`,
    }).catch((err) => console.error(`[open_pr] ✖ Slack post (outcome) failed:`, err));
```

- [ ] **Step 4: Write a test confirming the wiring doesn't break existing behavior**

```typescript
// tests/run-tracking-slack.test.ts
import { describe, it, expect } from "vitest";
import { openPrApprovalPolicy } from "../agent/tools/open_pr";

// Regression guard: adding Slack posting to open_pr.ts's execute() must not change
// openPrApprovalPolicy's pure decision logic, which tests/open-pr-approval.test.ts already
// covers in full. This test exists to be the first thing that fails if a future edit
// accidentally couples the two.
describe("openPrApprovalPolicy after Slack wiring", () => {
  it("is unaffected by Slack posting (still a pure decision)", () => {
    expect(
      openPrApprovalPolicy({
        toolInput: {
          issueNumber: 1,
          branch: "fix/issue-1",
          title: "Fix it",
          body: "Body",
          severity: "medium",
          blastRadiusTier: "low",
          filesChanged: 1,
          linesChanged: 10,
          checksAllPassed: true,
          reproTestPassed: true,
        },
      }),
    ).toBe("not-applicable");
  });
});
```

- [ ] **Step 5: Run the full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — every existing test file (`tests/run-status.test.ts`, `tests/open-pr-approval.test.ts`, `tests/cost-tracking.test.ts`, etc.) still passes unchanged, plus the new test above.

- [ ] **Step 6: Commit**

```bash
git add agent/hooks/run-tracking.ts agent/tools/classify_severity.ts agent/tools/open_pr.ts tests/run-tracking-slack.test.ts
git commit -m "feat: post triage/approval/outcome updates to the run's Slack thread"
```

---

### Task 5: Mirror the agent's narration into Slack

**Files:**
- Create: `agent/hooks/slack-narration.ts`
- Test: `tests/slack-narration.test.ts`

**Interfaces:**
- Consumes: `postToRunThread` from `agent/lib/slack-notify.ts` (Task 2).
- Produces: `shouldPostMessage(event: { finishReason: string; message: string | null }): boolean`, exported for its own test.

This is a new, channel-agnostic hook (not tied to the GitHub or Slack channel) listening to the generic `message.completed` session event, mirroring the same condition GitHub's built-in comment-posting already uses: skip when `finishReason === "tool-calls"` or `message` is empty, otherwise post the text as a threaded reply.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/slack-narration.test.ts
import { describe, it, expect } from "vitest";
import { shouldPostMessage } from "../agent/hooks/slack-narration";

describe("shouldPostMessage", () => {
  it("posts a normal finished text reply", () => {
    expect(shouldPostMessage({ finishReason: "stop", message: "Root cause found." })).toBe(true);
  });

  it("skips when the step ended in tool calls", () => {
    expect(shouldPostMessage({ finishReason: "tool-calls", message: "some text" })).toBe(false);
  });

  it("skips when there is no message text", () => {
    expect(shouldPostMessage({ finishReason: "stop", message: null })).toBe(false);
  });

  it("skips an empty string message", () => {
    expect(shouldPostMessage({ finishReason: "stop", message: "" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack-narration.test.ts`
Expected: FAIL — `agent/hooks/slack-narration.ts` does not exist yet.

- [ ] **Step 3: Implement the hook**

```typescript
// agent/hooks/slack-narration.ts
import { defineHook } from "eve/hooks";
import { createRedisStore } from "../lib/store";
import { postToRunThread } from "../lib/slack-notify";

const store = createRedisStore();

// Mirrors the same condition eve's built-in GitHub message.completed handler uses to decide
// whether a step's text is a real reply worth posting (agent/channels/github.ts relies on that
// built-in — see its own comment on why no `events` override is defined there). message.completed
// fires for every channel's session, not just GitHub's, so this one hook covers Slack narration
// for any future trigger channel too.
export function shouldPostMessage(event: {
  readonly finishReason: string;
  readonly message: string | null;
}): boolean {
  return event.finishReason !== "tool-calls" && !!event.message;
}

export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      if (!shouldPostMessage(event.data)) return;
      await postToRunThread(store, ctx.session.id, { text: event.data.message! }).catch((err) =>
        console.error(`[slack-narration] ✖ Slack post failed:`, err),
      );
    },
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slack-narration.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add agent/hooks/slack-narration.ts tests/slack-narration.test.ts
git commit -m "feat: mirror the agent's plain-text replies into the run's Slack thread"
```

---

### Task 6: Live end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Deploy**

```bash
vercel deploy --prod
```

- [ ] **Step 2: Verify low-cost, no new GitHub issue needed**

Reuse the same technique already used for the dashboard: seed a `pendingPr` (and, this time, a `slackChannelId`/no `slackThreadTs`, so the first Slack post starts a fresh thread) onto a demo run via a one-off script against the real Redis store, then confirm:
- A message with Approve/Deny buttons appears in the dedicated Slack channel.
- Clicking Deny updates the message in place, marks the run `failed`/`denied` in the dashboard, and does not call GitHub's API.
- Clicking Approve (on a *different* seeded demo run, with a real existing branch) opens a real draft PR and updates the Slack message with the PR link.

- [ ] **Step 3: Verify narration end-to-end on a real, cheap issue**

Trigger one real, trivial GitHub issue (same low-cost pattern used throughout tonight's session) and confirm in the dedicated Slack channel: a thread starts near-immediately, the triage summary posts once severity is known, the agent's narration replies stream into the thread, and the final outcome (PR link or otherwise) posts at the end.

- [ ] **Step 4: Report results to the user**

Summarize what was verified (or any deviation from the spec found live) before considering this plan complete.
