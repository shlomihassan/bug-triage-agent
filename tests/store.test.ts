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
