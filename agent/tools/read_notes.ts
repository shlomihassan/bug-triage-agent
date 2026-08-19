import { defineTool } from "eve/tools";
import { z } from "zod";
import { Redis } from "@upstash/redis";

export const NOTES_KEY = "codebase-notes";

export default defineTool({
  description:
    "Read accumulated notes about this codebase from prior bug-triage runs (file locations, " +
    "patterns, gotchas actually discovered). Call this first, before exploring the repo, so " +
    "earlier findings aren't rediscovered from scratch.",
  inputSchema: z.object({}),
  outputSchema: z.object({ notes: z.array(z.string()) }),
  async execute() {
    const redis = Redis.fromEnv();
    const notes = await redis.lrange<string>(NOTES_KEY, 0, -1);
    return { notes };
  },
});
