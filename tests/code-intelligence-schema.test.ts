import { describe, it, expect, afterEach } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { openCodeIntelligenceDb } from "../agent/lib/code-intelligence-db";

const TEST_DB_PATH = "/tmp/code-intelligence-schema-test.sqlite";

describe("openCodeIntelligenceDb", () => {
  afterEach(() => {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  });

  it("creates symbols, edges, chunks, and chunks_vec tables", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH);
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')")
      .all()
      .map((row: any) => row.name)
      .sort();
    expect(tableNames).toEqual(
      expect.arrayContaining(["symbols", "edges", "chunks", "chunks_vec"]),
    );
    db.close();
  });

  it("can insert and read back a symbol row", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH);
    db.prepare(
      "INSERT INTO symbols (id, name, kind, file, start_line, end_line, language) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("pkg/models/x.go:CanDelete:10", "CanDelete", "method", "pkg/models/x.go", 10, 20, "go");
    const row = db.prepare("SELECT * FROM symbols WHERE id = ?").get("pkg/models/x.go:CanDelete:10") as any;
    expect(row.name).toBe("CanDelete");
    db.close();
  });
});
