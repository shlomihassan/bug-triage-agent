import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { haikuModel } from "../lib/anthropic";
import { createRedisStore } from "../lib/store";

const severitySchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  rationale: z.string().min(1).max(300),
});

const inputSchema = z.object({
  issueNumber: z.number().int().positive(),
  issueTitle: z.string(),
  issueBody: z.string(),
  rootCause: z.string(),
  reproTestPassed: z.boolean(),
});

const store = createRedisStore();

export default defineTool({
  description:
    "Classify the user-facing severity of a bug (critical/high/medium/low) from the issue " +
    "report and the root-cause analysis already gathered. Call this once, after reproducing " +
    "the bug, before attempting a fix. This is also the first tool call of the run, and " +
    "creates the run's tracking record — always pass the real issue number and title.",
  inputSchema,
  outputSchema: severitySchema,
  async execute({ issueNumber, issueTitle, issueBody, rootCause, reproTestPassed }, ctx) {
    // Lazily creates the run row: ctx.session.id (the real, stable run identifier) only exists
    // once inside a tool/hook, never at the GitHub channel's onIssue dispatch time (Task 15) —
    // see the createRun note in Task 8.
    await store.createRun({ runId: ctx.session.id, issueNumber, issueTitle }).catch(() => {});
    const { object, usage } = await generateObject({
      model: haikuModel(),
      schema: severitySchema,
      system:
        "You are a triage assistant. Classify bug severity strictly from user-facing impact: " +
        "critical = data loss, security, or a broken core flow; high = a major feature broken " +
        "for most users; medium = a real but narrow or workaround-able issue; low = cosmetic or " +
        "edge-case. Respond with one tight sentence of rationale citing the specific impact.",
      prompt: JSON.stringify({ issueTitle, issueBody, rootCause, reproTestPassed }),
    });
    await store
      .recordModelCall(ctx.session.id, {
        phase: "classify_severity",
        model: "claude-haiku-4-5-20251001",
        costUsd: (usage as any).costUsd ?? 0,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        at: new Date().toISOString(),
      })
      .catch(() => {});
    await store.updateRun(ctx.session.id, { severity: object.severity }).catch(() => {});
    return object;
  },
});
