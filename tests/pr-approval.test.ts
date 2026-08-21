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
