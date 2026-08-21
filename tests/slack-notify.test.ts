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
