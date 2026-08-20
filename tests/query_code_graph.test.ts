import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { openCodeIntelligenceDb } from "../agent/lib/code-intelligence-db";
import { findRelatedSymbols } from "../agent/tools/query_code_graph";

const TEST_DB_PATH = "/tmp/query-code-graph-test.sqlite";

// Graph: main -> caller -> helper
function seed(db: ReturnType<typeof openCodeIntelligenceDb>) {
  const insertSymbol = db.prepare(
    "INSERT INTO symbols (id, name, kind, file, start_line, end_line, language) VALUES (?, ?, 'function', ?, ?, ?, 'go')",
  );
  insertSymbol.run("s:helper", "helper", "x.go", 1, 5);
  insertSymbol.run("s:caller", "caller", "x.go", 10, 20);
  insertSymbol.run("s:main", "main", "x.go", 30, 40);
  const insertEdge = db.prepare("INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'calls')");
  insertEdge.run("s:caller", "s:helper");
  insertEdge.run("s:main", "s:caller");
}

describe("findRelatedSymbols", () => {
  beforeEach(() => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH);
    seed(db);
    db.close();
  });

  afterEach(() => {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  });

  it("finds direct and transitive callers up to the given depth", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "helper", direction: "callers", depth: 2 });
    db.close();
    const names = result.matches.map((r) => r.symbol).sort();
    expect(names).toEqual(["caller", "main"]);
  });

  it("limits by depth", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "helper", direction: "callers", depth: 1 });
    db.close();
    expect(result.matches.map((r) => r.symbol)).toEqual(["caller"]);
  });

  it("finds callees", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "main", direction: "callees", depth: 2 });
    db.close();
    expect(result.matches.map((r) => r.symbol).sort()).toEqual(["caller", "helper"]);
  });

  it("returns an empty list for an unknown symbol", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "doesNotExist", direction: "callers", depth: 2 });
    db.close();
    expect(result.matches).toEqual([]);
  });
});

describe("findRelatedSymbols - ambiguous names", () => {
  const TEST_AMBIGUOUS_DB = "/tmp/query-code-graph-ambiguous-test.sqlite";

  function seedAmbiguous(db: ReturnType<typeof openCodeIntelligenceDb>) {
    // Create two different "helper" functions in different files
    // File A: helper_a -> caller_a, File B: helper_b -> caller_b (separate graphs)
    const insertSymbol = db.prepare(
      "INSERT INTO symbols (id, name, kind, file, start_line, end_line, language) VALUES (?, ?, 'function', ?, ?, ?, 'go')",
    );
    // File A
    insertSymbol.run("s:helper_a", "helper", "a.go", 1, 5);
    insertSymbol.run("s:caller_a", "caller_a", "a.go", 10, 15);
    // File B
    insertSymbol.run("s:helper_b", "helper", "b.go", 1, 5);
    insertSymbol.run("s:caller_b", "caller_b", "b.go", 10, 15);

    const insertEdge = db.prepare("INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'calls')");
    insertEdge.run("s:caller_a", "s:helper_a");
    insertEdge.run("s:caller_b", "s:helper_b");
  }

  beforeEach(() => {
    const db = openCodeIntelligenceDb(TEST_AMBIGUOUS_DB);
    seedAmbiguous(db);
    db.close();
  });

  afterEach(() => {
    if (existsSync(TEST_AMBIGUOUS_DB)) unlinkSync(TEST_AMBIGUOUS_DB);
  });

  it("detects ambiguous symbol names without file parameter", () => {
    const db = openCodeIntelligenceDb(TEST_AMBIGUOUS_DB, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "helper", direction: "callers", depth: 2 });
    db.close();
    expect(result.matches).toEqual([]);
    expect(result.note).toContain("ambiguous");
    expect(result.ambiguousCandidates).toHaveLength(2);
    expect(result.ambiguousCandidates?.map((c) => c.file).sort()).toEqual(["a.go", "b.go"]);
  });

  it("disambiguates with file parameter", () => {
    const db = openCodeIntelligenceDb(TEST_AMBIGUOUS_DB, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "helper", direction: "callers", depth: 2, file: "a.go" });
    db.close();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].symbol).toBe("caller_a");
    expect(result.matches[0].file).toBe("a.go");
    expect(result.note).toBeUndefined();
  });

  it("can disambiguate to file b with file parameter", () => {
    const db = openCodeIntelligenceDb(TEST_AMBIGUOUS_DB, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "helper", direction: "callers", depth: 2, file: "b.go" });
    db.close();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].symbol).toBe("caller_b");
    expect(result.matches[0].file).toBe("b.go");
    expect(result.note).toBeUndefined();
  });
});

describe("findRelatedSymbols - same-file ambiguity (regression test)", () => {
  const TEST_SAME_FILE_DB = "/tmp/query-code-graph-same-file-test.sqlite";

  function seedSameFile(db: ReturnType<typeof openCodeIntelligenceDb>) {
    // Create two different "Close" methods in same file (like Close on Reader and Close on Writer in Go)
    // File A: Close1 -> caller1, Close2 -> caller2 (separate callers for each Close variant)
    const insertSymbol = db.prepare(
      "INSERT INTO symbols (id, name, kind, file, start_line, end_line, language) VALUES (?, ?, 'function', ?, ?, ?, 'go')",
    );
    // File A: Reader.Close at lines 10-15
    insertSymbol.run("s:close1", "Close", "io.go", 10, 15);
    insertSymbol.run("s:caller1", "readerUser", "io.go", 50, 55);
    // File A: Writer.Close at lines 20-25
    insertSymbol.run("s:close2", "Close", "io.go", 20, 25);
    insertSymbol.run("s:caller2", "writerUser", "io.go", 60, 65);

    const insertEdge = db.prepare("INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'calls')");
    insertEdge.run("s:caller1", "s:close1");
    insertEdge.run("s:caller2", "s:close2");
  }

  beforeEach(() => {
    const db = openCodeIntelligenceDb(TEST_SAME_FILE_DB);
    seedSameFile(db);
    db.close();
  });

  afterEach(() => {
    if (existsSync(TEST_SAME_FILE_DB)) unlinkSync(TEST_SAME_FILE_DB);
  });

  it("detects ambiguous symbol names even with file parameter when same file has duplicates", () => {
    const db = openCodeIntelligenceDb(TEST_SAME_FILE_DB, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "Close", direction: "callers", depth: 2, file: "io.go" });
    db.close();
    // Should not merge results, should report ambiguity with line numbers
    expect(result.matches).toEqual([]);
    expect(result.note).toContain("ambiguous");
    expect(result.note).toContain("line numbers");
    expect(result.ambiguousCandidates).toHaveLength(2);
    expect(result.ambiguousCandidates?.map((c) => c.startLine).sort()).toEqual([10, 20]);
  });

  it("still works correctly for different-file ambiguity when same-file test is present", () => {
    // Verify the earlier different-files test still works
    const db = openCodeIntelligenceDb(TEST_SAME_FILE_DB, { readonly: true });
    // Query for a symbol that doesn't have same-file dupes (readerUser only in io.go)
    const result = findRelatedSymbols(db, { symbolName: "readerUser", direction: "callees", depth: 1 });
    db.close();
    // Should work fine - no ambiguity
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].symbol).toBe("Close");
    expect(result.note).toBeUndefined();
  });
});
