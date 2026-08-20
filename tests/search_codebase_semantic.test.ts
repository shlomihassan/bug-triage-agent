import { describe, it, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { openCodeIntelligenceDb } from "../agent/lib/code-intelligence-db";
import { searchChunks } from "../agent/tools/search_codebase_semantic";

const TEST_DB_PATH = "/tmp/search-codebase-semantic-test.sqlite";

function seed(db: ReturnType<typeof openCodeIntelligenceDb>) {
  const insertChunk = db.prepare(
    "INSERT INTO chunks (rowid, id, symbol_id, file_path, start_line, end_line, language, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // Chunk A's embedding points mostly along dimension 0; chunk B along dimension 1.
  const near = new Array(1024).fill(0);
  near[0] = 1;
  const far = new Array(1024).fill(0);
  far[1] = 1;
  insertChunk.run(1, "a.go:1-5", "s:a", "a.go", 1, 5, "go", "hash-a");
  // Note: vec0 (sqlite-vec virtual table) rejects rowid as a bound parameter, so we interpolate it.
  db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (1, vec_f32(?))").run(JSON.stringify(near));
  insertChunk.run(2, "b.go:1-5", "s:b", "b.go", 1, 5, "go", "hash-b");
  db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (2, vec_f32(?))").run(JSON.stringify(far));
}

describe("searchChunks", () => {
  afterEach(() => {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  });

  it("returns the nearest chunk first by embedding distance", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH);
    seed(db);
    const queryEmbedding = new Array(1024).fill(0);
    queryEmbedding[0] = 1; // matches chunk A exactly
    const results = searchChunks(db, queryEmbedding, 2);
    db.close();
    expect(results[0].filePath).toBe("a.go");
    expect(results).toHaveLength(2);
  });

  it("skips results where chunks_vec rowid has no corresponding chunks row (data consistency edge case)", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH);
    seed(db);
    // Create an orphaned chunks_vec entry with rowid 99 but no corresponding chunks row
    const orphanEmbedding = new Array(1024).fill(0);
    orphanEmbedding[0] = 0.5; // closer to query than chunk B
    db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (99, vec_f32(?))").run(JSON.stringify(orphanEmbedding));

    const queryEmbedding = new Array(1024).fill(0);
    queryEmbedding[0] = 1;
    const results = searchChunks(db, queryEmbedding, 10);
    db.close();

    // Should return only the 2 valid chunks, skipping the orphaned rowid 99
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.filePath && r.startLine !== undefined && r.endLine !== undefined)).toBe(true);
  });
});
