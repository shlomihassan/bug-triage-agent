// agent/tools/assess_blast_radius.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { haikuModel, HAIKU_MODEL_ID } from "../lib/anthropic";
import { calculateCostUsd } from "../lib/pricing";
import { createRedisStore } from "../lib/store";

const blastRadiusSchema = z.object({
  blastRadiusTier: z.enum(["high", "medium", "low"]),
  rationale: z.string().min(1).max(300),
});

const inputSchema = z.object({
  diff: z.string(),
  filesChanged: z.array(z.string()),
});

const store = createRedisStore();

export default defineTool({
  description:
    "Assess the blast radius of a candidate fix diff: high if it touches auth/permissions, " +
    "database migrations, or public API contracts; medium for a moderate, contained change; " +
    "low for a small, isolated change with no sensitive surface. Call this once a fix diff " +
    "exists, before attempting to open a PR.",
  inputSchema,
  outputSchema: blastRadiusSchema,
  async execute({ diff, filesChanged }, ctx) {
    const { object, usage } = await generateObject({
      model: haikuModel(),
      schema: blastRadiusSchema,
      system:
        "You are a risk-assessment assistant. Rate the blast radius of a code change: " +
        "high = touches authentication, authorization/permission checks, database migrations, " +
        "or a public API contract; medium = a moderate, self-contained change outside those " +
        "areas; low = a small, isolated change with no sensitive surface. Cite the specific " +
        "file(s)/pattern that drove the rating in one tight sentence.",
      prompt: JSON.stringify({ filesChanged, diff }),
    });
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    await store
      .recordModelCall(ctx.session.id, {
        phase: "assess_blast_radius",
        model: HAIKU_MODEL_ID,
        costUsd: calculateCostUsd(HAIKU_MODEL_ID, inputTokens, outputTokens),
        inputTokens,
        outputTokens,
        at: new Date().toISOString(),
      })
      .catch(() => {});
    await store.updateRun(ctx.session.id, { blastRadiusTier: object.blastRadiusTier }).catch(() => {});
    return object;
  },
});
