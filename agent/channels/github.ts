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
