import { defineTool } from "eve/tools";
import { z } from "zod";
import { Redis } from "@upstash/redis";

export const NOTES_KEY = "codebase-notes";

console.log(`[tools] 📦 Loading read_notes tool`);

export default defineTool({
  description:
    "Read accumulated notes about this codebase from prior bug-triage runs (file locations, " +
    "patterns, gotchas actually discovered). Call this first, before exploring the repo, so " +
    "earlier findings aren't rediscovered from scratch.",
  inputSchema: z.object({}),
  outputSchema: z.object({ notes: z.array(z.string()) }),
  async execute() {
    console.log(`[read_notes] 📖 Executing - fetching notes from Redis`);
    try {
      const redis = Redis.fromEnv();
      const notes = await redis.lrange<string>(NOTES_KEY, 0, -1);
      console.log(`[read_notes] ✅ Retrieved ${notes.length} notes`);
      return { notes };
    } catch (err) {
      console.error(`[read_notes] ❌ Error reading notes:`, err);
      throw err;
    }
  },
});
