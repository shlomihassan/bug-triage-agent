import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryStore } from "../agent/lib/store";
import { postToRunThread, updateRunThreadMessage } from "../agent/lib/slack-notify";

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

  it("returns the posted message's ts", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-4", issueNumber: 4, issueTitle: "Bug" });

    const ts = await postToRunThread(store, "run-4", { text: "Investigating…" });

    expect(ts).toBe("1000.001");
  });
});

describe("updateRunThreadMessage", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  });

  it("calls chat.update with the given ts and channel", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-5", issueNumber: 5, issueTitle: "Bug" });
    await store.updateRun("run-5", { slackChannelId: "C123", slackThreadTs: "1000.001" });

    await updateRunThreadMessage(store, "run-5", "1000.001", { text: "#5: Real title" });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.update");
    const body = JSON.parse(init.body as string);
    expect(body.ts).toBe("1000.001");
    expect(body.channel).toBe("C123");
    expect(body.text).toBe("#5: Real title");
  });

  it("does not throw when SLACK_BOT_TOKEN is unset", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const store = createMemoryStore();
    await store.createRun({ runId: "run-6", issueNumber: 6, issueTitle: "Bug" });

    await expect(
      updateRunThreadMessage(store, "run-6", "1000.001", { text: "hi" }),
    ).resolves.toBeUndefined();
  });

  it("logs but does not throw when Slack responds with ok:false", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "run-7", issueNumber: 7, issueTitle: "Bug" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "message_not_found" }), {
            status: 200,
          }),
      ),
    );

    await expect(
      updateRunThreadMessage(store, "run-7", "bogus-ts", { text: "hi" }),
    ).resolves.toBeUndefined();
  });
});
