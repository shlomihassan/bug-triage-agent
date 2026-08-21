import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { haikuModel, HAIKU_MODEL_ID } from "../lib/anthropic";
import { calculateCostUsd } from "../lib/pricing";
import { createRedisStore } from "../lib/store";
import { postToRunThread, updateRunThreadMessage } from "../lib/slack-notify";

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
    console.log(`[classify_severity] issue #${issueNumber} session=${ctx.session.id}`);
    // Belt-and-suspenders createRun: agent/hooks/run-tracking.ts already created a placeholder
    // row at session.started, so this is normally a no-op (createRun's NX semantics never
    // overwrite an existing row) — it only actually creates a row if that hook somehow didn't
    // fire. Never swallow: a failed createRun means the run is invisible on the dashboard.
    await store.createRun({ runId: ctx.session.id, issueNumber, issueTitle }).catch((err) => {
      console.error(`[classify_severity] ✖ createRun failed:`, err);
    });
    // Overwrite the placeholder's issueNumber/issueTitle ("(investigating…)") with the real
    // values now that they're known — createRun's NX above will not touch them if the eager
    // hook already created the row, so this is the one place they actually get set for real.
    await store.updateRun(ctx.session.id, { issueNumber, issueTitle }).catch((err) => {
      console.error(`[classify_severity] ✖ updateRun (issue details) failed:`, err);
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
    const cacheReadTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens ?? 0;
    await store
      .recordModelCall(ctx.session.id, {
        phase: "classify_severity",
        model: HAIKU_MODEL_ID,
        costUsd: calculateCostUsd(HAIKU_MODEL_ID, inputTokens, outputTokens, {
          cacheReadTokens,
          cacheWriteTokens,
        }),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
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
    // Per the design's step 2: edit the session.started placeholder ("🔍 Investigating a new
    // issue…") in place with the real issue number/title now that they're known, then post the
    // triage summary as a threaded reply — mirroring what already goes into the GitHub issue
    // comment. Only attempted if the placeholder was actually posted (slackPlaceholderTs set);
    // otherwise there's nothing to edit and this is skipped, matching the "skip rather than start
    // a disconnected thread" rule in the design's error-handling section.
    const runForSlack = await store.getRun(ctx.session.id).catch(() => null);
    if (runForSlack?.slackPlaceholderTs) {
      await updateRunThreadMessage(store, ctx.session.id, runForSlack.slackPlaceholderTs, {
        text: `*#${issueNumber}: ${issueTitle}*`,
      }).catch((err) => console.error(`[classify_severity] ✖ Slack placeholder update failed:`, err));
    }
    await postToRunThread(store, ctx.session.id, {
      text:
        `*#${issueNumber}: ${issueTitle}*\n` +
        `Severity: *${object.severity}* — ${object.rationale}\n` +
        `Root cause: ${rootCause}`,
    }).catch((err) => console.error(`[classify_severity] ✖ Slack post failed:`, err));
    return object;
  },
});
