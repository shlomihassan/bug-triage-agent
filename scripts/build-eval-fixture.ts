// scripts/build-eval-fixture.ts
//
// Fully automated — no manual labeling step. For each closed issue, finds the real PR that
// fixed it (via GitHub's cross-reference timeline), reads that PR's actual diff, and derives:
//   - expectedOutcome: deterministically, by running the diff's real stats through the SAME
//     requiresApproval() policy function agent/lib/autonomy.ts already uses in production.
//   - expectedSeverity + referenceRootCause: via a strong model reading the issue AND the real
//     fix diff — grounded in what actually shipped, not a fresh guess.
// Issues with no identifiable merged closing PR are skipped (logged), not guessed at.
import { Octokit } from "@octokit/rest";
import { generateObject } from "ai";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../agent/lib/config";
import { opusModel } from "../agent/lib/anthropic";
import { requiresApproval } from "../agent/lib/autonomy";

interface FixtureEntry {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  expectedSeverity: "critical" | "high" | "medium" | "low";
  referenceRootCause: string;
  expectedOutcome: "auto_resolved" | "awaiting_approval";
}

const judgmentSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  blastRadiusTier: z.enum(["high", "medium", "low"]),
  rootCause: z.string().min(1).max(300),
});

async function findMergedClosingPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<number | null> {
  const timeline = await octokit.issues.listEventsForTimeline({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  for (const event of timeline.data) {
    if (event.event !== "cross-referenced") continue;
    const source = (event as { source?: { issue?: { number: number; pull_request?: { merged_at?: string | null } } } }).source;
    const pr = source?.issue?.pull_request;
    if (pr && pr.merged_at) {
      return source!.issue!.number;
    }
  }
  return null;
}

async function main() {
  const config = loadConfig();
  const octokit = new Octokit({ auth: process.env.GITHUB_PR_TOKEN });
  const issues = await octokit.issues.listForRepo({
    owner: config.githubOwner,
    repo: config.githubRepo,
    state: "closed",
    per_page: 20,
  });

  const fixture: FixtureEntry[] = [];

  for (const issue of issues.data) {
    if (issue.pull_request) continue; // this endpoint also returns PRs; skip them

    const prNumber = await findMergedClosingPr(octokit, config.githubOwner, config.githubRepo, issue.number);
    if (!prNumber) {
      console.log(`[build-eval-fixture] issue #${issue.number}: no merged closing PR found, skipping`);
      continue;
    }

    const files = await octokit.pulls.listFiles({
      owner: config.githubOwner,
      repo: config.githubRepo,
      pull_number: prNumber,
      per_page: 100,
    });
    const filesChanged = files.data.length;
    const linesChanged = files.data.reduce((sum, f) => sum + f.additions + f.deletions, 0);
    const diffText = files.data
      .map((f) => `--- ${f.filename} ---\n${f.patch ?? "(no patch available)"}`)
      .join("\n\n")
      .slice(0, 8000); // cap prompt size for large PRs

    const { object: judgment } = await generateObject({
      model: opusModel(),
      schema: judgmentSchema,
      system:
        "You are grading a historical bug fix. Given the original issue report and the actual " +
        "diff that fixed it, classify: severity (critical/high/medium/low, from user-facing " +
        "impact), blastRadiusTier (high if the diff touches auth/permissions, database " +
        "migrations, or a public API contract; medium for a moderate contained change; low for " +
        "a small isolated change), and a one-sentence rootCause grounded in what the diff " +
        "actually changed.",
      prompt: JSON.stringify({ issueTitle: issue.title, issueBody: issue.body ?? "", diffText }),
    });

    const expectedOutcome = requiresApproval({
      severity: judgment.severity,
      blastRadiusTier: judgment.blastRadiusTier,
      filesChanged,
      linesChanged,
      checksAllPassed: true, // ground truth reflects the shipped fix, which passed CI by definition
      reproTestPassed: true,
    })
      ? "awaiting_approval"
      : "auto_resolved";

    fixture.push({
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueBody: issue.body ?? "",
      expectedSeverity: judgment.severity,
      referenceRootCause: judgment.rootCause,
      expectedOutcome,
    });
    console.log(`[build-eval-fixture] issue #${issue.number}: derived from PR #${prNumber} → ${judgment.severity}/${expectedOutcome}`);
  }

  writeFileSync("evals/fixtures/labeled-issues.json", JSON.stringify(fixture, null, 2) + "\n");
  console.log(`[build-eval-fixture] Wrote ${fixture.length} fully-labeled entries to evals/fixtures/labeled-issues.json`);
}

main().catch((err) => {
  console.error("[build-eval-fixture] failed:", err);
  process.exitCode = 1;
});
