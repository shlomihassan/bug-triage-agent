import { describe, it, expect, vi, beforeEach } from "vitest";
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
    // Status must be awaiting_approval for the pendingPr check to even be reached — otherwise
    // the status guard above it fires first (covered by its own test below).
    await store.updateRun("run-3", { status: "awaiting_approval" });

    const result = await resolvePendingPr(store, "run-3", "approve", fakeOctokit("unused"));

    expect(result).toEqual({ ok: false, reason: "No pendingPr recorded for this run" });
  });

  it("returns ok:false and does not call Octokit when the run is already resolved", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-4", issueNumber: 4, issueTitle: "Bug" });
    await store.updateRun("run-4", {
      status: "failed",
      outcome: "denied",
      pendingPr, // pendingPr can never be cleared through the store API (see pr-approval.ts) —
      // it stays set even after the run is resolved, so the guard must key off status, not this.
    });

    let called = false;
    const octokit: PrClient = {
      pulls: {
        create: async () => {
          called = true;
          return { data: { html_url: "unused" } };
        },
      },
    };

    const result = await resolvePendingPr(store, "run-4", "approve", octokit);

    expect(result).toEqual({ ok: false, reason: "Run already resolved (failed)" });
    expect(called).toBe(false);
  });

  it("returns ok:false when Octokit rejects the PR-create call, instead of throwing", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-7", issueNumber: 7, issueTitle: "Bug" });
    await store.updateRun("run-7", { status: "awaiting_approval", pendingPr });

    const octokit: PrClient = {
      pulls: {
        create: async () => {
          throw new Error('Validation Failed: {"resource":"PullRequest","field":"head","code":"invalid"}');
        },
      },
    };

    const result = await resolvePendingPr(store, "run-7", "approve", octokit);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Failed to open PR");
      expect(result.reason).toContain("invalid");
    }
    // The run must stay in a sane, unresolved state — a failed Octokit call must not corrupt it.
    const run = await store.getRun("run-7");
    expect(run?.status).toBe("awaiting_approval");
  });
});

describe("resolvePendingPr Slack posting", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: "2000.001" }), { status: 200 })),
    );
  });

  it("posts an approval outcome to the run's Slack thread on approve", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-5", issueNumber: 5, issueTitle: "Bug" });
    await store.updateRun("run-5", {
      status: "awaiting_approval",
      pendingPr,
      slackChannelId: "C123",
      slackThreadTs: "1000.001",
    });

    await resolvePendingPr(
      store,
      "run-5",
      "approve",
      fakeOctokit("https://github.com/acme/widgets/pull/9"),
    );

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain("Approved");
    expect(body.text).toContain("https://github.com/acme/widgets/pull/9");
  });

  it("posts a denial outcome to the run's Slack thread on deny", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-6", issueNumber: 6, issueTitle: "Bug" });
    await store.updateRun("run-6", {
      status: "awaiting_approval",
      pendingPr,
      slackChannelId: "C123",
      slackThreadTs: "1000.001",
    });

    await resolvePendingPr(store, "run-6", "deny", fakeOctokit("unused"));

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain("Denied");
  });
});
