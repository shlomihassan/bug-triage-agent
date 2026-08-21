import { Redis } from "@upstash/redis";
import type { Severity, BlastRadiusTier } from "./autonomy";

export interface ModelCallRecord {
  readonly phase: "classify_severity" | "assess_blast_radius" | "fix" | "escalate_to_opus";
  readonly model: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly at: string;
}

export interface BugRun {
  readonly runId: string;
  readonly issueNumber: number;
  readonly issueTitle: string;
  status: "triaging" | "fixing" | "awaiting_approval" | "pr_opened" | "escalated" | "failed";
  severity?: Severity;
  blastRadiusTier?: BlastRadiusTier;
  outcome?: "auto_resolved" | "escalated" | "could_not_reproduce" | "timed_out" | "cancelled" | "cost_capped";
  prUrl?: string;
  startedAt: string;
  completedAt?: string;
  modelCalls: ModelCallRecord[];
}

// Shared with dashboard.ts and run-tracking.ts's cost-cap check — single source of truth for
// how a run's spend is computed, rather than each caller re-summing modelCalls independently.
export function totalCost(run: BugRun): number {
  return run.modelCalls.reduce((sum, call) => sum + call.costUsd, 0);
}

export interface BugRunStore {
  createRun(input: { runId: string; issueNumber: number; issueTitle: string }): Promise<void>;
  updateRun(runId: string, patch: Partial<BugRun>): Promise<void>;
  recordModelCall(runId: string, call: ModelCallRecord): Promise<void>;
  getRun(runId: string): Promise<BugRun | null>;
  listRuns(): Promise<BugRun[]>;
}

const RUN_KEY = (runId: string) => `bug-run:${runId}`;
const RUN_INDEX_KEY = "bug-run-index";

export function createMemoryStore(): BugRunStore {
  const runs = new Map<string, BugRun>();
  const order: string[] = [];
  return {
    async createRun({ runId, issueNumber, issueTitle }) {
      if (runs.has(runId)) return;
      runs.set(runId, {
        runId,
        issueNumber,
        issueTitle,
        status: "triaging",
        startedAt: new Date().toISOString(),
        modelCalls: [],
      });
      order.push(runId);
    },
    async updateRun(runId, patch) {
      const run = runs.get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      Object.assign(run, patch);
    },
    async recordModelCall(runId, call) {
      const run = runs.get(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      run.modelCalls.push(call);
    },
    async getRun(runId) {
      return runs.get(runId) ?? null;
    },
    async listRuns() {
      return [...order].reverse().map((id) => runs.get(id)!);
    },
  };
}

export function createRedisStore(): BugRunStore {
  // Support both Upstash and Vercel KV env vars
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  // Loud on misconfiguration, quiet on success: createRedisStore() runs at module scope in every
  // tool file, so an unconditional success log fires ~8x per request and buries real signal.
  if (!url || !token) {
    console.error(
      "[store] ✖ Redis REST credentials missing (need UPSTASH_REDIS_REST_URL/TOKEN or " +
        "KV_REST_API_URL/TOKEN). Run tracking will fail.",
    );
  }

  const redis = new Redis({ url, token });

  // Both updateRun and recordModelCall used to do GET-then-SET across two separate REST round
  // trips — a classic non-atomic read-modify-write. Confirmed live tonight as a real bug, not a
  // theoretical one: eve's own step redelivery (the "crashed mid-body, redelivering" pattern
  // seen earlier the same night) causes genuine concurrent execution of the same logical step,
  // and two racing GET-then-SET calls silently clobber each other — whichever SET lands last
  // wins, discarding the other's write entirely. Directly observed: a run ended with
  // status="awaiting_approval" and outcome="cost_capped" simultaneously, an inconsistent
  // combination no single code path ever writes, and recordModelCall's identical pattern means
  // a concurrent cost record could just as easily vanish rather than merely showing a corrupted
  // status. Both scripts run entirely server-side — Redis executes a Lua script as one atomic
  // operation, so no other command can interleave partway through, closing the race window
  // completely rather than narrowing it.
  const UPDATE_RUN_SCRIPT = `
    local current = redis.call('GET', KEYS[1])
    if not current then return redis.error_reply('Unknown run') end
    local run = cjson.decode(current)
    local patch = cjson.decode(ARGV[1])
    for k, v in pairs(patch) do run[k] = v end
    local merged = cjson.encode(run)
    redis.call('SET', KEYS[1], merged)
    return merged
  `;
  const RECORD_MODEL_CALL_SCRIPT = `
    local current = redis.call('GET', KEYS[1])
    if not current then return redis.error_reply('Unknown run') end
    local run = cjson.decode(current)
    table.insert(run.modelCalls, cjson.decode(ARGV[1]))
    local merged = cjson.encode(run)
    redis.call('SET', KEYS[1], merged)
    return merged
  `;

  return {
    async createRun({ runId, issueNumber, issueTitle }) {
      try {
        const run: BugRun = {
          runId,
          issueNumber,
          issueTitle,
          status: "triaging",
          startedAt: new Date().toISOString(),
          modelCalls: [],
        };
        // Atomic: SET key value NX returns null if key already exists
        const result = await redis.set(RUN_KEY(runId), run, { nx: true });
        // Only add to index if the set succeeded (result is "OK")
        if (result) {
          await redis.lpush(RUN_INDEX_KEY, runId);
        }
        console.log(`✓ Created run: ${runId}`);
      } catch (err) {
        console.error(`❌ Failed to create run:`, err);
        throw err;
      }
    },
    async updateRun(runId, patch) {
      try {
        await redis.eval(UPDATE_RUN_SCRIPT, [RUN_KEY(runId)], [JSON.stringify(patch)]);
      } catch (err) {
        // The script's redis.error_reply('Unknown run') surfaces here as a thrown error whose
        // message contains that text — normalize it to the same error shape callers already
        // expect from the pre-atomic implementation.
        if (err instanceof Error && err.message.includes("Unknown run")) {
          throw new Error(`Unknown run ${runId}`);
        }
        throw err;
      }
    },
    async recordModelCall(runId, call) {
      try {
        await redis.eval(RECORD_MODEL_CALL_SCRIPT, [RUN_KEY(runId)], [JSON.stringify(call)]);
      } catch (err) {
        if (err instanceof Error && err.message.includes("Unknown run")) {
          throw new Error(`Unknown run ${runId}`);
        }
        throw err;
      }
    },
    async getRun(runId) {
      return (await redis.get<BugRun>(RUN_KEY(runId))) ?? null;
    },
    async listRuns() {
      const ids = await redis.lrange<string>(RUN_INDEX_KEY, 0, -1);
      const runs = await Promise.all(ids.map((id) => redis.get<BugRun>(RUN_KEY(id))));
      return runs.filter((r): r is BugRun => r !== null);
    },
  };
}
