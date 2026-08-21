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
