import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { createRedisStore } from "../lib/store";

const store = createRedisStore();
const BOT_NAME = "bug-triage-agent";
// eve's own defaultOnComment (equivalent mention-gate logic) isn't part of the public
// `eve/channels/github` export surface — only its type-level building blocks are — so this
// reproduces the check directly: dispatch only when the comment @mentions the bot, the same
// gate eve's built-in comment handling uses, to avoid reacting to every unrelated comment.
const MENTION_PATTERN = new RegExp(`@${BOT_NAME}(?=$|[^A-Za-z0-9_-])`, "iu");

export default githubChannel({
  botName: BOT_NAME,
  // Provisioned in Task 17 via `vercel connect create github --triggers` under the UID
  // "github/bug-triage-agent" — Connect manages the GitHub App, installation token, and
  // inbound webhook verification, so no GITHUB_APP_ID/PRIVATE_KEY/WEBHOOK_SECRET here.
  credentials: connectGitHubCredentials("github/bug-triage-agent"),
  onIssue: (ctx, issue) => {
    console.log(`[github] webhook: issue #${issue.issueNumber} action=${issue.action}`);
    // "reopened" is included deliberately, not just for testing convenience: a human reopening
    // a bug ("actually this isn't fixed") is a legitimate reason to re-triage it, the same as a
    // freshly opened one.
    if (issue.action !== "opened" && issue.action !== "reopened") return null;
    // The dispatch context (GitHubConversationRef: issueNumber/kind/pullRequestNumber) has no
    // session id yet — the session doesn't exist until eve dispatches this turn. The run's
    // tracking record is created lazily inside classify_severity (Task 10), the first tool call
    // in the flow, once ctx.session.id is actually available; see the createRun note in Task 8.
    const auth = defaultGitHubAuth(ctx);
    // A null/unresolvable auth is how a lapsed Vercel Connect GitHub authorization presents:
    // eve acknowledges the webhook and silently declines to dispatch, so nothing downstream
    // ever runs — no turn, no eyes reaction, no tool calls, no run row. Make that loud.
    if (!auth) {
      console.error(
        `[github] ✖ NOT DISPATCHING issue #${issue.issueNumber}: GitHub auth did not resolve. ` +
          `The Connect authorization for "github/bug-triage-agent" is likely lapsed — ` +
          `re-authorize with: vercel connect open github/bug-triage-agent`,
      );
      return null;
    }
    console.log(`[github] dispatching issue #${issue.issueNumber} to agent`);
    return { auth };
  },
  // Without this, a human replying on the issue thread does nothing at all — confirmed live
  // (2026-08-21): a run paused at open_pr's requiresApproval gate had no way to be approved or
  // denied from GitHub, because no onComment handler existed to dispatch the reply. eve's
  // human-in-the-loop docs (docs/tools/human-in-the-loop.md) describe exactly this path: "A
  // follow-up whose text matches an option ID, option label, or numeric option index resolves
  // automatically, including approval options such as approve and deny" — but that only fires
  // if a comment reaches the session at all. Dispatching on any `@bug-triage-agent` mention is
  // the standard way eve resumes a paused session (unlike a same-session-but-wrong-channel
  // workaround, which was tried first and actually started an unrelated duplicate session
  // instead of resuming the paused one — send()/getSession() are scoped to the calling
  // channel, so only this channel can legitimately resume its own sessions).
  onComment: (ctx, comment) => {
    if (!MENTION_PATTERN.test(comment.body)) return null;
    const auth = defaultGitHubAuth(ctx);
    if (!auth) return null;
    return { auth };
  },
  // Per eve's GitHubChannelEvents docs, a handler supplied for a key *replaces* the built-in
  // rather than running alongside it — turn.started/message.completed/session.failed/turn.failed
  // are load-bearing built-ins (checkout, comment posting, error reporting) and must stay
  // undefined here so eve's defaults keep running. input.requested has no built-in handler, so
  // defining it is additive, not a replacement.
  events: {
    // Captures a paused tool-approval's requestId/options so the dashboard can resolve it
    // directly via send({inputResponses}) — GitHub comment replies don't work for this: eve
    // wraps every delivered message in a <github_context> block, which breaks its own
    // plain-text option-matching for approve/deny (confirmed live, 2026-08-21). Only
    // "tool-approval" is stored; a plain "question" input request isn't something the dashboard
    // has a use for yet.
    async "input.requested"(data, channel, ctx) {
      const approval = data.requests.find((r) => r.kind === "tool-approval");
      if (!approval) return;
      await store
        .updateRun(ctx.session.id, {
          pendingApproval: {
            requestId: approval.requestId,
            repositoryId: channel.repository.id,
            issueNumber: channel.conversation.issueNumber ?? 0,
            prompt: approval.prompt,
            options: approval.options ?? [],
          },
        })
        .catch((err) => {
          console.error(`[github] ✖ storing pendingApproval failed:`, err);
        });
    },
  },
});
