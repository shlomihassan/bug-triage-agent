import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { readFileSync } from "fs";
import { join } from "path";

// Load agent instructions once at startup
let INSTRUCTIONS: string;
try {
  INSTRUCTIONS = readFileSync(join(import.meta.dirname, "../instructions.md"), "utf-8");
  console.log(`[github] 📋 Loaded instructions.md (${INSTRUCTIONS.length} chars)`);
} catch (err) {
  console.error(`[github] ❌ Failed to load instructions.md:`, err);
  INSTRUCTIONS = "";
}

export default githubChannel({
  botName: "bug-triage-agent",
  // Provisioned in Task 17 via `vercel connect create github --triggers` under the UID
  // "github/bug-triage-agent" — Connect manages the GitHub App, installation token, and
  // inbound webhook verification, so no GITHUB_APP_ID/PRIVATE_KEY/WEBHOOK_SECRET here.
  credentials: connectGitHubCredentials("github/bug-triage-agent"),
  onIssue: (ctx, issue) => {
    console.log(`[github] 🔔 Webhook received for issue #${issue.issueNumber}: action=${issue.action}`);
    // "reopened" is included deliberately, not just for testing convenience: a human reopening
    // a bug ("actually this isn't fixed") is a legitimate reason to re-triage it, the same as a
    // freshly opened one.
    if (issue.action !== "opened" && issue.action !== "reopened") {
      console.log(`[github] ⏭️  Skipping - action not opened/reopened`);
      return null;
    }
    // The dispatch context (GitHubConversationRef: issueNumber/kind/pullRequestNumber) has no
    // session id yet — the session doesn't exist until eve dispatches this turn. The run's
    // tracking record is created lazily inside classify_severity (Task 10), the first tool call
    // in the flow, once ctx.session.id is actually available; see the createRun note in Task 8.
    console.log(`[github] ✅ Dispatching issue #${issue.issueNumber} to agent with instructions`);
    return {
      auth: defaultGitHubAuth(ctx),
      context: INSTRUCTIONS ? [INSTRUCTIONS] : undefined,
    };
  },
});
