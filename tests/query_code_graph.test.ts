import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { openCodeIntelligenceDb } from "../agent/lib/code-intelligence-db";
import { findRelatedSymbols } from "../agent/tools/query_code_graph";

const TEST_DB_PATH = "/tmp/query-code-graph-test.sqlite";

// Graph: main -> caller -> helper
function seed(db: ReturnType<typeof openCodeIntelligenceDb>) {
  const insertSymbol = db.prepare(
    "INSERT INTO symbols (id, name, kind, file, start_line, end_line, language) VALUES (?, ?, 'function', 'x.go', 1, 5, 'go')",
  );
  insertSymbol.run("s:helper", "helper");
  insertSymbol.run("s:caller", "caller");
  insertSymbol.run("s:main", "main");
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
    const names = result.map((r) => r.symbol).sort();
    expect(names).toEqual(["caller", "main"]);
  });

  it("limits by depth", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "helper", direction: "callers", depth: 1 });
    db.close();
    expect(result.map((r) => r.symbol)).toEqual(["caller"]);
  });

  it("finds callees", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "main", direction: "callees", depth: 2 });
    db.close();
    expect(result.map((r) => r.symbol).sort()).toEqual(["caller", "helper"]);
  });

  it("returns an empty list for an unknown symbol", () => {
    const db = openCodeIntelligenceDb(TEST_DB_PATH, { readonly: true });
    const result = findRelatedSymbols(db, { symbolName: "doesNotExist", direction: "callers", depth: 2 });
    db.close();
    expect(result).toEqual([]);
  });
});
