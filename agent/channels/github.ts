import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";

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
  // Lets a maintainer @-mention the bot on the issue thread to continue the conversation
  // generally (e.g. asking a follow-up question). NOT used for open_pr approvals — see
  // PendingPr in lib/store.ts for why that's resolved directly from the dashboard instead of
  // through a resumed session.
  onComment: (ctx, comment) => {
    if (!MENTION_PATTERN.test(comment.body)) return null;
    const auth = defaultGitHubAuth(ctx);
    if (!auth) return null;
    return { auth };
  },
  // NOTE: deliberately no `events` overrides here. Per eve's GitHubChannelEvents docs, a handler
  // supplied for a key *replaces* the built-in rather than running alongside it — and the
  // built-ins are load-bearing: `turn.started` does the eyes reaction plus the repo checkout into
  // /workspace, and `turn.failed`/`session.failed` post the error comment on the issue. Adding
  // log-only handlers here would silently disable the checkout and swallow failure reporting.
});
