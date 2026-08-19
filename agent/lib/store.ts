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
  outcome?: "auto_resolved" | "escalated" | "could_not_reproduce";
  prUrl?: string;
  startedAt: string;
  completedAt?: string;
  modelCalls: ModelCallRecord[];
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
  const redis = Redis.fromEnv();
  return {
    async createRun({ runId, issueNumber, issueTitle }) {
      const existing = await redis.get<BugRun>(RUN_KEY(runId));
      if (existing) return;
      const run: BugRun = {
        runId,
        issueNumber,
        issueTitle,
        status: "triaging",
        startedAt: new Date().toISOString(),
        modelCalls: [],
      };
      await redis.set(RUN_KEY(runId), run);
      await redis.lpush(RUN_INDEX_KEY, runId);
    },
    async updateRun(runId, patch) {
      const run = await redis.get<BugRun>(RUN_KEY(runId));
      if (!run) throw new Error(`Unknown run ${runId}`);
      await redis.set(RUN_KEY(runId), { ...run, ...patch });
    },
    async recordModelCall(runId, call) {
      const run = await redis.get<BugRun>(RUN_KEY(runId));
      if (!run) throw new Error(`Unknown run ${runId}`);
      run.modelCalls.push(call);
      await redis.set(RUN_KEY(runId), run);
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
