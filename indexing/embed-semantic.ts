import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Symbol } from "../agent/lib/code-intelligence-schema";

export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Voyage rejects a request outright if it carries too many inputs or too many total
// tokens, and against the real Vikunja tree the caller's fixed batch size is not a safe
// proxy for either: a batch of 100 Go functions is usually ~30k tokens but a batch that
// happens to contain a few 1000-line functions blows straight past the limit. Split
// defensively here so every caller is protected, not just the orchestrator.
const MAX_INPUTS_PER_REQUEST = 128;
// Code averages a bit under 4 characters per token; deliberately conservative so the
// estimate over-counts rather than under-counts and we stay inside the real limit.
const CHARS_PER_TOKEN = 3;

/**
 * A Voyage account without a payment method on file is limited to 3 requests/min and
 * 10,000 tokens/min (the API says so explicitly in its 429 body). Those are the defaults
 * here so an unpaid key indexes successfully, just slowly; override via VOYAGE_RPM /
 * VOYAGE_TPM once the account has standard limits (2000 RPM / 3M TPM) to index in minutes
 * instead of an hour.
 */
function rateLimits(): { rpm: number; tpm: number } {
  const rpm = Number(process.env.VOYAGE_RPM ?? 3);
  const tpm = Number(process.env.VOYAGE_TPM ?? 10_000);
  return {
    rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 3,
    tpm: Number.isFinite(tpm) && tpm > 0 ? tpm : 10_000,
  };
}

/**
 * Longest source text embedded for a single symbol. Vikunja has a handful of very large
 * generated/table-driven functions (the largest is ~67k characters); embedding one whole
 * would exceed a full minute's token budget on the unpaid tier and could never succeed.
 * Truncating at 6k characters affects 0.4% of symbols and still captures each one's
 * signature and leading body, which is what carries the retrieval signal.
 */
export const MAX_CHUNK_CHARS = 6_000;

export function truncateForEmbedding(text: string): string {
  return text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function splitIntoRequests(texts: string[]): string[][] {
  const { rpm, tpm } = rateLimits();
  // Aim each request at one RPM slot's share of the per-minute token budget, so the run is
  // limited by tokens rather than wasting request slots on tiny payloads.
  const maxTokensPerRequest = Math.max(estimateTokens("x".repeat(MAX_CHUNK_CHARS)), Math.floor(tpm / rpm));
  const requests: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const text of texts) {
    const tokens = estimateTokens(text);
    if (current.length > 0 && (current.length >= MAX_INPUTS_PER_REQUEST || currentTokens + tokens > maxTokensPerRequest)) {
      requests.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sliding-60s-window pacer shared by every request this process makes. */
const recentRequests: { at: number; tokens: number }[] = [];

async function awaitRateLimitSlot(tokens: number): Promise<void> {
  const { rpm, tpm } = rateLimits();
  for (;;) {
    const now = Date.now();
    while (recentRequests.length > 0 && now - recentRequests[0].at >= 60_000) recentRequests.shift();
    const usedTokens = recentRequests.reduce((sum, r) => sum + r.tokens, 0);
    if (recentRequests.length < rpm && usedTokens + tokens <= tpm) {
      recentRequests.push({ at: now, tokens });
      return;
    }
    // Wait until the oldest entry ages out of the window, then re-check.
    const waitMs = recentRequests.length > 0 ? 60_000 - (now - recentRequests[0].at) + 250 : 1_000;
    await sleep(Math.max(waitMs, 250));
  }
}

async function embedOneRequest(
  texts: string[],
  apiKey: string,
): Promise<{ embeddings: number[][]; totalTokens: number }> {
  const MAX_ATTEMPTS = 8;
  const estimated = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await awaitRateLimitSlot(estimated);
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: "voyage-code-4", truncation: true }),
    });
    if (response.ok) {
      const body = (await response.json()) as {
        data: { embedding: number[] }[];
        usage?: { total_tokens?: number };
      };
      return {
        embeddings: body.data.map((item) => item.embedding),
        totalTokens: body.usage?.total_tokens ?? 0,
      };
    }
    lastError = `${response.status} ${await response.text()}`;
    // 429 (rate limit) and 5xx are transient; anything else is a real error, fail fast.
    if (response.status !== 429 && response.status < 500) break;
    // On a 429 the server's window is stricter than ours, so wait out a full window
    // rather than the short exponential backoff that only suits transient 5xx blips.
    await sleep(response.status === 429 ? 62_000 : Math.min(2 ** attempt, 30) * 1000);
  }
  throw new Error(`Voyage embeddings request failed: ${lastError}`);
}

/**
 * Embed texts, also reporting the token usage the Voyage API actually billed — needed to
 * track consumption against the free-tier budget.
 */
export async function embedTextsWithUsage(
  texts: string[],
  apiKey: string,
): Promise<{ embeddings: number[][]; totalTokens: number }> {
  const embeddings: number[][] = [];
  let totalTokens = 0;
  for (const request of splitIntoRequests(texts)) {
    const result = await embedOneRequest(request, apiKey);
    embeddings.push(...result.embeddings);
    totalTokens += result.totalTokens;
  }
  return { embeddings, totalTokens };
}

export async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  return (await embedTextsWithUsage(texts, apiKey)).embeddings;
}

export function upsertChunks(
  db: Database.Database,
  chunks: { symbol: Symbol; text: string; embedding: number[] }[],
): void {
  const findExisting = db.prepare("SELECT rowid, content_hash FROM chunks WHERE symbol_id = ?");
  const deleteChunk = db.prepare("DELETE FROM chunks WHERE rowid = ?");
  const deleteVec = db.prepare("DELETE FROM chunks_vec WHERE rowid = ?");
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, symbol_id, file_path, start_line, end_line, language, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const getChunkRowid = db.prepare("SELECT rowid FROM chunks WHERE id = ?");

  const upsertOne = db.transaction((chunk: { symbol: Symbol; text: string; embedding: number[] }) => {
    const contentHash = hashContent(chunk.text);
    const existing = findExisting.get(chunk.symbol.id) as { rowid: number; content_hash: string } | undefined;
    if (existing && existing.content_hash === contentHash) return; // unchanged, skip
    if (existing) {
      deleteVec.run(existing.rowid);
      deleteChunk.run(existing.rowid);
    }
    const chunkId = `${chunk.symbol.file}:${chunk.symbol.startLine}-${chunk.symbol.endLine}`;
    insertChunk.run(
      chunkId,
      chunk.symbol.id,
      chunk.symbol.file,
      chunk.symbol.startLine,
      chunk.symbol.endLine,
      chunk.symbol.language,
      contentHash,
    );
    // Explicitly read back the actual assigned rowid to ensure explicit linkage with chunks_vec
    const rowidResult = getChunkRowid.get(chunkId) as { rowid: number | bigint };
    const newRowid = Number(rowidResult.rowid);
    // Note: vec0 (sqlite-vec virtual table) rejects rowid as a bound parameter, so we interpolate it.
    // The embedding itself is safe to bind via ? since it's validated data (not untrusted).
    db.prepare(`INSERT INTO chunks_vec (rowid, embedding) VALUES (${newRowid}, vec_f32(?))`).run(
      JSON.stringify(chunk.embedding),
    );
  });

  for (const chunk of chunks) upsertOne(chunk);
}
