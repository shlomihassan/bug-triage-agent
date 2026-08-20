import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import {
  MAX_CHUNK_CHARS,
  embedTextsWithUsage,
  hashContent,
  truncateForEmbedding,
  upsertChunks,
} from "../indexing/embed-semantic";
import { openCodeIntelligenceDb } from "../agent/lib/code-intelligence-db";
import type { Symbol } from "../agent/lib/code-intelligence-schema";

const TEST_DB_PATH = "/tmp/embed-semantic-test.sqlite";

const SAMPLE_SYMBOL: Symbol = {
  id: "pkg/x.go:CanDelete:10",
  name: "CanDelete",
  kind: "method",
  file: "pkg/x.go",
  startLine: 10,
  endLine: 20,
  language: "go",
};

describe("hashContent", () => {
  it("returns the same hash for the same text and a different hash for different text", () => {
    const a = hashContent("func CanDelete() bool { return true }");
    const b = hashContent("func CanDelete() bool { return true }");
    const c = hashContent("func CanDelete() bool { return false }");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("truncateForEmbedding", () => {
  it("leaves normal-sized symbols untouched", () => {
    const text = "func CanDelete() bool { return true }";
    expect(truncateForEmbedding(text)).toBe(text);
  });

  it("caps oversized symbols so one input can never exceed a minute's token budget", () => {
    const huge = "x".repeat(MAX_CHUNK_CHARS * 4);
    expect(truncateForEmbedding(huge).length).toBe(MAX_CHUNK_CHARS);
  });
});

describe("embedTextsWithUsage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("splits oversized input across requests and sums the token usage the API reports", async () => {
    // Generous limits so the pacer does not actually sleep during the test.
    vi.stubEnv("VOYAGE_RPM", "1000");
    vi.stubEnv("VOYAGE_TPM", "6000");
    // 6000 TPM / 1000 RPM would be tiny, so the floor is one max-size chunk (2000 tokens);
    // each 3000-char text is ~1000 estimated tokens, so two texts fit per request.
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as { input: string[] };
      bodies.push(parsed.input.length);
      return {
        ok: true,
        json: async () => ({
          data: parsed.input.map(() => ({ embedding: new Array(1024).fill(0.5) })),
          usage: { total_tokens: 100 },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const texts = new Array(6).fill("y".repeat(3000));
    const result = await embedTextsWithUsage(texts, "test-key");

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.embeddings).toHaveLength(6);
    // One embedding per input, and usage summed across every request that was made.
    expect(result.totalTokens).toBe(100 * fetchMock.mock.calls.length);
    expect(bodies.reduce((a, b) => (a as number) + (b as number), 0)).toBe(6);
  });

  it("fails fast on a non-retryable error instead of burning the retry budget", async () => {
    vi.stubEnv("VOYAGE_RPM", "1000");
    vi.stubEnv("VOYAGE_TPM", "1000000");
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(embedTextsWithUsage(["hello"], "bad-key")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("upsertChunks", () => {
  afterEach(() => {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  });

  it("inserts a new chunk with its embedding", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH);
    const embedding = new Array(1024).fill(0.01);
    upsertChunks(db, [{ symbol: SAMPLE_SYMBOL, text: "func CanDelete() bool { return true }", embedding }]);

    const chunkRow = db.prepare("SELECT * FROM chunks WHERE symbol_id = ?").get(SAMPLE_SYMBOL.id) as any;
    expect(chunkRow.file_path).toBe("pkg/x.go");

    const vecRow = db.prepare("SELECT rowid FROM chunks_vec WHERE rowid = ?").get(chunkRow.rowid);
    expect(vecRow).toBeTruthy();
    db.close();
  });

  it("skips re-embedding when content hash is unchanged, replaces when it changed", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH);
    const embedding1 = new Array(1024).fill(0.01);
    upsertChunks(db, [{ symbol: SAMPLE_SYMBOL, text: "same text", embedding: embedding1 }]);
    const firstCount = (db.prepare("SELECT count(*) as c FROM chunks").get() as any).c;

    // Same text again — same content hash, should not duplicate.
    upsertChunks(db, [{ symbol: SAMPLE_SYMBOL, text: "same text", embedding: embedding1 }]);
    const secondCount = (db.prepare("SELECT count(*) as c FROM chunks").get() as any).c;
    expect(secondCount).toBe(firstCount);

    // Different text — same symbol id, should replace (still one row for this symbol).
    const embedding2 = new Array(1024).fill(0.02);
    upsertChunks(db, [{ symbol: SAMPLE_SYMBOL, text: "different text", embedding: embedding2 }]);
    const thirdCount = (db.prepare("SELECT count(*) as c FROM chunks WHERE symbol_id = ?").get(SAMPLE_SYMBOL.id) as any).c;
    expect(thirdCount).toBe(1);
    db.close();
  });

  it("maintains explicit rowid linkage between chunks and chunks_vec through delete/insert cycles", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH);
    const embedding1 = new Array(1024).fill(0.01);
    const embedding2 = new Array(1024).fill(0.02);
    const embedding3 = new Array(1024).fill(0.03);

    const symbol1: Symbol = {
      id: "pkg/a.go:Func1:10",
      name: "Func1",
      kind: "function",
      file: "pkg/a.go",
      startLine: 10,
      endLine: 20,
      language: "go",
    };

    const symbol2: Symbol = {
      id: "pkg/b.go:Func2:30",
      name: "Func2",
      kind: "function",
      file: "pkg/b.go",
      startLine: 30,
      endLine: 40,
      language: "go",
    };

    const symbol3: Symbol = {
      id: "pkg/c.go:Func3:50",
      name: "Func3",
      kind: "function",
      file: "pkg/c.go",
      startLine: 50,
      endLine: 60,
      language: "go",
    };

    // Insert first two chunks
    upsertChunks(db, [
      { symbol: symbol1, text: "func1 code", embedding: embedding1 },
      { symbol: symbol2, text: "func2 code", embedding: embedding2 },
    ]);

    // Verify all chunks have corresponding vectors
    const chunk1Row = db.prepare("SELECT rowid FROM chunks WHERE symbol_id = ?").get(symbol1.id) as any;
    const chunk2Row = db.prepare("SELECT rowid FROM chunks WHERE symbol_id = ?").get(symbol2.id) as any;
    const vec1 = db.prepare("SELECT rowid FROM chunks_vec WHERE rowid = ?").get(chunk1Row.rowid);
    const vec2 = db.prepare("SELECT rowid FROM chunks_vec WHERE rowid = ?").get(chunk2Row.rowid);
    expect(vec1).toBeTruthy();
    expect(vec2).toBeTruthy();

    // Delete the first chunk (this could fragment rowids)
    db.prepare("DELETE FROM chunks_vec WHERE rowid = ?").run(chunk1Row.rowid);
    db.prepare("DELETE FROM chunks WHERE rowid = ?").run(chunk1Row.rowid);

    // Insert a third chunk (its rowid should now be reused or continue sequence)
    upsertChunks(db, [{ symbol: symbol3, text: "func3 code", embedding: embedding3 }]);

    // Verify the remaining chunks (2 and 3) still have matching rowids in both tables
    const chunk2RowAfter = db.prepare("SELECT rowid FROM chunks WHERE symbol_id = ?").get(symbol2.id) as any;
    const chunk3RowAfter = db.prepare("SELECT rowid FROM chunks WHERE symbol_id = ?").get(symbol3.id) as any;

    // Verify vec linkage is explicit (rowid must exist in chunks_vec)
    const vec2After = db.prepare("SELECT rowid FROM chunks_vec WHERE rowid = ?").get(chunk2RowAfter.rowid);
    const vec3After = db.prepare("SELECT rowid FROM chunks_vec WHERE rowid = ?").get(chunk3RowAfter.rowid);
    expect(vec2After).toBeTruthy();
    expect(vec3After).toBeTruthy();

    // Verify row counts match between tables
    const chunkCount = (db.prepare("SELECT count(*) as c FROM chunks").get() as any).c;
    const vecCount = (db.prepare("SELECT count(*) as c FROM chunks_vec").get() as any).c;
    expect(vecCount).toBe(chunkCount);

    db.close();
  });
});
