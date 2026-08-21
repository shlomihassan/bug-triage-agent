import { defineTool } from "eve/tools";
import { z } from "zod";
import { Redis } from "@upstash/redis";
import { NOTES_KEY } from "./read_notes";

export default defineTool({
  description:
    "Append one short, concrete note to the shared codebase-notes log for future bug-triage " +
    "runs — e.g. 'auth checks live in pkg/models/*_permissions.go, not the route handlers'. " +
    "Call this once at the end of every run, whether or not the bug was fixed.",
  inputSchema: z.object({ note: z.string().min(1).max(300) }),
  outputSchema: z.object({ ok: z.literal(true) }),
  async execute({ note }) {
    const redis = Redis.fromEnv();
    await redis.rpush(NOTES_KEY, note);
    return { ok: true };
  },
});
