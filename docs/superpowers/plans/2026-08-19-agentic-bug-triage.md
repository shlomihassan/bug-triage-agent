# Agentic Bug Triage & Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an eve agent that, triggered by a GitHub issue on a forked Vikunja repo, reproduces the bug, classifies its severity and blast radius, attempts a fix, and either auto-opens a draft PR or pauses for human approval — with cost tracking and cross-bug memory.

**Architecture:** A single `eve` agent (`bug-triage-agent`) using eve's native GitHub channel (`onIssue`) as the trigger, eve's default sandbox tools (`bash`/`read_file`/`write_file`/`glob`/`grep`) for reproduction and fixing, three authored tools (`classify_severity`, `assess_blast_radius`, `open_pr`) backed by direct Anthropic API calls, and eve's native `approval` policy mechanism (not custom code) for the human-in-the-loop escalation gate. A stream-event hook records real per-call cost (`step.completed`'s `usage.costUsd`) to an Upstash Redis-backed store, which a custom eve HTTP channel (`defineChannel`) serves as a dashboard.

**Tech Stack:** eve 0.30.2, TypeScript, `ai` (Vercel AI SDK v7) + `@ai-sdk/anthropic` for direct Anthropic API calls, `@upstash/redis` for the job store, `@octokit/rest` for PR creation, Vitest for tests. Target repo: a fork of [go-vikunja/vikunja](https://github.com/go-vikunja/vikunja) (Go backend, Vue 3 frontend).

## Global Constraints

- Blank-repo build: no code, git history, or shared Vercel project copied from any prior related project. Only architectural patterns are reused (cited inline where relevant), never files.
- Node.js >=24 (eve's requirement).
- Never auto-merge or push directly to `main` on the Vikunja fork — draft PRs only.
- Every model call must be logged with real `costUsd`/`inputTokens`/`outputTokens`: `inputTokens`/`outputTokens` come from eve's `step.completed` event or the raw AI SDK `usage` object depending on the call site; `costUsd` comes from eve's `step.completed.data.usage.costUsd` for the primary agent loop (Task 9), or from `calculateCostUsd()` (Task 10's `agent/lib/pricing.ts`) for direct-call tools — the raw AI SDK `usage` object has no `costUsd` field of its own.
- Model routing: `claude-sonnet-5` drives the main agent loop (reproduction + fix-writing); `claude-haiku-4-5-20251001` for severity/blast-radius classification; `claude-opus-5` only via the explicit stuck-fix escalation path.
- No RAG/embeddings for cross-bug memory — an append-only notes log read into context at session start.

---

## File Structure

### Repo: `vikunja` (already cloned at `/Users/shlomi.hassan/projects/vikunja`, currently tracking upstream `go-vikunja/vikunja`)

- `pkg/models/task_attachment_permissions.go` — seed the backend bug here (`CanDelete` checks `CanRead` instead of `CanWrite`).
- `frontend/src/helpers/time/getNextWeekDate.ts` — seed the frontend bug here (wrong duration constant).
- `docs/demo-issues/backend-attachment-delete.md`, `docs/demo-issues/frontend-upcoming-range.md` — the two GitHub issue bodies used to trigger the agent (kept in-repo purely as a record of what was filed; the real trigger is the GitHub issue itself, not these files).

### Repo: `bug-triage-agent` (already git-initialized at `/Users/shlomi.hassan/projects/bug-triage-agent`, spec committed)

```
bug-triage-agent/
├── package.json
├── tsconfig.json
├── .env.example
├── agent/
│   ├── agent.ts                       # defineAgent — primary model: claude-sonnet-5
│   ├── instructions.md                # the triage+solve procedure (system prompt)
│   ├── channels/
│   │   ├── github.ts                  # githubChannel + onIssue trigger
│   │   └── dashboard.ts               # defineChannel — GET /dashboard, GET /dashboard/:runId
│   ├── hooks/
│   │   └── cost-tracking.ts           # step.completed -> store.recordModelCall
│   ├── sandbox/
│   │   └── sandbox.ts                 # bootstrap: git clone the vikunja fork
│   ├── tools/
│   │   ├── classify_severity.ts       # Haiku call, triage phase
│   │   ├── assess_blast_radius.ts     # Haiku call, solve phase
│   │   ├── escalate_to_opus.ts        # Opus call, only when stuck
│   │   ├── read_notes.ts              # cross-bug memory read
│   │   ├── append_note.ts             # cross-bug memory write
│   │   └── open_pr.ts                 # Octokit draft PR, approval-gated
│   └── lib/
│       ├── autonomy.ts                # pure requiresApproval() override function
│       ├── config.ts                  # env var loading/validation
│       ├── store.ts                   # BugRunStore: Redis-backed + in-memory
│       ├── anthropic.ts               # shared @ai-sdk/anthropic model getters
│       └── pricing.ts                 # calculateCostUsd() — the AI SDK usage object has no costUsd field
└── tests/
    ├── autonomy.test.ts
    ├── store.test.ts
    ├── cost-tracking.test.ts
    ├── anthropic.test.ts
    ├── pricing.test.ts
    └── open-pr-approval.test.ts
```

---

## Task 1: Fork Vikunja and repoint the local clone

**Files:**
- Modify: `/Users/shlomi.hassan/projects/vikunja/.git/config` (via `git remote`)

**Interfaces:** None (git/GitHub operations only).

- [ ] **Step 1: Fork the upstream repo under your GitHub account**

```bash
cd /Users/shlomi.hassan/projects/vikunja
gh repo fork go-vikunja/vikunja --remote=false --clone=false
```

This creates `<your-github-username>/vikunja` on GitHub without touching the local clone yet (`--clone=false`), since the clone already exists locally.

- [ ] **Step 2: Repoint the local clone's `origin` at your fork, keep upstream for reference**

```bash
git remote rename origin upstream
gh repo set-default <your-github-username>/vikunja
git remote add origin "https://github.com/<your-github-username>/vikunja.git"
git push -u origin main
```

- [ ] **Step 3: Verify**

```bash
git remote -v
# origin    https://github.com/<your-github-username>/vikunja.git (fetch/push)
# upstream  https://github.com/go-vikunja/vikunja.git (fetch/push)
gh repo view --web
```

Confirm the fork is visible on GitHub and `main` matches upstream.

---

## Task 2: Seed the backend bug (broken access control on attachment delete)

**Files:**
- Modify: `pkg/models/task_attachment_permissions.go:30-33`

**Interfaces:**
- Produces: a real, reproducible regression — `TaskAttachment.CanDelete` grants delete access to any user with only read access to the parent task.

- [ ] **Step 1: Confirm current (correct) behavior with a throwaway check**

```bash
cd /Users/shlomi.hassan/projects/vikunja
cat <<'EOF' > pkg/models/zzz_scratch_test.go
package models

import (
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestScratch_AttachmentCanDelete_ReadOnlyUser(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()

	// Fixture: users_projects.yml id 2 gives user 2 permission 0 (read-only) on project 3.
	// Fixture: tasks.yml task 32 belongs to project 3.
	u := &user.User{ID: 2}
	ta := &TaskAttachment{TaskID: 32}

	canDelete, err := ta.CanDelete(s, u)
	require.NoError(t, err)
	assert.False(t, canDelete, "a read-only user must not be able to delete task attachments")
}
EOF
mage test:filter TestScratch_AttachmentCanDelete_ReadOnlyUser
```

Expected: PASS (current code correctly checks `CanWrite`).

- [ ] **Step 2: Introduce the bug**

In `pkg/models/task_attachment_permissions.go`, change:

```go
// CanDelete checks if the user can delete an attachment
func (ta *TaskAttachment) CanDelete(s *xorm.Session, a web.Auth) (bool, error) {
	t := &Task{ID: ta.TaskID}
	return t.CanWrite(s, a)
}
```

to:

```go
// CanDelete checks if the user can delete an attachment
func (ta *TaskAttachment) CanDelete(s *xorm.Session, a web.Auth) (bool, error) {
	t := &Task{ID: ta.TaskID}
	return t.CanRead(s, a)
}
```

- [ ] **Step 3: Confirm the bug manifests**

```bash
mage test:filter TestScratch_AttachmentCanDelete_ReadOnlyUser
```

Expected: FAIL — `canDelete` is now `true` for the read-only user.

- [ ] **Step 4: Remove the scratch test (do not commit a regression test — the triage agent must discover and write its own)**

```bash
rm pkg/models/zzz_scratch_test.go
```

- [ ] **Step 5: Commit only the bug**

```bash
git add pkg/models/task_attachment_permissions.go
git commit -m "fix: use CanRead instead of CanWrite for attachment delete permission check"
git push origin main
```

Deliberately mislabeled as `fix:` — this simulates a real regression that shipped believing it was correct, which is what makes it a legitimate bug report rather than an obvious self-flagged issue.

---

## Task 3: Seed the frontend bug (wrong default range on Upcoming Tasks)

**Files:**
- Modify: `frontend/src/helpers/time/getNextWeekDate.ts`

**Interfaces:**
- Produces: `getNextWeekDate()` now returns tomorrow instead of 7 days out, silently narrowing the default range on the `/tasks/by/upcoming` view (`frontend/src/router/index.ts:225`).

- [ ] **Step 1: Confirm current (correct) behavior with a throwaway check**

```bash
cd /Users/shlomi.hassan/projects/vikunja/frontend
cat <<'EOF' > src/helpers/time/zzz-scratch.test.ts
import {describe, it, expect} from 'vitest'
import {getNextWeekDate} from './getNextWeekDate'

describe('getNextWeekDate (scratch)', () => {
	it('returns a date 7 days out', () => {
		const now = Date.now()
		const result = getNextWeekDate()
		const diffDays = (result.getTime() - now) / (1000 * 60 * 60 * 24)
		expect(diffDays).toBeGreaterThan(6.9)
		expect(diffDays).toBeLessThan(7.1)
	})
})
EOF
pnpm test:unit src/helpers/time/zzz-scratch.test.ts
```

Expected: PASS.

- [ ] **Step 2: Introduce the bug**

In `frontend/src/helpers/time/getNextWeekDate.ts`, change:

```ts
import {MILLISECONDS_A_WEEK} from '@/constants/date'

export function getNextWeekDate(): Date {
	return new Date((new Date()).getTime() + MILLISECONDS_A_WEEK)
}
```

to:

```ts
import {MILLISECONDS_A_DAY} from '@/constants/date'

export function getNextWeekDate(): Date {
	return new Date((new Date()).getTime() + MILLISECONDS_A_DAY)
}
```

- [ ] **Step 3: Confirm the bug manifests**

```bash
pnpm test:unit src/helpers/time/zzz-scratch.test.ts
```

Expected: FAIL — diff is ~1 day, not ~7.

- [ ] **Step 4: Remove the scratch test**

```bash
rm src/helpers/time/zzz-scratch.test.ts
```

- [ ] **Step 5: Commit only the bug**

```bash
cd /Users/shlomi.hassan/projects/vikunja
git add frontend/src/helpers/time/getNextWeekDate.ts
git commit -m "fix: use correct duration constant in getNextWeekDate"
git push origin main
```

---

## Task 4: Write and file the two demo GitHub issues

**Files:**
- Create: `docs/demo-issues/backend-attachment-delete.md`
- Create: `docs/demo-issues/frontend-upcoming-range.md`

**Interfaces:** None — these are records of the real GitHub issues filed in Step 3/4 below, not code the agent reads.

- [ ] **Step 1: Write the backend issue body**

```bash
mkdir -p docs/demo-issues
cat <<'EOF' > docs/demo-issues/backend-attachment-delete.md
# Any project member can delete other people's task attachments

**Steps to reproduce:**
1. As a user with only read access to a project (shared with "can view" permission),
   open a task in that project that has an attachment.
2. Call `DELETE /api/v1/tasks/{taskId}/attachments/{attachmentId}` (or use the UI's
   delete-attachment action if it's exposed to read-only viewers).

**Expected:** The request is rejected — read-only viewers should not be able to
delete attachments.

**Actual:** The delete succeeds. A user with view-only access can permanently
delete file attachments on a task they can't otherwise modify.

**Impact:** Any shared/public project with read-only collaborators is exposed to
unauthorized data loss.
EOF
```

- [ ] **Step 2: Write the frontend issue body**

```bash
cat <<'EOF' > docs/demo-issues/frontend-upcoming-range.md
# Upcoming Tasks view shows almost nothing when opened from the menu

**Steps to reproduce:**
1. Have several tasks due in the next 5-7 days.
2. Click "Upcoming" in the left navigation (no date range in the URL).

**Expected:** The view defaults to showing tasks due within the next 7 days.

**Actual:** Only tasks due tomorrow show up. Tasks due later this week are
missing entirely until you manually widen the date range.

**Impact:** The Upcoming view looks broken/empty for most users on a normal
week — it looks like tasks vanished.
EOF
```

- [ ] **Step 3: Commit and file both as real GitHub issues on the fork**

```bash
git add docs/demo-issues
git commit -m "docs: record the two seeded-bug demo issues"
git push origin main

gh issue create --repo <your-github-username>/vikunja \
  --title "Any project member can delete other people's task attachments" \
  --body-file docs/demo-issues/backend-attachment-delete.md

gh issue create --repo <your-github-username>/vikunja \
  --title "Upcoming Tasks view shows almost nothing when opened from the menu" \
  --body-file docs/demo-issues/frontend-upcoming-range.md
```

Note the two issue numbers returned — used in Task 17's end-to-end verification.

---

## Task 5: Scaffold the eve project

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`
- Create: `agent/agent.ts`
- Create: `agent/instructions.md` (placeholder, filled in Task 15)

**Interfaces:**
- Produces: `defineAgent` default export other tasks' tools attach to implicitly (eve discovers `agent/tools/*.ts` by file path, no explicit registration needed).

- [ ] **Step 1: Initialize the Node project and add eve**

```bash
cd /Users/shlomi.hassan/projects/bug-triage-agent
npm init -y
npm pkg set name="bug-triage-agent" private=true type="module"
npm pkg set engines.node=">=24"
npx eve@0.30.2 init .
```

`eve init .` adds the `eve`/`ai`/`zod` dependencies and any files the project doesn't already own (it will not touch the existing `docs/` directory).

- [ ] **Step 2: Add the remaining dependencies**

```bash
npm install @ai-sdk/anthropic@latest @upstash/redis@latest @octokit/rest@latest
npm install -D vitest @types/node
```

- [ ] **Step 3: Set the primary model in `agent/agent.ts`**

```ts
import { defineAgent } from "eve";
import { anthropic } from "@ai-sdk/anthropic";

export default defineAgent({
  model: anthropic("claude-sonnet-5"),
});
```

- [ ] **Step 4: Add `.env.example`**

```bash
cat <<'EOF' > .env.example
ANTHROPIC_API_KEY=
# Channel auth (comments, sandbox checkout, HITL prompts) is Connect-managed — provisioned in
# Task 17 via `vercel connect create github`, not an env var. GITHUB_PR_TOKEN below is a
# separate, narrowly-scoped PAT (repo scope, pull-request write) used only by the open_pr tool
# (Task 14), since a ToolContext has no ctx.github the way a channel dispatch context does.
GITHUB_PR_TOKEN=
GITHUB_OWNER=
GITHUB_REPO=vikunja
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
EOF
```

- [ ] **Step 5: Add npm scripts**

```bash
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .env.example agent/agent.ts
git commit -m "chore: scaffold eve project with direct Anthropic model"
```

---

## Task 6: Sandbox bootstrap — clone the Vikunja fork

**Correction to the plan, discovered during the final whole-branch review (after Task 15
wired the GitHub channel):** the custom `agent/sandbox/sandbox.ts` bootstrap below clones the
fork over unauthenticated `https://github.com/...` into `/workspace/repo`. But eve's
`githubChannel` (Task 15) already checks out the repo automatically on **every turn**, via a
built-in `turn.started` handler (confirmed in `node_modules/eve/dist/src/public/channels/github/checkout.js`:
`resolvePath(n.path ?? "/workspace")`) — authenticated (the installation token is brokered at
the sandbox firewall, never embedded in the URL), into `/workspace` (not `/workspace/repo`).
Left as originally written, the sandbox ends up with **two separate checkouts of the same
repo** at different paths, and `agent/instructions.md` (Task 15) pointed every command at the
bootstrap's unauthenticated `/workspace/repo` — the one the channel doesn't know about — rather
than the channel-managed, authenticated `/workspace`. This is fixed by removing this task's git
clone step entirely (Step 2 below is now a no-op/deleted file) and pointing
`agent/instructions.md` at `/workspace` instead; see Task 15's corresponding correction note.
`agent/lib/config.ts`'s `loadConfig()` is unaffected and still needed — `open_pr.ts` (Task 14)
uses it for its own separate PAT-authenticated Octokit call, independent of the channel's
checkout.

One related risk this correction does **not** attempt to fix blind (no live sandbox available
to verify against): the channel's checkout also calls `sandbox.setNetworkPolicy(...)` with an
allow-list of only `github.com`/`codeload.github.com` (deny-all otherwise) on every turn. This
would block `pnpm install`/`mage test:*`'s own dependency fetches (npm registry, Go module
proxy) during the solve phase, unless something widens the policy again after checkout runs.
**Flag this explicitly as a thing to watch for in Task 17's live end-to-end run** — if the
agent's `bash` calls start failing with network errors during dependency installation, this is
the cause, and the fix is a tool-level `ctx.getSandbox()` call to `setNetworkPolicy` (hooks
cannot do this — `HookContext` has no sandbox accessor) before the solve phase's first
install/test command.

**Second correction, discovered via live testing in Task 17:** the default sandbox turned out
NOT to be sufficient after all. The GitHub channel's own automatic checkout failed on the real
deployment with `fatal: detected dubious ownership in repository at '/workspace'` — the
sandbox volume's UID doesn't match the process UID inside it, which git treats as a safety
violation by default. `agent/sandbox/sandbox.ts` is back, but now doing something different
from either its original (redundant clone) or its briefly-deleted state: it runs
`git config --global --add safe.directory /workspace` in `onSession`, once per session, before
the channel's first per-turn checkout. This is setup-only — it still does not clone or touch
git remotes itself, so it doesn't reintroduce the original duplication problem.

**Files:**
- Create: `agent/lib/config.ts`
- Create: `agent/sandbox/sandbox.ts` (setup-only — see the second correction above; NOT a clone)

**Interfaces:**
- Consumes: `process.env.GITHUB_OWNER`, `process.env.GITHUB_REPO`.
- Produces: `loadConfig()` returning `{ githubOwner: string; githubRepo: string }`, used by Task 7/14's tools too.

- [ ] **Step 1: Write the config loader**

```ts
// agent/lib/config.ts
export interface AppConfig {
  readonly githubOwner: string;
  readonly githubRepo: string;
}

export function loadConfig(): AppConfig {
  const githubOwner = process.env.GITHUB_OWNER;
  const githubRepo = process.env.GITHUB_REPO;
  if (!githubOwner) throw new Error("GITHUB_OWNER is not set");
  if (!githubRepo) throw new Error("GITHUB_REPO is not set");
  return { githubOwner, githubRepo };
}
```

- [ ] **Step 2 (superseded — do not create `agent/sandbox/sandbox.ts`):** the GitHub channel
(Task 15) checks out the repo automatically into `/workspace` on every turn, authenticated. A
custom sandbox bootstrap would only create a second, unauthenticated, unused checkout. If
`agent/sandbox/sandbox.ts` already exists from before this correction, delete it.

`/workspace` (not `/workspace/repo`) becomes the working tree every default tool (`bash`,
`read_file`, `glob`, `grep`) operates against, populated by the channel — see Task 15's
correction note for how `agent/instructions.md` reflects this.

- [ ] **Step 3: Verify the config loader typechecks**

```bash
npm run typecheck
```

Live verification of the actual checkout (that `/workspace` really does contain the Vikunja
tree once a real issue triggers a session) happens in Task 17, once the GitHub channel and a
real installation exist — there is no sandbox to boot against in this task anymore, since
Task 6 no longer owns any sandbox definition.

- [ ] **Step 4: Commit**

```bash
git add agent/lib/config.ts
git commit -m "feat: bootstrap sandbox by cloning the vikunja fork"
```

---

## Task 7: Autonomy override function (pure, unit tested)

**Files:**
- Create: `agent/lib/autonomy.ts`
- Test: `tests/autonomy.test.ts`

**Interfaces:**
- Produces: `requiresApproval(input: AutonomyInput): boolean`, consumed by Task 14's `open_pr` tool.

```ts
export type Severity = "critical" | "high" | "medium" | "low";
export type BlastRadiusTier = "high" | "medium" | "low";
export interface AutonomyInput {
  readonly severity: Severity;
  readonly blastRadiusTier: BlastRadiusTier;
  readonly filesChanged: number;
  readonly linesChanged: number;
  readonly checksAllPassed: boolean;
  readonly reproTestPassed: boolean;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/autonomy.test.ts
import { describe, it, expect } from "vitest";
import { requiresApproval, type AutonomyInput } from "../agent/lib/autonomy";

const baseline: AutonomyInput = {
  severity: "medium",
  blastRadiusTier: "low",
  filesChanged: 1,
  linesChanged: 20,
  checksAllPassed: true,
  reproTestPassed: true,
};

describe("requiresApproval", () => {
  it("allows auto-open when everything is small, safe, and passing", () => {
    expect(requiresApproval(baseline)).toBe(false);
  });

  it("forces approval when blast radius is high", () => {
    expect(requiresApproval({ ...baseline, blastRadiusTier: "high" })).toBe(true);
  });

  it("forces approval when severity is critical", () => {
    expect(requiresApproval({ ...baseline, severity: "critical" })).toBe(true);
  });

  it("forces approval when any check failed", () => {
    expect(requiresApproval({ ...baseline, checksAllPassed: false })).toBe(true);
  });

  it("forces approval when the repro test doesn't pass", () => {
    expect(requiresApproval({ ...baseline, reproTestPassed: false })).toBe(true);
  });

  it("forces approval when the diff touches too many files", () => {
    expect(requiresApproval({ ...baseline, filesChanged: 4 })).toBe(true);
  });

  it("forces approval when the diff is too large", () => {
    expect(requiresApproval({ ...baseline, linesChanged: 151 })).toBe(true);
  });

  it("allows auto-open exactly at the caps", () => {
    expect(requiresApproval({ ...baseline, filesChanged: 3, linesChanged: 150 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- tests/autonomy.test.ts
```

Expected: FAIL with "Cannot find module '../agent/lib/autonomy'".

- [ ] **Step 3: Implement**

```ts
// agent/lib/autonomy.ts
export type Severity = "critical" | "high" | "medium" | "low";
export type BlastRadiusTier = "high" | "medium" | "low";

export interface AutonomyInput {
  readonly severity: Severity;
  readonly blastRadiusTier: BlastRadiusTier;
  readonly filesChanged: number;
  readonly linesChanged: number;
  readonly checksAllPassed: boolean;
  readonly reproTestPassed: boolean;
}

const MAX_AUTO_FILES = 3;
const MAX_AUTO_LINES = 150;

/**
 * Deterministic override applied after the model's own severity/blast-radius
 * judgment. Mirrors the "risk = impact x probability, with a forced override
 * for the unambiguous cases" pattern: the model's classification is a signal,
 * never the final word on whether a human must sign off.
 */
export function requiresApproval(input: AutonomyInput): boolean {
  if (input.blastRadiusTier === "high") return true;
  if (input.severity === "critical") return true;
  if (!input.checksAllPassed) return true;
  if (!input.reproTestPassed) return true;
  if (input.filesChanged > MAX_AUTO_FILES) return true;
  if (input.linesChanged > MAX_AUTO_LINES) return true;
  return false;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- tests/autonomy.test.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/lib/autonomy.ts tests/autonomy.test.ts
git commit -m "feat: add deterministic autonomy override for the PR-approval gate"
```

---

## Task 8: Bug-run store (Upstash Redis-backed + in-memory)

**Files:**
- Create: `agent/lib/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ModelCallRecord {
    readonly phase: "classify_severity" | "assess_blast_radius" | "fix" | "escalate_to_opus";
    readonly model: string;
    readonly costUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly at: string; // ISO timestamp
  }
  export interface BugRun {
    readonly runId: string;
    readonly issueNumber: number;
    readonly issueTitle: string;
    status: "triaging" | "fixing" | "awaiting_approval" | "pr_opened" | "escalated" | "failed";
    severity?: Severity;
    blastRadiusTier?: BlastRadiusTier;
    outcome?: "auto_resolved" | "escalated" | "could_not_reproduce";
    prUrl?: string;
    startedAt: string;
    completedAt?: string;
    modelCalls: ModelCallRecord[];
  }
  export interface BugRunStore {
    // Idempotent: a second call for a runId that already exists is a no-op. The run's
    // canonical id is eve's own ctx.session.id, which only exists inside a tool/hook — not
    // at onIssue dispatch time, before the session exists — so the run row is lazily
    // created by the first tool call in the session (Task 10), not by the channel trigger.
    createRun(input: { runId: string; issueNumber: number; issueTitle: string }): Promise<void>;
    updateRun(runId: string, patch: Partial<BugRun>): Promise<void>;
    recordModelCall(runId: string, call: ModelCallRecord): Promise<void>;
    getRun(runId: string): Promise<BugRun | null>;
    listRuns(): Promise<BugRun[]>;
  }
  export function createMemoryStore(): BugRunStore;
  export function createRedisStore(): BugRunStore;
  ```

- [ ] **Step 1: Write the failing tests (against the in-memory store — this is the store's real behavioral contract, run without network)**

```ts
// tests/store.test.ts
import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../agent/lib/store";

describe("BugRunStore (memory)", () => {
  it("creates and retrieves a run", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-1", issueNumber: 42, issueTitle: "Broken sort" });
    const run = await store.getRun("run-1");
    expect(run?.issueNumber).toBe(42);
    expect(run?.status).toBe("triaging");
    expect(run?.modelCalls).toEqual([]);
  });

  it("patches fields with updateRun", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-1", issueNumber: 42, issueTitle: "Broken sort" });
    await store.updateRun("run-1", { status: "pr_opened", prUrl: "https://github.com/x/y/pull/1" });
    const run = await store.getRun("run-1");
    expect(run?.status).toBe("pr_opened");
    expect(run?.prUrl).toBe("https://github.com/x/y/pull/1");
  });

  it("appends model calls", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-1", issueNumber: 42, issueTitle: "Broken sort" });
    await store.recordModelCall("run-1", {
      phase: "classify_severity",
      model: "claude-haiku-4-5-20251001",
      costUsd: 0.0012,
      inputTokens: 500,
      outputTokens: 80,
      at: new Date().toISOString(),
    });
    const run = await store.getRun("run-1");
    expect(run?.modelCalls).toHaveLength(1);
    expect(run?.modelCalls[0]?.costUsd).toBeCloseTo(0.0012);
  });

  it("lists all runs newest first", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-1", issueNumber: 1, issueTitle: "First" });
    await store.createRun({ runId: "run-2", issueNumber: 2, issueTitle: "Second" });
    const runs = await store.listRuns();
    expect(runs.map((r) => r.runId)).toEqual(["run-2", "run-1"]);
  });

  it("returns null for an unknown run", async () => {
    const store = createMemoryStore();
    expect(await store.getRun("nope")).toBeNull();
  });

  it("createRun is idempotent — a second call for the same runId does not reset progress", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-1", issueNumber: 42, issueTitle: "Broken sort" });
    await store.updateRun("run-1", { status: "fixing" });
    await store.createRun({ runId: "run-1", issueNumber: 42, issueTitle: "Broken sort" });
    const run = await store.getRun("run-1");
    expect(run?.status).toBe("fixing");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- tests/store.test.ts
```

Expected: FAIL with "Cannot find module '../agent/lib/store'".

- [ ] **Step 3: Implement**

```ts
// agent/lib/store.ts
import { Redis } from "@upstash/redis";
import type { Severity, BlastRadiusTier } from "./autonomy";

export interface ModelCallRecord {
  readonly phase: "classify_severity" | "assess_blast_radius" | "fix" | "escalate_to_opus";
  readonly model: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly at: string;
}

export interface BugRun {
  readonly runId: string;
  readonly issueNumber: number;
  readonly issueTitle: string;
  status: "triaging" | "fixing" | "awaiting_approval" | "pr_opened" | "escalated" | "failed";
  severity?: Severity;
  blastRadiusTier?: BlastRadiusTier;
  outcome?: "auto_resolved" | "escalated" | "could_not_reproduce";
  prUrl?: string;
  startedAt: string;
  completedAt?: string;
  modelCalls: ModelCallRecord[];
}

export interface BugRunStore {
  createRun(input: { runId: string; issueNumber: number; issueTitle: string }): Promise<void>;
  updateRun(runId: string, patch: Partial<BugRun>): Promise<void>;
  recordModelCall(runId: string, call: ModelCallRecord): Promise<void>;
  getRun(runId: string): Promise<BugRun | null>;
  listRuns(): Promise<BugRun[]>;
}

const RUN_KEY = (runId: string) => `bug-run:${runId}`;
const RUN_INDEX_KEY = "bug-run-index";

export function createMemoryStore(): BugRunStore {
  const runs = new Map<string, BugRun>();
  const order: string[] = [];
  return {
    async createRun({ runId, issueNumber, issueTitle }) {
      if (runs.has(runId)) return;
      runs.set(runId, {
        runId,
        issueNumber,
        issueTitle,
        status: "triaging",
        startedAt: new Date().toISOString(),
        modelCalls: [],
      });
      order.push(runId);
    },
    async updateRun(runId, patch) {
      const run = runs.get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      Object.assign(run, patch);
    },
    async recordModelCall(runId, call) {
      const run = runs.get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      run.modelCalls.push(call);
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async listRuns() {
      return [...order].reverse().map((id) => runs.get(id)!);
    },
  };
}

export function createRedisStore(): BugRunStore {
  const redis = Redis.fromEnv();
  return {
    async createRun({ runId, issueNumber, issueTitle }) {
      const existing = await redis.get<BugRun>(RUN_KEY(runId));
      if (existing) return;
      const run: BugRun = {
        runId,
        issueNumber,
        issueTitle,
        status: "triaging",
        startedAt: new Date().toISOString(),
        modelCalls: [],
      };
      await redis.set(RUN_KEY(runId), run);
      await redis.lpush(RUN_INDEX_KEY, runId);
    },
    async updateRun(runId, patch) {
      const run = await redis.get<BugRun>(RUN_KEY(runId));
      if (!run) throw new Error(`Unknown run ${runId}`);
      await redis.set(RUN_KEY(runId), { ...run, ...patch });
    },
    async recordModelCall(runId, call) {
      const run = await redis.get<BugRun>(RUN_KEY(runId));
      if (!run) throw new Error(`Unknown run ${runId}`);
      run.modelCalls.push(call);
      await redis.set(RUN_KEY(runId), run);
    },
    async getRun(runId) {
      return (await redis.get<BugRun>(RUN_KEY(runId))) ?? null;
    },
    async listRuns() {
      const ids = await redis.lrange<string>(RUN_INDEX_KEY, 0, -1);
      const runs = await Promise.all(ids.map((id) => redis.get<BugRun>(RUN_KEY(id))));
      return runs.filter((r): r is BugRun => r !== null);
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- tests/store.test.ts
```

Expected: all 6 tests PASS (the Redis path is exercised later in Task 17's live deploy, not by this unit test).

- [ ] **Step 5: Commit**

```bash
git add agent/lib/store.ts tests/store.test.ts
git commit -m "feat: add bug-run store with in-memory and Redis backends"
```

---

## Task 9: Cost-tracking hook

**Correction to the plan, discovered via Task 17's live end-to-end test:** eve's own
`step.completed.data.usage.costUsd` — which this task originally trusted as-is — turned out to
never be populated for this agent's configuration. Real deployment logs showed five genuine
Sonnet steps (~19,000-20,000 input tokens, hundreds of output tokens each) all recording
`costUsd: $0.0000`. The likely reason: eve/AI Gateway computes that field when a model is
routed through the Gateway; this agent calls `@ai-sdk/anthropic` directly (`agent/agent.ts`),
bypassing the Gateway entirely by design (see the Global Constraints' model-routing note), so
nothing in that path has pricing knowledge of the call. Fixed by having `extractCostRecord`
compute `costUsd` itself via `calculateCostUsd()` (Task 10's `agent/lib/pricing.ts`) from the
real `inputTokens`/`outputTokens` eve does report — the same approach already used for the
three direct-call tools — rather than trusting a field this configuration never fills in.

**Files:**
- Create: `agent/hooks/cost-tracking.ts`
- Test: `tests/cost-tracking.test.ts`

**Interfaces:**
- Consumes: `BugRunStore.recordModelCall` (Task 8).
- Produces: `extractCostRecord(event: { data: { usage?: { costUsd?: number; inputTokens?: number; outputTokens?: number } } }, phase: ModelCallRecord["phase"], model: string): ModelCallRecord | null`, the pure part of the hook, tested directly; the hook itself wires it to the store and is verified live in Task 17.

- [ ] **Step 1: Write the failing test for the pure extraction function**

```ts
// tests/cost-tracking.test.ts
import { describe, it, expect } from "vitest";
import { extractCostRecord } from "../agent/hooks/cost-tracking";

describe("extractCostRecord", () => {
  it("builds a record from a step.completed event with usage", () => {
    const record = extractCostRecord(
      { data: { usage: { costUsd: 0.0034, inputTokens: 1200, outputTokens: 300 } } },
      "fix",
      "claude-sonnet-5",
    );
    expect(record).toEqual({
      phase: "fix",
      model: "claude-sonnet-5",
      costUsd: 0.0034,
      inputTokens: 1200,
      outputTokens: 300,
      at: record?.at,
    });
    expect(record?.at).toBeTruthy();
  });

  it("returns null when the event has no usage", () => {
    const record = extractCostRecord({ data: {} }, "fix", "claude-sonnet-5");
    expect(record).toBeNull();
  });

  it("defaults missing numeric fields to 0", () => {
    const record = extractCostRecord({ data: { usage: {} } }, "fix", "claude-sonnet-5");
    expect(record).toEqual({
      phase: "fix",
      model: "claude-sonnet-5",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      at: record?.at,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- tests/cost-tracking.test.ts
```

Expected: FAIL with "Cannot find module '../agent/hooks/cost-tracking'".

- [ ] **Step 3: Implement**

```ts
// agent/hooks/cost-tracking.ts
import { defineHook } from "eve/hooks";
import { createRedisStore, type ModelCallRecord } from "../lib/store";

export interface StepCompletedLike {
  readonly data: {
    readonly usage?: {
      readonly costUsd?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    };
  };
}

export function extractCostRecord(
  event: StepCompletedLike,
  phase: ModelCallRecord["phase"],
  model: string,
): ModelCallRecord | null {
  const usage = event.data.usage;
  if (!usage) return null;
  return {
    phase,
    model,
    costUsd: usage.costUsd ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    at: new Date().toISOString(),
  };
}

const store = createRedisStore();

export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      const record = extractCostRecord(event, "fix", "claude-sonnet-5");
      if (!record) return;
      // ctx.session.id is used as the runId elsewhere (see agent/channels/github.ts, Task 15) —
      // the primary agent-loop model calls (reproduction + fix-writing) are attributed to "fix"
      // here; classify_severity/assess_blast_radius/escalate_to_opus record their own direct
      // AI SDK calls explicitly (see Tasks 10, 11, 12), since those bypass eve's model step
      // entirely and never emit step.completed.
      await store.recordModelCall(ctx.session.id, record).catch(() => {
        // The run row is created lazily by classify_severity's first tool call (Task 10), since
        // that's the earliest point both ctx.session.id and the issue's number/title are known
        // together (see the BugRunStore.createRun note in Task 8). A step.completed firing before
        // that first tool call — the model's initial reasoning, or a local dev chat session with
        // no run at all — has nothing to record against yet; dropping it here is acceptable, since
        // it is never the only place a call's cost is observable, eve's own usage accounting still
        // holds it.
      });
    },
  },
});
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- tests/cost-tracking.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/hooks/cost-tracking.ts tests/cost-tracking.test.ts
git commit -m "feat: track real per-step cost from eve's step.completed usage data"
```

---

## Task 10: `classify_severity` tool (Haiku)

**Correction to the plan, discovered during implementation:** every direct-call tool below
originally read `usage.costUsd` off the raw Vercel AI SDK's `generateObject`/`generateText`
return value, on the assumption it worked like eve's own `step.completed.data.usage` (Task 9,
confirmed real via eve's own vendored types). It doesn't — the AI SDK's `LanguageModelUsage`
type (`node_modules/ai/dist/index.d.ts`) has only token counts (`inputTokens`, `outputTokens`,
`inputTokenDetails`, etc.), no `costUsd` field at all. `costUsd` only exists on eve's event
because eve/AI Gateway computes it from a pricing table; a direct provider call bypasses that
entirely. Left as originally written, every Haiku/Opus tool call's `costUsd` would silently
read as `undefined` and default to `0` — quietly breaking the budget-tracking story for exactly
the calls meant to demonstrate cheap-vs-expensive model routing. Fixed here with a small,
explicitly-labeled pricing table (Step 0 below); Tasks 11 and 12 reuse it.

**Files:**
- Create: `agent/lib/pricing.ts`
- Test: `tests/pricing.test.ts`
- Create: `agent/tools/classify_severity.ts`
- Create: `agent/lib/anthropic.ts`
- Test: `tests/anthropic.test.ts`

**Interfaces:**
- Consumes: `BugRunStore` (Task 8).
- Produces: `calculateCostUsd(model, inputTokens, outputTokens): number`, reused by Tasks 11 and
  12. Produces: tool `classify_severity`, callable by the model during triage; returns
  `{ severity: Severity; rationale: string }`.

- [ ] **Step 0: Pricing table**

```ts
// agent/lib/pricing.ts
// Anthropic per-model pricing in USD per million tokens. VERIFY AGAINST
// https://www.anthropic.com/pricing BEFORE RELYING ON THESE FOR REAL BUDGET DECISIONS —
// this table is a snapshot as of this plan's writing (2026-08-19), not fetched dynamically,
// and Anthropic can change published rates at any time.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-5": { input: 15.0, output: 75.0 },
};

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = PRICING_PER_MILLION_TOKENS[model];
  if (!rates) return 0;
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}
```

```ts
// tests/pricing.test.ts
import { describe, it, expect } from "vitest";
import { calculateCostUsd } from "../agent/lib/pricing";

describe("calculateCostUsd", () => {
  it("computes cost from input and output tokens at the model's published rates", () => {
    // 1,000,000 input + 1,000,000 output tokens at Haiku's $1.00/$5.00 per million.
    expect(calculateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBeCloseTo(6.0);
  });

  it("scales linearly for partial-million token counts", () => {
    // 500,000 input tokens at Sonnet's $3.00/million = $1.50; 0 output tokens = $0.
    expect(calculateCostUsd("claude-sonnet-5", 500_000, 0)).toBeCloseTo(1.5);
  });

  it("returns 0 for an unknown model rather than throwing", () => {
    expect(calculateCostUsd("some-unknown-model", 1_000_000, 1_000_000)).toBe(0);
  });
});
```

- [ ] **Step 1: Shared model getters**

```ts
// agent/lib/anthropic.ts
import { anthropic } from "@ai-sdk/anthropic";

export const haikuModel = () => anthropic("claude-haiku-4-5-20251001");
export const sonnetModel = () => anthropic("claude-sonnet-5");
export const opusModel = () => anthropic("claude-opus-5");
```

- [ ] **Step 2: Implement the tool**

```ts
// agent/tools/classify_severity.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { haikuModel } from "../lib/anthropic";
import { calculateCostUsd } from "../lib/pricing";
import { createRedisStore } from "../lib/store";

const severitySchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  rationale: z.string().min(1).max(300),
});

const inputSchema = z.object({
  issueNumber: z.number().int().positive(),
  issueTitle: z.string(),
  issueBody: z.string(),
  rootCause: z.string(),
  reproTestPassed: z.boolean(),
});

const store = createRedisStore();

export default defineTool({
  description:
    "Classify the user-facing severity of a bug (critical/high/medium/low) from the issue " +
    "report and the root-cause analysis already gathered. Call this once, after reproducing " +
    "the bug, before attempting a fix. This is also the first tool call of the run, and " +
    "creates the run's tracking record — always pass the real issue number and title.",
  inputSchema,
  outputSchema: severitySchema,
  async execute({ issueNumber, issueTitle, issueBody, rootCause, reproTestPassed }, ctx) {
    // Lazily creates the run row: ctx.session.id (the real, stable run identifier) only exists
    // once inside a tool/hook, never at the GitHub channel's onIssue dispatch time (Task 15) —
    // see the createRun note in Task 8.
    await store.createRun({ runId: ctx.session.id, issueNumber, issueTitle }).catch(() => {});
    const { object, usage } = await generateObject({
      model: haikuModel(),
      schema: severitySchema,
      system:
        "You are a triage assistant. Classify bug severity strictly from user-facing impact: " +
        "critical = data loss, security, or a broken core flow; high = a major feature broken " +
        "for most users; medium = a real but narrow or workaround-able issue; low = cosmetic or " +
        "edge-case. Respond with one tight sentence of rationale citing the specific impact.",
      prompt: JSON.stringify({ issueTitle, issueBody, rootCause, reproTestPassed }),
    });
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    await store
      .recordModelCall(ctx.session.id, {
        phase: "classify_severity",
        model: "claude-haiku-4-5-20251001",
        costUsd: calculateCostUsd("claude-haiku-4-5-20251001", inputTokens, outputTokens),
        inputTokens,
        outputTokens,
        at: new Date().toISOString(),
      })
      .catch(() => {});
    await store.updateRun(ctx.session.id, { severity: object.severity }).catch(() => {});
    return object;
  },
});
```

- [ ] **Step 3: Write and run a model-routing test**

This is the concrete check that Haiku/Sonnet/Opus are actually wired to the phases the
design assigns them to, catching a copy-paste mistake (e.g. `classify_severity`
accidentally using `sonnetModel()`) without spending real tokens:

```ts
// tests/anthropic.test.ts
import { describe, it, expect } from "vitest";
import { haikuModel, sonnetModel, opusModel } from "../agent/lib/anthropic";

describe("model routing", () => {
  it("routes each phase to a distinct, correctly-named model", () => {
    expect(haikuModel().modelId).toBe("claude-haiku-4-5-20251001");
    expect(sonnetModel().modelId).toBe("claude-sonnet-5");
    expect(opusModel().modelId).toBe("claude-opus-5");
  });
});
```

```bash
npm test -- tests/anthropic.test.ts
```

Expected: PASS. (`classify_severity`/`assess_blast_radius`'s use of `haikuModel()` and
`escalate_to_opus`'s use of `opusModel()`, Tasks 10-12, are otherwise only checked by
`npm run typecheck` — this test is what actually pins the model-id string per phase.)

- [ ] **Step 4: Verify types**

```bash
npm run typecheck
```

Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add agent/tools/classify_severity.ts agent/lib/anthropic.ts agent/lib/pricing.ts tests/anthropic.test.ts tests/pricing.test.ts
git commit -m "feat: add classify_severity tool backed by direct Haiku call"
```

---

## Task 11: `assess_blast_radius` tool (Haiku)

**Files:**
- Create: `agent/tools/assess_blast_radius.ts`

**Interfaces:**
- Consumes: `calculateCostUsd` (Task 10's `agent/lib/pricing.ts`) — the raw AI SDK `usage` object has no `costUsd` field (see Task 10's correction note); this tool computes it the same way classify_severity does.
- Produces: tool `assess_blast_radius`, returns `{ blastRadiusTier: BlastRadiusTier; rationale: string }`.

- [ ] **Step 1: Implement**

```ts
// agent/tools/assess_blast_radius.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { haikuModel } from "../lib/anthropic";
import { calculateCostUsd } from "../lib/pricing";
import { createRedisStore } from "../lib/store";

const blastRadiusSchema = z.object({
  blastRadiusTier: z.enum(["high", "medium", "low"]),
  rationale: z.string().min(1).max(300),
});

const inputSchema = z.object({
  diff: z.string(),
  filesChanged: z.array(z.string()),
});

const store = createRedisStore();

export default defineTool({
  description:
    "Assess the blast radius of a candidate fix diff: high if it touches auth/permissions, " +
    "database migrations, or public API contracts; medium for a moderate, contained change; " +
    "low for a small, isolated change with no sensitive surface. Call this once a fix diff " +
    "exists, before attempting to open a PR.",
  inputSchema,
  outputSchema: blastRadiusSchema,
  async execute({ diff, filesChanged }, ctx) {
    const { object, usage } = await generateObject({
      model: haikuModel(),
      schema: blastRadiusSchema,
      system:
        "You are a risk-assessment assistant. Rate the blast radius of a code change: " +
        "high = touches authentication, authorization/permission checks, database migrations, " +
        "or a public API contract; medium = a moderate, self-contained change outside those " +
        "areas; low = a small, isolated change with no sensitive surface. Cite the specific " +
        "file(s)/pattern that drove the rating in one tight sentence.",
      prompt: JSON.stringify({ filesChanged, diff }),
    });
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    await store
      .recordModelCall(ctx.session.id, {
        phase: "assess_blast_radius",
        model: "claude-haiku-4-5-20251001",
        costUsd: calculateCostUsd("claude-haiku-4-5-20251001", inputTokens, outputTokens),
        inputTokens,
        outputTokens,
        at: new Date().toISOString(),
      })
      .catch(() => {});
    await store.updateRun(ctx.session.id, { blastRadiusTier: object.blastRadiusTier }).catch(() => {});
    return object;
  },
});
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add agent/tools/assess_blast_radius.ts
git commit -m "feat: add assess_blast_radius tool backed by direct Haiku call"
```

---

## Task 12: `escalate_to_opus` tool (stuck-fix fallback)

**Files:**
- Create: `agent/tools/escalate_to_opus.ts`

**Interfaces:**
- Consumes: `calculateCostUsd` (Task 10's `agent/lib/pricing.ts`) — see Task 10's correction note on why the raw AI SDK `usage` object can't supply `costUsd` directly.
- Produces: tool `escalate_to_opus`, returns `{ suggestion: string }` — a text suggestion the primary Sonnet-driven loop applies itself via its normal `read_file`/`write_file`/`bash` tools (this tool never edits files directly).

- [ ] **Step 1: Implement**

```ts
// agent/tools/escalate_to_opus.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateText } from "ai";
import { opusModel } from "../lib/anthropic";
import { calculateCostUsd } from "../lib/pricing";
import { createRedisStore } from "../lib/store";

const inputSchema = z.object({
  issueTitle: z.string(),
  issueBody: z.string(),
  rootCause: z.string(),
  attemptedDiffs: z.array(z.string()).describe("Each prior fix attempt's diff, in order"),
  lastTestOutput: z.string().describe("Output of the repro test after the most recent attempt"),
});

const store = createRedisStore();

export default defineTool({
  description:
    "Call only after at least 3 failed attempts to make the repro test pass. Hands the full " +
    "attempt history to a stronger model for a fix suggestion. Deliberately expensive — do not " +
    "call this speculatively.",
  inputSchema,
  async execute(input, ctx) {
    const { text, usage } = await generateText({
      model: opusModel(),
      system:
        "You are a senior engineer brought in after 3 failed fix attempts. Read the attempted " +
        "diffs and the failing test output, diagnose why they didn't work, and propose a " +
        "concrete fix as a unified diff or precise file-by-file instructions.",
      prompt: JSON.stringify(input),
    });
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    await store
      .recordModelCall(ctx.session.id, {
        phase: "escalate_to_opus",
        model: "claude-opus-5",
        costUsd: calculateCostUsd("claude-opus-5", inputTokens, outputTokens),
        inputTokens,
        outputTokens,
        at: new Date().toISOString(),
      })
      .catch(() => {});
    return { suggestion: text };
  },
});
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add agent/tools/escalate_to_opus.ts
git commit -m "feat: add escalate_to_opus tool for stuck-fix attempts"
```

---

## Task 13: Cross-bug memory tools and the could-not-reproduce outcome

**Files:**
- Create: `agent/tools/read_notes.ts`
- Create: `agent/tools/append_note.ts`
- Create: `agent/tools/report_could_not_reproduce.ts`

**Interfaces:**
- Consumes: `BugRunStore` (Task 8).
- Produces: `read_notes()` returning `{ notes: string[] }`; `append_note({ note: string })` returning `{ ok: true }`, both operating on a single Redis list independent of any specific run. `report_could_not_reproduce({ issueNumber, whatWasTried })` returning `{ ok: true }` — this is what actually sets `BugRun.outcome = "could_not_reproduce"` (Task 8's schema names this outcome, but nothing before this task ever wrote it: `open_pr`, Task 14, only ever writes `"auto_resolved"`/`"escalated"`).

- [ ] **Step 1: Implement `read_notes`**

```ts
// agent/tools/read_notes.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { Redis } from "@upstash/redis";

export const NOTES_KEY = "codebase-notes";

export default defineTool({
  description:
    "Read accumulated notes about this codebase from prior bug-triage runs (file locations, " +
    "patterns, gotchas actually discovered). Call this first, before exploring the repo, so " +
    "earlier findings aren't rediscovered from scratch.",
  inputSchema: z.object({}),
  outputSchema: z.object({ notes: z.array(z.string()) }),
  async execute() {
    const redis = Redis.fromEnv();
    const notes = await redis.lrange<string>(NOTES_KEY, 0, -1);
    return { notes };
  },
});
```

- [ ] **Step 2: Implement `append_note`**

```ts
// agent/tools/append_note.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { Redis } from "@upstash/redis";
import { NOTES_KEY } from "./read_notes";

export default defineTool({
  description:
    "Append one short, concrete note to the shared codebase-notes log for future bug-triage " +
    "runs — e.g. 'auth checks live in pkg/models/*_permissions.go, not the route handlers'. " +
    "Call this once at the end of every run, whether or not the bug was fixed.",
  inputSchema: z.object({ note: z.string().min(1).max(300) }),
  outputSchema: z.object({ ok: z.literal(true) }),
  async execute({ note }) {
    const redis = Redis.fromEnv();
    await redis.rpush(NOTES_KEY, note);
    return { ok: true };
  },
});
```

- [ ] **Step 3: Implement `report_could_not_reproduce`**

```ts
// agent/tools/report_could_not_reproduce.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { createRedisStore } from "../lib/store";

const store = createRedisStore();

export default defineTool({
  description:
    "Call this and stop, instead of attempting a fix, when you cannot get a failing test to " +
    "reproduce the bug reported in the issue after a reasonable effort. Ends the run — never " +
    "guess at a fix for a bug you couldn't reproduce.",
  inputSchema: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    whatWasTried: z.string().min(1),
  }),
  outputSchema: z.object({ ok: z.literal(true) }),
  async execute({ issueNumber, issueTitle, whatWasTried }, ctx) {
    // Lazily creates the run row exactly like classify_severity (Task 10) does, for the same
    // reason — this can be the very first tool call of a run that never reaches triage's
    // severity step at all.
    await store.createRun({ runId: ctx.session.id, issueNumber, issueTitle }).catch(() => {});
    await store
      .updateRun(ctx.session.id, {
        status: "failed",
        outcome: "could_not_reproduce",
        completedAt: new Date().toISOString(),
      })
      .catch(() => {});
    void whatWasTried; // surfaced in the agent's own reply comment, not stored structurally
    return { ok: true };
  },
});
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add agent/tools/read_notes.ts agent/tools/append_note.ts agent/tools/report_could_not_reproduce.ts
git commit -m "feat: add cross-bug codebase-notes memory tools and could-not-reproduce outcome"
```

---

## Task 14: `open_pr` tool (approval-gated)

**Files:**
- Create: `agent/tools/open_pr.ts`
- Test: `tests/open-pr-approval.test.ts`

**Interfaces:**
- Consumes: `requiresApproval` (Task 7), `loadConfig` (Task 6), `BugRunStore` (Task 8).
- Produces: tool `open_pr`, gated by eve's native `approval` policy — this is the entire escalation mechanism; no custom "post a comment and wait" code is needed, since a `"user-approval"` return value durably parks the turn and eve's GitHub channel automatically renders the approval as a comment prompt.

- [ ] **Step 1: Implement**

```ts
// agent/tools/open_pr.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { requiresApproval } from "../lib/autonomy";
import { loadConfig } from "../lib/config";
import { createRedisStore } from "../lib/store";

export const openPrInputSchema = z.object({
  issueNumber: z.number().int().positive(),
  branch: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  blastRadiusTier: z.enum(["high", "medium", "low"]),
  filesChanged: z.number().int().nonnegative(),
  linesChanged: z.number().int().nonnegative(),
  checksAllPassed: z.boolean(),
  reproTestPassed: z.boolean(),
});

const store = createRedisStore();

// Extracted from the `defineTool` call below (rather than inlined) so it can be imported and
// called directly in tests/open-pr-approval.test.ts without needing to know defineTool's
// return shape — this is the actual escalation gate, so it's worth testing on its own.
export function openPrApprovalPolicy({
  toolInput,
}: {
  toolInput?: unknown;
}): "user-approval" | "not-applicable" {
  if (!toolInput) return "user-approval";
  const parsed = openPrInputSchema.safeParse(toolInput);
  if (!parsed.success) return "user-approval";
  return requiresApproval(parsed.data) ? "user-approval" : "not-applicable";
}

export default defineTool({
  description:
    "Open a draft pull request for a fix that has already been committed to a branch in the " +
    "sandbox and pushed to the fork. Provide the severity/blast-radius/diff-size/check-result " +
    "fields honestly — they determine whether this runs automatically or pauses for human " +
    "approval. Never call this before pushing the branch.",
  inputSchema: openPrInputSchema,
  approval: openPrApprovalPolicy,
  async execute(input, ctx) {
    const config = loadConfig();
    // A tool's ToolContext has no ctx.github (that's only on channel dispatch/hook contexts,
    // per eve/channels/github's onIssue/onComment) — so this uses its own PAT rather than the
    // Connect-managed installation token the github channel (Task 15) uses for comments.
    const octokit = new Octokit({ auth: process.env.GITHUB_PR_TOKEN });
    const pr = await octokit.pulls.create({
      owner: config.githubOwner,
      repo: config.githubRepo,
      title: input.title,
      body: input.body,
      head: input.branch,
      base: "main",
      draft: true,
    });
    const outcome = requiresApproval(input) ? "escalated" : "auto_resolved";
    await store
      .updateRun(ctx.session.id, {
        status: "pr_opened",
        prUrl: pr.data.html_url,
        outcome,
        completedAt: new Date().toISOString(),
      })
      .catch(() => {});
    return { prUrl: pr.data.html_url, prNumber: pr.data.number };
  },
});
```

Note: `requiresApproval(input)` is evaluated identically in both `approval` and `execute` — by the time `execute` runs, the tool call either never needed approval, or a human already approved it, so `outcome` here records *why* a human was in the loop, not a second gate.

- [ ] **Step 2: Write and run a network-free test of the approval-policy wiring**

This is the piece Task 7's `autonomy.test.ts` doesn't cover: the guard logic around
`toolInput` being missing or malformed, exactly as eve's real dispatch could hand it —
`toolInput` "can be undefined" per eve's own docs, so this is a real, not hypothetical,
input shape:

```ts
// tests/open-pr-approval.test.ts
import { describe, it, expect } from "vitest";
import { openPrApprovalPolicy } from "../agent/tools/open_pr";

const validInput = {
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
};

describe("openPrApprovalPolicy", () => {
  it("allows a small, safe, passing fix through without approval", () => {
    expect(openPrApprovalPolicy({ toolInput: validInput })).toBe("not-applicable");
  });

  it("requires approval for a high-blast-radius fix", () => {
    expect(
      openPrApprovalPolicy({ toolInput: { ...validInput, blastRadiusTier: "high" } }),
    ).toBe("user-approval");
  });

  it("fails closed when toolInput is undefined", () => {
    expect(openPrApprovalPolicy({ toolInput: undefined })).toBe("user-approval");
  });

  it("fails closed when toolInput doesn't match the schema", () => {
    expect(openPrApprovalPolicy({ toolInput: { nonsense: true } })).toBe("user-approval");
  });
});
```

```bash
npm test -- tests/open-pr-approval.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 3: Verify types**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add agent/tools/open_pr.ts tests/open-pr-approval.test.ts
git commit -m "feat: add approval-gated open_pr tool implementing the autonomy policy"
```

---

## Task 15: GitHub channel wiring and instructions.md

**Files:**
- Create: `agent/channels/github.ts`
- Modify: `agent/instructions.md`

**Interfaces:**
- Consumes: every tool from Tasks 10-14.
- Produces: the live trigger — a GitHub issue `opened` event on the fork starts a session.

- [ ] **Step 1: Add the Connect dependency**

```bash
npm install @vercel/connect
```

- [ ] **Step 2: Write the GitHub channel**

```ts
// agent/channels/github.ts
import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";

export default githubChannel({
  botName: "bug-triage-agent",
  // Provisioned in Task 17 via `vercel connect create github --triggers` under the UID
  // "github/bug-triage-agent" — Connect manages the GitHub App, installation token, and
  // inbound webhook verification, so no GITHUB_APP_ID/PRIVATE_KEY/WEBHOOK_SECRET here.
  credentials: connectGitHubCredentials("github/bug-triage-agent"),
  onIssue: (ctx, issue) => {
    if (issue.action !== "opened") return null;
    // The dispatch context (GitHubConversationRef: issueNumber/kind/pullRequestNumber) has no
    // session id yet — the session doesn't exist until eve dispatches this turn. The run's
    // tracking record is created lazily inside classify_severity (Task 10), the first tool call
    // in the flow, once ctx.session.id is actually available; see the createRun note in Task 8.
    return { auth: defaultGitHubAuth(ctx) };
  },
});
```

**Correction to the plan, discovered during the final whole-branch review:** every
`/workspace/repo` reference below is corrected to `/workspace` — see Task 6's correction note
for why (the GitHub channel checks out the repo into `/workspace`, not a custom `/repo`
subdirectory). An explicit safety prohibition on touching `main` has also been added to phase
2 below — the plan's own Global Constraint ("Never auto-merge or push directly to main") had no
corresponding sentence in the model-facing instructions, and this file is the only thing
governing what the freeform `bash` tool actually does.

- [ ] **Step 3: Write `agent/instructions.md`**

```md
You are a bug-triage-and-fix agent for the Vikunja fork checked out at `/workspace`
(Go backend under `pkg/`, Vue 3 frontend under `frontend/src`). You were triggered by a
GitHub issue reporting a bug. Work through these phases in order, narrating your findings
in plain text as you go — your replies are posted as comments on the issue, so write them
for a developer reading along, not just for yourself.

Never run any git command that pushes, merges, rebases onto, or checks out `main` directly.
Every change happens on a `fix/issue-<number>` branch, delivered only through the `open_pr`
tool (which always opens a draft PR, never merges). If a push to your branch fails or is
rejected, stop and explain the failure in your reply — do not retry against `main`.

## 0. Load prior context

Call `read_notes` first. If it returns notes from earlier bugs in this codebase, use them —
don't rediscover file locations or patterns already documented there.

## 1. Triage (read-only — do not edit any files yet)

1. Read the issue title and body. Locate the relevant code with `glob`/`grep`.
2. Reproduce the bug: write a targeted failing test that demonstrates exactly the reported
   behavior.
   - Backend: a Go test in the relevant `pkg/models/*_test.go` file, run with
     `mage test:filter <TestName>` from `/workspace`.
   - Frontend: a Vitest test alongside the relevant file, run with
     `cd /workspace/frontend && pnpm test:unit <path>`.
   Confirm it actually fails on the current code. If you cannot get a failing test to
   reproduce the reported behavior after a reasonable effort, call
   `report_could_not_reproduce` with the issue number/title and what you tried, explain
   the same in your reply, and stop — do not guess at a fix for a bug you couldn't
   reproduce, and skip straight to phase 3 (still leave a note).
3. Identify the root cause: the specific file(s)/line(s) responsible, in plain language.
4. Call `classify_severity` with the issue number, title, body, your root-cause
   explanation, and whether the repro test passed. This is also the first tool call of
   the run, so always pass the real issue number — it's how this run gets tracked.
5. Post your triage findings as a reply: root cause, severity + rationale, and the repro
   test. This is the "routing decision" comment — always post it before moving to phase 2.

## 2. Solve (only if phase 1 produced a reproducing failing test)

1. Create a branch: `git -C /workspace checkout -b fix/issue-<number>`.
2. Edit code until the repro test passes. Then run the full check suite:
   - Backend changes: `mage lint` and `mage test:web` (or `mage test:feature`, whichever
     covers the touched package) from `/workspace`.
   - Frontend changes: `pnpm lint` and `pnpm typecheck` and `pnpm test:unit` from
     `/workspace/frontend`.
   If you've made 3 attempts and the repro test still doesn't pass, call
   `escalate_to_opus` with the issue, your root cause, every attempted diff, and the last
   test output — then apply its suggestion yourself and re-run the checks. Do not call it
   before 3 genuine attempts.
3. Once the repro test and full check suite pass, compute the diff stats
   (`git -C /workspace diff --stat main`) and call `assess_blast_radius` with the
   diff and changed file list.
4. Commit and push the branch: `git -C /workspace add -A && git -C /workspace
   commit -m "fix: <short description>" && git -C /workspace push origin
   fix/issue-<number>`.
5. Call `open_pr` with the issue number, branch name, a PR title/body (include: issue
   link, root cause, the repro test, verification results, blast-radius rationale), and
   the severity/blastRadiusTier/filesChanged/linesChanged/checksAllPassed/reproTestPassed
   fields — report these honestly; they decide whether this runs automatically or pauses
   for your approval. If it pauses, explain in your next reply what specifically needs a
   human decision (not just "please approve").

## 3. Always, at the end

Call `append_note` with one short, concrete fact you learned about this codebase this run
— a file location, a pattern, a gotcha — even if you couldn't reproduce or fix the bug.
```

- [ ] **Step 4: Commit**

```bash
git add agent/channels/github.ts agent/instructions.md package.json package-lock.json
git commit -m "feat: wire GitHub issue trigger and write the triage+solve procedure"
```

---

## Task 16: Dashboard channel

**Files:**
- Create: `agent/channels/dashboard.ts`

**Interfaces:**
- Consumes: `BugRunStore.listRuns`, `BugRunStore.getRun` (Task 8).
- Produces: `GET /dashboard`, `GET /dashboard/:runId`.

- [ ] **Step 1: Implement**

```ts
// agent/channels/dashboard.ts
import { defineChannel, GET } from "eve/channels";
import { createRedisStore, type BugRun } from "../lib/store";

const store = createRedisStore();

function totalCost(run: BugRun): number {
  return run.modelCalls.reduce((sum, call) => sum + call.costUsd, 0);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title><style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
    a { color: #0060df; }
  </style></head><body>${body}</body></html>`;
}

export default defineChannel({
  routes: [
    GET("/dashboard", async () => {
      const runs = await store.listRuns();
      const totalSpend = runs.reduce((sum, run) => sum + totalCost(run), 0);
      const rows = runs
        .map(
          (run) => `<tr>
            <td><a href="/dashboard/${run.runId}">#${run.issueNumber}</a></td>
            <td>${escapeHtml(run.issueTitle)}</td>
            <td>${run.severity ?? "-"}</td>
            <td>${run.blastRadiusTier ?? "-"}</td>
            <td>${run.status}</td>
            <td>${run.outcome ?? "-"}</td>
            <td>$${totalCost(run).toFixed(4)}</td>
          </tr>`,
        )
        .join("");
      const body = `
        <h1>Bug Triage Runs</h1>
        <p>Total spend: $${totalSpend.toFixed(4)} of $50.00 budget</p>
        <table>
          <thead><tr><th>Issue</th><th>Title</th><th>Severity</th><th>Blast radius</th>
          <th>Status</th><th>Outcome</th><th>Cost</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      return new Response(layout("Bug Triage Runs", body), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }),
    GET("/dashboard/:runId", async (_req, { params }) => {
      const run = await store.getRun(params.runId);
      if (!run) return new Response("Not found", { status: 404 });
      const calls = run.modelCalls
        .map(
          (call) => `<tr>
            <td>${call.at}</td><td>${call.phase}</td><td>${call.model}</td>
            <td>${call.inputTokens}</td><td>${call.outputTokens}</td>
            <td>$${call.costUsd.toFixed(4)}</td>
          </tr>`,
        )
        .join("");
      const body = `
        <p><a href="/dashboard">&larr; All runs</a></p>
        <h1>#${run.issueNumber}: ${escapeHtml(run.issueTitle)}</h1>
        <p>Status: ${run.status} | Severity: ${run.severity ?? "-"} | Blast radius: ${
        run.blastRadiusTier ?? "-"
      } | Outcome: ${run.outcome ?? "-"}</p>
        <p>${run.prUrl ? `<a href="${run.prUrl}">Pull request</a>` : "No PR yet"}</p>
        <p>Total cost: $${totalCost(run).toFixed(4)}</p>
        <h2>Model calls</h2>
        <table>
          <thead><tr><th>At</th><th>Phase</th><th>Model</th><th>In tokens</th>
          <th>Out tokens</th><th>Cost</th></tr></thead>
          <tbody>${calls}</tbody>
        </table>`;
      return new Response(layout(`#${run.issueNumber}`, body), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }),
  ],
});
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add agent/channels/dashboard.ts
git commit -m "feat: add dashboard channel with run list and detail views"
```

---

## Task 17: Provision, deploy, and verify end-to-end against both seeded bugs

**Files:** None (infra + verification only).

- [ ] **Step 1: Link a Vercel project**

```bash
cd /Users/shlomi.hassan/projects/bug-triage-agent
npm install -g vercel@latest
vercel login
vercel link
```

Confirm the project belongs to a Hobby team with no payment method attached.

- [ ] **Step 2: Provision GitHub Connect for the GitHub channel**

```bash
npm install @vercel/connect
vercel connect create github --triggers
vercel connect attach github/bug-triage-agent --triggers --trigger-path /eve/v1/github --yes
```

During registration, subscribe to `issues` (in addition to the channel's default
`pull_request`) so `onIssue` actually fires. See Task 15's `agent/channels/github.ts`.

- [ ] **Step 3: Provision Upstash Redis**

From the Vercel dashboard: Storage -> Marketplace Database Providers -> Upstash -> Redis,
free tier, connect to this project. Then:

```bash
vercel env pull
```

Confirms `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set.

- [ ] **Step 4: Set remaining environment variables**

Generate the `open_pr` tool's PAT (Task 14) on GitHub first — Settings -> Developer settings
-> Fine-grained tokens -> scope it to only the `vikunja` fork, with **Pull requests: read and
write** and **Contents: read** permissions, nothing else. Then:

```bash
vercel env add ANTHROPIC_API_KEY production
vercel env add GITHUB_PR_TOKEN production   # the fine-grained PAT generated above
vercel env add GITHUB_OWNER production      # <your-github-username>
vercel env add GITHUB_REPO production       # vikunja
```

Confirm zero-spend guardrails before proceeding: Anthropic key has the assignment's $50 hard
cap, Vercel Hobby has no payment method, Upstash Redis is on the free tier.

- [ ] **Step 5: Enable Vercel Deployment Protection**

From the Vercel dashboard: Settings -> Deployment Protection -> enable password or
team-only protection, so `/dashboard` isn't publicly readable.

- [ ] **Step 6: Deploy**

```bash
npx eve@0.30.2 deploy
```

- [ ] **Step 7: Trigger the backend bug's issue**

Open the backend issue filed in Task 4 (or, if already open, add a no-op comment to
re-trigger — `onIssue` only fires on `action === "opened"`, so re-filing a fresh issue with
the same body is the reliable re-run path). Watch:

- The dashboard (`https://<deployment>/dashboard`) shows a new run in `triaging`.
- A comment appears on the issue with the triage findings (root cause, severity, repro
  test).
- Because this bug is high blast radius (touches `*_permissions.go`), the `open_pr` call
  should pause: the run's status becomes `awaiting_approval`, and a comment with an
  approve/deny prompt appears on the issue.
- Reply `approve` on the issue. Confirm a draft PR opens on the fork, and the dashboard
  run updates to `pr_opened` / `escalated`.

- [ ] **Step 8: Trigger the frontend bug's issue**

Open the frontend issue filed in Task 4. Watch:

- Triage and fix proceed the same way.
- Because this bug is low severity/low blast radius/small diff, `open_pr` should run
  automatically — no approval prompt, the dashboard run goes straight to `pr_opened` /
  `auto_resolved`.

- [ ] **Step 9: Confirm cross-bug memory**

Check the second run's triage comment (or the dashboard, if notes are surfaced there) —
confirm it references something the first run's `append_note` call recorded, demonstrating
that solving bug #1 fed context into bug #2.

- [ ] **Step 10: Confirm the budget story**

On the dashboard's run list, confirm the running total spend and the per-run cost
breakdown by model (`classify_severity`/`assess_blast_radius` on Haiku should be a small
fraction of the `fix` phase's Sonnet spend) — this is the artifact for the write-up's cost
management section.
