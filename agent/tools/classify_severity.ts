import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { haikuModel, HAIKU_MODEL_ID } from "../lib/anthropic";
import { calculateCostUsd } from "../lib/pricing";
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
    console.log(`[classify_severity] issue #${issueNumber} session=${ctx.session.id}`);
    // Never swallow: a failed createRun means the run is invisible on the dashboard, which is
    // exactly the class of silent failure that cost a full debugging session here.
    await store.createRun({ runId: ctx.session.id, issueNumber, issueTitle }).catch((err) => {
      console.error(`[classify_severity] ✖ createRun failed:`, err);
    });
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
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    await store
      .recordModelCall(ctx.session.id, {
        phase: "classify_severity",
        model: HAIKU_MODEL_ID,
        costUsd: calculateCostUsd(HAIKU_MODEL_ID, inputTokens, outputTokens),
        inputTokens,
        outputTokens,
        at: new Date().toISOString(),
      })
      .catch((err) => {
        // Swallowing this blinds the cost dashboard and the spend guardrail.
        console.error(`[classify_severity] ✖ recordModelCall failed:`, err);
      });
    await store
      .updateRun(ctx.session.id, { severity: object.severity, status: "fixing" })
      .catch((err) => {
        console.error(`[classify_severity] ✖ updateRun failed:`, err);
      });
    return object;
  },
});
