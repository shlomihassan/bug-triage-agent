import { describe, it, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { hashContent, upsertChunks } from "../indexing/embed-semantic";
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
});
