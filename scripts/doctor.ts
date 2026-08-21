/**
 * Health check for the bug-triage-agent deployment.
 *
 * Written after a full debugging session was spent on a failure that produced no
 * error anywhere: the Vercel Connect GitHub authorization lapsed, so eve
 * acknowledged every webhook and silently declined to dispatch a turn. Webhooks
 * arrived, tools loaded, the database was healthy — and nothing ran. The only
 * real signal was the *absence* of things.
 *
 * This script checks each link in the chain in order and names the first broken
 * one, so that failure takes seconds to identify instead of hours.
 *
 * Run: npx tsx scripts/doctor.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Redis } from "@upstash/redis";
import { Pool } from "pg";

type Check = { name: string; ok: boolean; detail: string; fix?: string };
const checks: Check[] = [];

function loadEnvLocal(): void {
  let raw: string;
  try {
    raw = readFileSync(".env.local", "utf-8");
  } catch {
    return; // fine in CI / when vars come from the environment
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * The check that would have saved the session. A lapsed Connect authorization is
 * invisible at runtime: onIssue still runs, still returns, and eve just declines
 * to dispatch. Nothing logs, nothing throws, no comment is posted.
 */
function checkGitHubAuth(): void {
  let output: string;
  try {
    output = execFileSync("vercel", ["connect", "token", "github/bug-triage-agent"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  // Never print the token itself — only whether it resolved.
  const broken = /authorization required|error|expired|invalid|not found|failed/i.test(output);
  checks.push({
    name: "GitHub Connect authorization",
    ok: !broken,
    detail: broken
      ? "Token will not mint. eve will acknowledge webhooks and silently skip dispatch: " +
        "no turn, no eyes reaction, no tool calls, no run row."
      : "Token mints.",
    fix: "vercel connect open github/bug-triage-agent  → re-authorize in the browser",
  });
}

async function checkRedis(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    checks.push({
      name: "Redis (run store)",
      ok: false,
      detail: "Missing REST credentials.",
      fix: "Set KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*) in Vercel, then redeploy.",
    });
    return;
  }
  try {
    const redis = new Redis({ url, token });
    const ids = await redis.lrange<string>("bug-run-index", 0, -1);
    let newest = "never";
    if (ids.length > 0) {
      const run = await redis.get<{ startedAt?: string }>(`bug-run:${ids[0]}`);
      newest = run?.startedAt ?? "unknown";
    }
    checks.push({
      name: "Redis (run store)",
      ok: true,
      detail: `${ids.length} run(s); most recent started ${newest}`,
    });
  } catch (err) {
    checks.push({
      name: "Redis (run store)",
      ok: false,
      detail: `Query failed: ${(err as Error).message}`,
    });
  }
}

async function checkNeon(): Promise<void> {
  if (!process.env.DATABASE_URL_UNPOOLED) {
    checks.push({
      name: "Neon (code intelligence)",
      ok: false,
      detail: "DATABASE_URL_UNPOOLED not set.",
    });
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  try {
    const symbols = await pool.query("SELECT COUNT(*) FROM code_intelligence.symbols");
    const edges = await pool.query("SELECT COUNT(*) FROM code_intelligence.edges");
    const vecs = await pool.query("SELECT COUNT(*) FROM code_intelligence.chunks_vec");
    const nVec = Number(vecs.rows[0].count);
    checks.push({
      name: "Neon (code intelligence)",
      ok: true,
      detail: `${symbols.rows[0].count} symbols, ${edges.rows[0].count} edges, ${nVec} embeddings`,
    });
    if (nVec === 0) {
      checks.push({
        name: "Semantic search embeddings",
        ok: false,
        detail:
          "chunks_vec is empty, so search_codebase_semantic cannot rank by similarity. " +
          "The embeddings never migrated (sql.js cannot read the vec0 virtual table).",
        fix: "Re-embed directly into Neon, or accept grep/read fallback during triage.",
      });
    }
  } catch (err) {
    checks.push({
      name: "Neon (code intelligence)",
      ok: false,
      detail: `Query failed: ${(err as Error).message}`,
    });
  } finally {
    await pool.end();
  }
}

/**
 * The check that actually mattered. Every model call the agent makes goes through
 * one of these two paths, and when both are shut the turn dies at its first step
 * with no reaction, no comment and no run row — indistinguishable from "the
 * webhook never arrived". On 2026-08-19 a single $5.91 run exhausted the Vercel
 * AI credit balance, dropping the account to the free tier, which is blocked from
 * Claude models. The agent was dead for a day before anyone could name why.
 */
async function checkModelAccess(): Promise<void> {
  const { generateText } = await import("ai");
  const { anthropic } = await import("@ai-sdk/anthropic");

  const errors: string[] = [];

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        prompt: "Reply with exactly: ok",
      });
      checks.push({
        name: "Model access",
        ok: true,
        detail: "Direct Anthropic API key works.",
      });
      return;
    } catch (err) {
      errors.push(`direct: ${(err as Error).message.slice(0, 120)}`);
    }
  } else {
    errors.push("direct: ANTHROPIC_API_KEY not set");
  }

  try {
    await generateText({ model: "anthropic/claude-haiku-4.5", prompt: "Reply with exactly: ok" });
    checks.push({ name: "Model access", ok: true, detail: "Vercel AI Gateway works." });
    return;
  } catch (err) {
    errors.push(`gateway: ${(err as Error).message.slice(0, 120)}`);
  }

  checks.push({
    name: "Model access",
    ok: false,
    detail:
      "No usable model path — the agent cannot run at all. Turns die at the first " +
      `model call, silently. (${errors.join(" | ")})`,
    fix:
      "Either set ANTHROPIC_API_KEY in Vercel (vercel env add ANTHROPIC_API_KEY production), " +
      "or top up Vercel AI credits at vercel.com/[team]/~/ai",
  });
}

/**
 * Plan gate. Two things this agent cannot live without are paid-only, and both fail
 * in ways that look like nothing happening at all:
 *   - Vercel Sandbox, which eve's turn.started built-in uses to check the repo out
 *     into /workspace. On Hobby the turn dies in ~1s with no reaction and no comment.
 *   - AI Gateway access to Claude models, which returns "Free tier users do not have
 *     access to this model" (bypassable with a direct ANTHROPIC_API_KEY).
 * The plan is stamped into the OIDC token, so it can be read without an API call.
 */
function checkPlan(): void {
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    checks.push({
      name: "Vercel plan",
      ok: true,
      detail: "VERCEL_OIDC_TOKEN not present locally; skipped (run `vercel env pull`).",
    });
    return;
  }
  try {
    const part = token.split(".")[1];
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64url").toString("utf-8"));
    const plan = String(claims.plan ?? "unknown");
    const hobby = plan === "hobby";
    checks.push({
      name: "Vercel plan",
      ok: !hobby,
      detail: hobby
        ? "Plan is 'hobby'. Vercel Sandbox is Pro-only, so eve cannot check the repo out " +
          "into /workspace and every turn dies before it starts — no eyes reaction, no " +
          "comment, no run row."
        : `Plan is '${plan}'.`,
      fix: "Upgrade the team to Pro at vercel.com/acme-629d/~/settings/billing",
    });
  } catch {
    checks.push({ name: "Vercel plan", ok: true, detail: "Could not decode token; skipped." });
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  checkPlan();
  checkGitHubAuth();
  await checkModelAccess();
  await checkRedis();
  await checkNeon();

  console.log("\nbug-triage-agent doctor\n");
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    console.log(`      ${c.detail}`);
    if (!c.ok && c.fix) console.log(`      fix: ${c.fix}`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(
    failed.length === 0
      ? "\nAll checks passed.\n"
      : `\n${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
