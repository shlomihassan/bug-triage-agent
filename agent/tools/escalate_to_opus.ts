import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateText } from "ai";
import { opusModel, OPUS_MODEL_ID } from "../lib/anthropic";
import { calculateCostUsd } from "../lib/pricing";
import { createRedisStore } from "../lib/store";

const inputSchema = z.object({
  issueTitle: z.string(),
  issueBody: z.string(),
  rootCause: z.string(),
  attemptedDiffs: z.array(z.string()).describe("Each prior fix attempt's diff, in order"),
  lastTestOutput: z.string().describe("Output of the repro test after the most recent attempt"),
});

const store = createRedisStore();

export default defineTool({
  description:
    "Call only after at least 3 failed attempts to make the repro test pass. Hands the full " +
    "attempt history to a stronger model for a fix suggestion. Deliberately expensive — do not " +
    "call this speculatively.",
  inputSchema,
  async execute(input, ctx) {
    const { text, usage } = await generateText({
      model: opusModel(),
      system:
        "You are a senior engineer brought in after 3 failed fix attempts. Read the attempted " +
        "diffs and the failing test output, diagnose why they didn't work, and propose a " +
        "concrete fix as a unified diff or precise file-by-file instructions.",
      prompt: JSON.stringify(input),
    });
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    await store
      .recordModelCall(ctx.session.id, {
        phase: "escalate_to_opus",
        model: OPUS_MODEL_ID,
        costUsd: calculateCostUsd(OPUS_MODEL_ID, inputTokens, outputTokens),
        inputTokens,
        outputTokens,
        at: new Date().toISOString(),
      })
      // Opus is the most expensive call in the system — losing its cost record silently is the
      // worst case for the spend guardrail.
      .catch((err) => console.error(`[escalate_to_opus] ✖ recordModelCall failed:`, err));
    return { suggestion: text };
  },
});
