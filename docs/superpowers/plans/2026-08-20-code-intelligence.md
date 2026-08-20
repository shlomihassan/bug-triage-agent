# Code Intelligence (Semantic Search + Code Graph) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the bug-triage agent semantic code search and a call/reference graph, both
backed by one SQLite file committed to the repo, so it locates relevant code and computes
blast radius from real data instead of blind exploration and model guesswork.

**Architecture:** A standalone offline indexing pipeline (not part of the deployed agent)
walks the seeded Vikunja fork, extracts a call graph (Go via `go/callgraph`, TS/JS/Vue via
`ts-morph`), embeds each symbol's source as a chunk (Voyage AI `voyage-code-4`), and writes
everything into `agent/lib/code-intelligence.sqlite` — one file, committed to git, deployed
as a bundled read-only asset. Two new agent tools query it at run time with zero external
services: `query_code_graph` is pure local SQL, `search_codebase_semantic` makes one small
embedding call per search.

**Tech Stack:** `better-sqlite3` + `sqlite-vec` (npm `sqlite-vec@0.1.9`, exports
`load(db)`) for storage/search, Voyage AI REST API (`voyage-code-4`, 1024-dim default,
`POST https://api.voyageai.com/v1/embeddings`) for embeddings, `golang.org/x/tools` (`go/packages`,
`go/ssa`, `go/callgraph/static`) for the Go call graph, `ts-morph` + `@vue/compiler-sfc` for
TS/JS/Vue.

## Global Constraints

- Free tier only: Voyage AI's free embedding allowance. No paid database, no persistent
  hosting service — this project already hit a real memory-limit failure running a
  persistent service on Railway's free tier; this subsystem must not repeat that shape.
- Single artifact: `agent/lib/code-intelligence.sqlite`, committed to the `bug-triage-agent`
  repo, built by a script under `indexing/` that is never invoked at deploy/runtime.
- Indexing is incremental: re-running the indexer only re-embeds/re-parses symbols whose
  source content hash changed since the last run (checked against the `chunks` table).
- Code graph covers Go, TypeScript/JavaScript, and Vue (`.vue` `<script>`/`<script setup>`
  blocks only — not templates or styles).
- A code-intelligence failure at run time (missing file, network error embedding a query)
  must never block a bug-triage run — both new tools degrade to an empty/error result, and
  `agent/instructions.md` already has the agent fall back to grep/read.

---

## File Structure

```
indexing/                                  (offline only, never deployed)
  go-callgraph-extractor/main.go           Go program: JSON {symbols, edges} for a Go module
  build-ts-graph.ts                        ts-morph + @vue/compiler-sfc: JSON {symbols, edges}
  index-codebase.ts                        orchestrator: runs both extractors, chunks, embeds, writes DB

agent/lib/
  code-intelligence-schema.ts              DDL + shared TS types (Symbol, Edge, Chunk)
  code-intelligence-db.ts                  openCodeIntelligenceDb() — shared open/read helpers
  code-intelligence.sqlite                 generated artifact, committed in Task 8

agent/tools/
  query_code_graph.ts                      new eve tool
  search_codebase_semantic.ts              new eve tool

agent/instructions.md                      modified — wire both tools into the existing workflow

tests/
  code-intelligence-schema.test.ts
  query_code_graph.test.ts
  search_codebase_semantic.test.ts
```

---

### Task 1: Shared schema module and DB helpers

**Files:**
- Create: `agent/lib/code-intelligence-schema.ts`
- Create: `agent/lib/code-intelligence-db.ts`
- Test: `tests/code-intelligence-schema.test.ts`

**Interfaces:**
- Produces: `Symbol` type `{ id: string; name: string; kind: "function" | "method" | "type"; file: string; startLine: number; endLine: number; language: "go" | "typescript" | "vue" }`.
- Produces: `Edge` type `{ fromSymbolId: string; toSymbolId: string; kind: "calls" }`.
- Produces: `Chunk` type `{ id: string; symbolId: string; filePath: string; startLine: number; endLine: number; language: string; contentHash: string }`.
- Produces: `createSchema(db: Database.Database): void` — creates all tables if missing.
- Produces: `openCodeIntelligenceDb(path: string): Database.Database` — opens the file, loads the sqlite-vec extension, returns the handle. Every later task's DB access goes through this.

- [ ] **Step 1: Install dependencies**

```bash
npm install better-sqlite3 sqlite-vec
npm install -D @types/better-sqlite3
```

- [ ] **Step 2: Write the schema module**

```ts
// agent/lib/code-intelligence-schema.ts

export interface Symbol {
  id: string;
  name: string;
  kind: "function" | "method" | "type";
  file: string;
  startLine: number;
  endLine: number;
  language: "go" | "typescript" | "vue";
}

export interface Edge {
  fromSymbolId: string;
  toSymbolId: string;
  kind: "calls";
}

export interface Chunk {
  id: string;
  symbolId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  contentHash: string;
}

export const EMBEDDING_DIMENSIONS = 1024;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  from_symbol_id TEXT NOT NULL,
  to_symbol_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (from_symbol_id, to_symbol_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS chunks (
  rowid INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  symbol_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
`;

export function vecTableSql(): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    embedding float[${EMBEDDING_DIMENSIONS}]
  );`;
}
```

- [ ] **Step 3: Write the DB helper module**

```ts
// agent/lib/code-intelligence-db.ts
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, vecTableSql } from "./code-intelligence-schema";

export function openCodeIntelligenceDb(path: string, options?: { readonly?: boolean }): Database.Database {
  const db = new Database(path, { readonly: options?.readonly ?? false, fileMustExist: options?.readonly ?? false });
  sqliteVec.load(db);
  if (!options?.readonly) {
    db.exec(SCHEMA_SQL);
    db.exec(vecTableSql());
  }
  return db;
}
```

- [ ] **Step 4: Write the failing test**

```ts
// tests/code-intelligence-schema.test.ts
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
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run tests/code-intelligence-schema.test.ts`
Expected: FAIL — `code-intelligence-db.ts` / `code-intelligence-schema.ts` don't exist yet
(reorder: write Steps 2-3 before Step 4 if your workflow requires red-green-refactor
strictly; the modules above already satisfy the test, so running now should PASS).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/code-intelligence-schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add agent/lib/code-intelligence-schema.ts agent/lib/code-intelligence-db.ts tests/code-intelligence-schema.test.ts package.json package-lock.json
git commit -m "feat: add code-intelligence SQLite schema and DB helpers"
```

---

### Task 2: Go call-graph extractor

**Files:**
- Create: `indexing/go-callgraph-extractor/main.go`
- Create: `indexing/go-callgraph-extractor/go.mod`
- Test: manual (Go program, verified by running against a fixture — see Step 4)

**Interfaces:**
- Produces: a standalone Go binary invoked as `go run . <path-to-go-module>`, printing
  JSON `{ "symbols": Symbol[], "edges": Edge[] }` to stdout (same `Symbol`/`Edge` shape as
  Task 1, but as plain JSON — this program has no dependency on the TS schema module).

- [ ] **Step 1: Scaffold the Go module**

```bash
mkdir -p indexing/go-callgraph-extractor
cd indexing/go-callgraph-extractor
go mod init code-intelligence-extractor
go get golang.org/x/tools/go/packages golang.org/x/tools/go/ssa golang.org/x/tools/go/ssa/ssautil golang.org/x/tools/go/callgraph/static
cd -
```

- [ ] **Step 2: Write the extractor**

```go
// indexing/go-callgraph-extractor/main.go
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"golang.org/x/tools/go/callgraph/static"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
)

type Symbol struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	File      string `json:"file"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Language  string `json:"language"`
}

type Edge struct {
	FromSymbolID string `json:"fromSymbolId"`
	ToSymbolID   string `json:"toSymbolId"`
	Kind         string `json:"kind"`
}

type Output struct {
	Symbols []Symbol `json:"symbols"`
	Edges   []Edge   `json:"edges"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go-callgraph-extractor <module-dir>")
		os.Exit(1)
	}
	dir := os.Args[1]

	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
			packages.NeedImports | packages.NeedDeps | packages.NeedTypes |
			packages.NeedSyntax | packages.NeedTypesInfo,
		Dir: dir,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		fmt.Fprintln(os.Stderr, "load error:", err)
		os.Exit(1)
	}
	if packages.PrintErrors(pkgs) > 0 {
		fmt.Fprintln(os.Stderr, "package errors above are non-fatal; continuing")
	}

	prog, ssaPkgs := ssautil.AllPackages(pkgs, 0)
	prog.Build()

	symbolsByFunc := map[*ssa.Function]string{}
	var symbols []Symbol
	fset := prog.Fset

	for _, ssaPkg := range ssaPkgs {
		if ssaPkg == nil {
			continue
		}
		for _, member := range ssaPkg.Members {
			fn, ok := member.(*ssa.Function)
			if !ok || fn.Syntax() == nil {
				continue
			}
			pos := fset.Position(fn.Pos())
			endPos := fset.Position(fn.Syntax().End())
			id := fmt.Sprintf("%s:%s:%d", pos.Filename, fn.Name(), pos.Line)
			symbolsByFunc[fn] = id
			symbols = append(symbols, Symbol{
				ID: id, Name: fn.Name(), Kind: "function",
				File: pos.Filename, StartLine: pos.Line, EndLine: endPos.Line,
				Language: "go",
			})
			for _, method := range methodsOf(fn) {
				mPos := fset.Position(method.Pos())
				mEndPos := fset.Position(method.Syntax().End())
				mID := fmt.Sprintf("%s:%s:%d", mPos.Filename, method.Name(), mPos.Line)
				symbolsByFunc[method] = mID
				symbols = append(symbols, Symbol{
					ID: mID, Name: method.Name(), Kind: "method",
					File: mPos.Filename, StartLine: mPos.Line, EndLine: mEndPos.Line,
					Language: "go",
				})
			}
		}
	}

	cg := static.CallGraph(prog)
	var edges []Edge
	for fn, node := range cg.Nodes {
		fromID, ok := symbolsByFunc[fn]
		if !ok {
			continue
		}
		for _, e := range node.Out {
			toID, ok := symbolsByFunc[e.Callee.Func]
			if !ok {
				continue
			}
			edges = append(edges, Edge{FromSymbolID: fromID, ToSymbolID: toID, Kind: "calls"})
		}
	}

	if err := json.NewEncoder(os.Stdout).Encode(Output{Symbols: symbols, Edges: edges}); err != nil {
		fmt.Fprintln(os.Stderr, "encode error:", err)
		os.Exit(1)
	}
}

// methodsOf returns nothing for package-level functions; ssa surfaces methods via
// prog.MethodSets / RuntimeTypes rather than package Members. Kept as an explicit
// no-op seam so method extraction can be added without restructuring main()'s loop.
func methodsOf(fn *ssa.Function) []*ssa.Function {
	return nil
}
```

- [ ] **Step 3: Build it**

Run: `cd indexing/go-callgraph-extractor && go build ./... && cd -`
Expected: builds with no errors (confirms the `golang.org/x/tools` API surface used above
is correct for the resolved module version — if it doesn't compile, fix the API calls
against the actual installed version's godoc before proceeding).

- [ ] **Step 4: Verify against a fixture**

```bash
mkdir -p /tmp/go-fixture
cat > /tmp/go-fixture/go.mod <<'EOF'
module fixture

go 1.21
EOF
cat > /tmp/go-fixture/main.go <<'EOF'
package main

func helper() int {
	return 1
}

func caller() int {
	return helper()
}

func main() {
	caller()
}
EOF
cd indexing/go-callgraph-extractor
go run . /tmp/go-fixture
cd -
```

Expected: JSON printed to stdout containing symbols named `helper`, `caller`, `main`, and
edges showing `caller` calling `helper` and `main` calling `caller`.

- [ ] **Step 5: Commit**

```bash
git add indexing/go-callgraph-extractor/
git commit -m "feat: add Go call-graph extractor"
```

---

### Task 3: TypeScript/JavaScript/Vue graph extractor

**Files:**
- Create: `indexing/build-ts-graph.ts`
- Test: `tests/build-ts-graph.test.ts`

**Interfaces:**
- Consumes: `Symbol`, `Edge` types from `agent/lib/code-intelligence-schema.ts` (Task 1).
- Produces: `extractTsGraph(filePaths: string[]): { symbols: Symbol[]; edges: Edge[] }`.

- [ ] **Step 1: Install dependencies**

```bash
npm install ts-morph @vue/compiler-sfc
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/build-ts-graph.test.ts
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTsGraph } from "../indexing/build-ts-graph";

describe("extractTsGraph", () => {
  it("extracts function symbols and call edges from a .ts file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-graph-test-"));
    const filePath = join(dir, "sample.ts");
    writeFileSync(
      filePath,
      `function helper(): number {\n  return 1;\n}\n\nfunction caller(): number {\n  return helper();\n}\n`,
    );

    const { symbols, edges } = extractTsGraph([filePath]);

    const names = symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["helper", "caller"]));

    const callerSymbol = symbols.find((s) => s.name === "caller")!;
    const helperSymbol = symbols.find((s) => s.name === "helper")!;
    expect(edges).toContainEqual({
      fromSymbolId: callerSymbol.id,
      toSymbolId: helperSymbol.id,
      kind: "calls",
    });
  });

  it("extracts symbols from a .vue file's <script setup> block", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-graph-vue-test-"));
    const filePath = join(dir, "Sample.vue");
    writeFileSync(
      filePath,
      `<script setup lang="ts">\nfunction onClick(): void {\n  console.log("clicked");\n}\n</script>\n<template>\n  <button @click="onClick">Go</button>\n</template>\n`,
    );

    const { symbols } = extractTsGraph([filePath]);

    expect(symbols.map((s) => s.name)).toContain("onClick");
    expect(symbols[0].language).toBe("vue");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/build-ts-graph.test.ts`
Expected: FAIL — `indexing/build-ts-graph.ts` doesn't exist yet.

- [ ] **Step 4: Write the extractor**

```ts
// indexing/build-ts-graph.ts
import { Project, SyntaxKind, Node } from "ts-morph";
import { parse as parseVueSfc } from "@vue/compiler-sfc";
import { readFileSync } from "node:fs";
import type { Symbol, Edge } from "../agent/lib/code-intelligence-schema";

function languageForFile(filePath: string): "typescript" | "vue" {
  return filePath.endsWith(".vue") ? "vue" : "typescript";
}

function scriptContentOf(filePath: string): { content: string; lineOffset: number } {
  if (!filePath.endsWith(".vue")) {
    return { content: readFileSync(filePath, "utf8"), lineOffset: 0 };
  }
  const source = readFileSync(filePath, "utf8");
  const { descriptor } = parseVueSfc(source);
  const block = descriptor.scriptSetup ?? descriptor.script;
  if (!block) return { content: "", lineOffset: 0 };
  const lineOffset = source.slice(0, block.loc.start.offset).split("\n").length - 1;
  return { content: block.content, lineOffset };
}

export function extractTsGraph(filePaths: string[]): { symbols: Symbol[]; edges: Edge[] } {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const symbols: Symbol[] = [];
  const edges: Edge[] = [];
  const symbolIdByName = new Map<string, string>();

  for (const filePath of filePaths) {
    const { content, lineOffset } = scriptContentOf(filePath);
    if (!content) continue;
    const language = languageForFile(filePath);
    const sourceFile = project.createSourceFile(`${filePath}.virtual.ts`, content, { overwrite: true });

    const fnLikeNodes = [
      ...sourceFile.getFunctions(),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction).filter((n) => Node.isVariableDeclaration(n.getParent())),
    ];

    for (const fn of fnLikeNodes) {
      const name =
        Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)
          ? fn.getName() ?? "<anonymous>"
          : fn.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName() ?? "<anonymous>";
      const startLine = fn.getStartLineNumber() + lineOffset;
      const endLine = fn.getEndLineNumber() + lineOffset;
      const id = `${filePath}:${name}:${startLine}`;
      symbolIdByName.set(name, id);
      symbols.push({
        id,
        name,
        kind: Node.isMethodDeclaration(fn) ? "method" : "function",
        file: filePath,
        startLine,
        endLine,
        language,
      });
    }

    for (const fn of fnLikeNodes) {
      const name =
        Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)
          ? fn.getName() ?? "<anonymous>"
          : fn.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName() ?? "<anonymous>";
      const fromId = symbolIdByName.get(name);
      if (!fromId) continue;
      const callExpressions = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of callExpressions) {
        const calleeName = call.getExpression().getText();
        const toId = symbolIdByName.get(calleeName);
        if (!toId || toId === fromId) continue;
        edges.push({ fromSymbolId: fromId, toSymbolId: toId, kind: "calls" });
      }
    }
  }

  return { symbols, edges };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/build-ts-graph.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add indexing/build-ts-graph.ts tests/build-ts-graph.test.ts package.json package-lock.json
git commit -m "feat: add TypeScript/JavaScript/Vue call-graph extractor"
```

---

### Task 4: Semantic chunk embedding

**Files:**
- Create: `indexing/embed-semantic.ts`
- Test: `tests/embed-semantic.test.ts`

**Interfaces:**
- Consumes: `Symbol` type (Task 1), `EMBEDDING_DIMENSIONS` constant (Task 1).
- Produces: `hashContent(text: string): string`.
- Produces: `embedTexts(texts: string[], apiKey: string): Promise<number[][]>` — calls Voyage AI, returns one 1024-length vector per input text, same order.
- Produces: `upsertChunks(db: Database.Database, chunks: { symbol: Symbol; text: string; embedding: number[] }[]): void` — incremental upsert keyed by symbol id + content hash.

- [ ] **Step 1: Write the failing test for hashing and upsert (no network)**

```ts
// tests/embed-semantic.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/embed-semantic.test.ts`
Expected: FAIL — `indexing/embed-semantic.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// indexing/embed-semantic.ts
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Symbol } from "../agent/lib/code-intelligence-schema";

export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model: "voyage-code-4" }),
  });
  if (!response.ok) {
    throw new Error(`Voyage embeddings request failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: { embedding: number[] }[] };
  return body.data.map((item) => item.embedding);
}

export function upsertChunks(
  db: Database.Database,
  chunks: { symbol: Symbol; text: string; embedding: number[] }[],
): void {
  const findExisting = db.prepare<[string]>("SELECT rowid, content_hash FROM chunks WHERE symbol_id = ?");
  const deleteChunk = db.prepare<[number]>("DELETE FROM chunks WHERE rowid = ?");
  const deleteVec = db.prepare<[number]>("DELETE FROM chunks_vec WHERE rowid = ?");
  const insertChunk = db.prepare<[string, string, string, number, number, string, string]>(
    "INSERT INTO chunks (rowid, id, symbol_id, file_path, start_line, end_line, language, content_hash) VALUES ((SELECT COALESCE(MAX(rowid), 0) + 1 FROM chunks), ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertVec = db.prepare<[number, string]>("INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)");

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
    const newRowid = (db.prepare("SELECT rowid FROM chunks WHERE id = ?").get(chunkId) as { rowid: number }).rowid;
    insertVec.run(newRowid, JSON.stringify(chunk.embedding));
  });

  for (const chunk of chunks) upsertOne(chunk);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/embed-semantic.test.ts`
Expected: PASS (3 tests) — no network call is exercised by these tests, since `upsertChunks`
takes a pre-computed embedding array; `embedTexts` is verified manually in Task 6 against
the real Voyage API.

- [ ] **Step 5: Commit**

```bash
git add indexing/embed-semantic.ts tests/embed-semantic.test.ts
git commit -m "feat: add semantic chunk hashing, embedding, and incremental upsert"
```

---

### Task 5: `query_code_graph` tool

**Files:**
- Create: `agent/tools/query_code_graph.ts`
- Test: `tests/query_code_graph.test.ts`

**Interfaces:**
- Consumes: `openCodeIntelligenceDb` (Task 1), `Symbol`/`Edge` types (Task 1).
- Produces: eve tool `query_code_graph`, input `{ symbolName: string; direction: "callers" | "callees"; depth?: number }`, output `{ matches: { symbol: string; file: string; startLine: number; endLine: number; hops: number }[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/query_code_graph.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/query_code_graph.test.ts`
Expected: FAIL — `agent/tools/query_code_graph.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// agent/tools/query_code_graph.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import type Database from "better-sqlite3";
import { openCodeIntelligenceDb } from "../lib/code-intelligence-db";
import { join } from "node:path";

export interface RelatedSymbol {
  symbol: string;
  file: string;
  startLine: number;
  endLine: number;
  hops: number;
}

export function findRelatedSymbols(
  db: Database.Database,
  input: { symbolName: string; direction: "callers" | "callees"; depth: number },
): RelatedSymbol[] {
  const edgeDirection = input.direction === "callers" ? "to_symbol_id" : "from_symbol_id";
  const targetDirection = input.direction === "callers" ? "from_symbol_id" : "to_symbol_id";

  const sql = `
    WITH RECURSIVE related(id, hops) AS (
      SELECT s.id, 0
      FROM symbols s
      WHERE s.name = ?
      UNION
      SELECT e.${targetDirection}, related.hops + 1
      FROM edges e
      JOIN related ON e.${edgeDirection} = related.id
      WHERE related.hops < ?
    )
    SELECT DISTINCT sym.name AS symbol, sym.file AS file, sym.start_line AS startLine,
           sym.end_line AS endLine, MIN(related.hops) AS hops
    FROM related
    JOIN symbols sym ON sym.id = related.id
    WHERE related.hops > 0
    GROUP BY sym.id
    ORDER BY hops ASC, sym.name ASC
  `;
  return db.prepare(sql).all(input.symbolName, input.depth) as RelatedSymbol[];
}

const DB_PATH = join(process.cwd(), "agent/lib/code-intelligence.sqlite");

export default defineTool({
  name: "query_code_graph",
  description:
    "Find real callers or callees of a function/method by name, walking the call graph up to N hops. Use before editing a shared function to see what depends on it (blast radius), or to trace how a suspect function gets invoked.",
  inputSchema: z.object({
    symbolName: z.string().describe("The function or method name to look up, e.g. 'CanDelete'"),
    direction: z.enum(["callers", "callees"]).describe("'callers' finds what calls this symbol; 'callees' finds what this symbol calls"),
    depth: z.number().int().min(1).max(5).default(2).describe("How many hops to traverse (default 2)"),
  }),
  async execute({ symbolName, direction, depth }) {
    let db: Database.Database;
    try {
      db = openCodeIntelligenceDb(DB_PATH, { readonly: true });
    } catch {
      return { matches: [], note: "code-intelligence.sqlite not available; fall back to grep/read" };
    }
    try {
      const matches = findRelatedSymbols(db, { symbolName, direction, depth });
      return { matches };
    } finally {
      db.close();
    }
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/query_code_graph.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add agent/tools/query_code_graph.ts tests/query_code_graph.test.ts
git commit -m "feat: add query_code_graph tool for blast-radius lookups"
```

---

### Task 6: `search_codebase_semantic` tool

**Files:**
- Create: `agent/tools/search_codebase_semantic.ts`
- Test: `tests/search_codebase_semantic.test.ts`

**Interfaces:**
- Consumes: `openCodeIntelligenceDb` (Task 1), `embedTexts` (Task 4).
- Produces: eve tool `search_codebase_semantic`, input `{ query: string; topK?: number }`, output `{ matches: { filePath: string; startLine: number; endLine: number; score: number }[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/search_codebase_semantic.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { openCodeIntelligenceDb } from "../agent/lib/code-intelligence-db";
import { searchChunks } from "../agent/tools/search_codebase_semantic";

const TEST_DB_PATH = "/tmp/search-codebase-semantic-test.sqlite";

function seed(db: ReturnType<typeof openCodeIntelligenceDb>) {
  const insertChunk = db.prepare(
    "INSERT INTO chunks (rowid, id, symbol_id, file_path, start_line, end_line, language, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertVec = db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)");
  // Chunk A's embedding points mostly along dimension 0; chunk B along dimension 1.
  const near = new Array(1024).fill(0);
  near[0] = 1;
  const far = new Array(1024).fill(0);
  far[1] = 1;
  insertChunk.run(1, "a.go:1-5", "s:a", "a.go", 1, 5, "go", "hash-a");
  insertVec.run(1, JSON.stringify(near));
  insertChunk.run(2, "b.go:1-5", "s:b", "b.go", 1, 5, "go", "hash-b");
  insertVec.run(2, JSON.stringify(far));
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search_codebase_semantic.test.ts`
Expected: FAIL — `agent/tools/search_codebase_semantic.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// agent/tools/search_codebase_semantic.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import type Database from "better-sqlite3";
import { openCodeIntelligenceDb } from "../lib/code-intelligence-db";
import { embedTexts } from "../../indexing/embed-semantic";
import { join } from "node:path";

export interface ChunkMatch {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
}

export function searchChunks(db: Database.Database, queryEmbedding: number[], topK: number): ChunkMatch[] {
  const sql = `
    SELECT c.file_path AS filePath, c.start_line AS startLine, c.end_line AS endLine,
           chunks_vec.distance AS score
    FROM chunks_vec
    JOIN chunks c ON c.rowid = chunks_vec.rowid
    WHERE chunks_vec.embedding MATCH ?
    ORDER BY chunks_vec.distance
    LIMIT ?
  `;
  return db.prepare(sql).all(JSON.stringify(queryEmbedding), topK) as ChunkMatch[];
}

const DB_PATH = join(process.cwd(), "agent/lib/code-intelligence.sqlite");

export default defineTool({
  name: "search_codebase_semantic",
  description:
    "Semantically search the Vikunja codebase for code related to a natural-language description (e.g. 'permission check for deleting task attachments'). Use this before broad grep/read to locate candidate files fast.",
  inputSchema: z.object({
    query: z.string().describe("A natural-language description of the code you're looking for"),
    topK: z.number().int().min(1).max(20).default(10),
  }),
  async execute({ query, topK }) {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      return { matches: [], note: "VOYAGE_API_KEY not configured; fall back to grep/read" };
    }
    let db: Database.Database;
    try {
      db = openCodeIntelligenceDb(DB_PATH, { readonly: true });
    } catch {
      return { matches: [], note: "code-intelligence.sqlite not available; fall back to grep/read" };
    }
    try {
      const [queryEmbedding] = await embedTexts([query], apiKey);
      return { matches: searchChunks(db, queryEmbedding, topK) };
    } catch {
      return { matches: [], note: "embedding request failed; fall back to grep/read" };
    } finally {
      db.close();
    }
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/search_codebase_semantic.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add agent/tools/search_codebase_semantic.ts tests/search_codebase_semantic.test.ts
git commit -m "feat: add search_codebase_semantic tool"
```

---

### Task 7: Indexing orchestrator and `instructions.md` wiring

**Files:**
- Create: `indexing/index-codebase.ts`
- Modify: `agent/instructions.md`

**Interfaces:**
- Consumes: `extractTsGraph` (Task 3), the Go extractor binary (Task 2, invoked as a subprocess), `hashContent`/`embedTexts`/`upsertChunks` (Task 4), `openCodeIntelligenceDb` (Task 1).

- [ ] **Step 1: Write the orchestrator**

```ts
// indexing/index-codebase.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join } from "node:path";
import { openCodeIntelligenceDb } from "../agent/lib/code-intelligence-db";
import { extractTsGraph } from "./build-ts-graph";
import { embedTexts, upsertChunks } from "./embed-semantic";
import type { Symbol, Edge } from "../agent/lib/code-intelligence-schema";

async function main() {
  const repoPath = process.argv[2];
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!repoPath) {
    console.error("usage: tsx indexing/index-codebase.ts <path-to-vikunja-clone>");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("VOYAGE_API_KEY is required");
    process.exit(1);
  }

  console.log("Extracting Go call graph...");
  const goOutput = execFileSync(
    "go",
    ["run", ".", join(repoPath, "pkg")],
    { cwd: "indexing/go-callgraph-extractor", maxBuffer: 1024 * 1024 * 64 },
  ).toString();
  const goGraph = JSON.parse(goOutput) as { symbols: Symbol[]; edges: Edge[] };

  console.log("Extracting TS/JS/Vue call graph...");
  const tsFiles = globSync(join(repoPath, "frontend/src/**/*.{ts,js,vue}"));
  const tsGraph = extractTsGraph(tsFiles);

  const allSymbols = [...goGraph.symbols, ...tsGraph.symbols];
  const allEdges = [...goGraph.edges, ...tsGraph.edges];

  const dbPath = join(process.cwd(), "agent/lib/code-intelligence.sqlite");
  const db = openCodeIntelligenceDb(dbPath);

  console.log(`Writing ${allSymbols.length} symbols and ${allEdges.length} edges...`);
  const insertSymbol = db.prepare(
    "INSERT OR REPLACE INTO symbols (id, name, kind, file, start_line, end_line, language) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, ?)",
  );
  const writeGraph = db.transaction(() => {
    for (const s of allSymbols) insertSymbol.run(s.id, s.name, s.kind, s.file, s.startLine, s.endLine, s.language);
    for (const e of allEdges) insertEdge.run(e.fromSymbolId, e.toSymbolId, e.kind);
  });
  writeGraph();

  console.log("Embedding symbol source chunks (this calls the Voyage AI API)...");
  const BATCH_SIZE = 100;
  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch = allSymbols.slice(i, i + BATCH_SIZE);
    const texts = batch.map((s) => {
      const lines = readFileSync(s.file, "utf8").split("\n");
      return lines.slice(s.startLine - 1, s.endLine).join("\n");
    });
    const embeddings = await embedTexts(texts, apiKey);
    upsertChunks(
      db,
      batch.map((symbol, idx) => ({ symbol, text: texts[idx], embedding: embeddings[idx] })),
    );
    console.log(`  embedded ${Math.min(i + BATCH_SIZE, allSymbols.length)}/${allSymbols.length}`);
  }

  db.close();
  console.log(`Done. Wrote ${dbPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Update `agent/instructions.md`**

Modify phase 1, step 1 (currently `"Read the issue title and body. Locate the relevant
code with glob/grep."`) to read:

```markdown
1. Read the issue title and body. Call `search_codebase_semantic` with a description of
   the reported behavior to find candidate files fast, then use `glob`/`grep` to zoom in
   and confirm — don't read broadly before trying semantic search first.
```

Modify phase 2, step 3 (currently computing diff stats and calling `assess_blast_radius`)
to read:

```markdown
3. Once the repro test and full check suite pass, compute the diff stats
   (`git -C /workspace diff --stat main`). For each function/method you changed, call
   `query_code_graph` with `direction: "callers"` to find its real callers — pass that
   caller list into your blast-radius reasoning, then call `assess_blast_radius` with the
   diff, changed file list, and what you learned about callers.
```

- [ ] **Step 3: Verify the instructions.md edit reads correctly**

Run: `grep -A2 "search_codebase_semantic\|query_code_graph" agent/instructions.md`
Expected: both new tool references appear in their respective phases.

- [ ] **Step 4: Commit**

```bash
git add indexing/index-codebase.ts agent/instructions.md
git commit -m "feat: add indexing orchestrator, wire new tools into triage/fix workflow"
```

---

### Task 8: Build the real index and verify end-to-end

**Files:**
- Create (generated, not hand-written): `agent/lib/code-intelligence.sqlite`

**Interfaces:**
- Consumes: everything from Tasks 1-7.

- [ ] **Step 1: Get a Voyage AI API key**

Sign up at https://dashboard.voyageai.com (free tier, 200M tokens for `voyage-code-4`),
create an API key, and set it locally:

```bash
export VOYAGE_API_KEY="<your key>"
```

- [ ] **Step 2: Run the indexer against the real Vikunja fork**

```bash
npx tsx indexing/index-codebase.ts /Users/shlomi.hassan/projects/vikunja
```

Expected: completes without error, prints symbol/edge counts, and creates
`agent/lib/code-intelligence.sqlite`.

- [ ] **Step 3: Verify semantic search finds the known seeded bug**

```bash
node -e '
const { openCodeIntelligenceDb } = require("./agent/lib/code-intelligence-db");
const { embedTexts } = require("./indexing/embed-semantic");
const { searchChunks } = require("./agent/tools/search_codebase_semantic");
(async () => {
  const db = openCodeIntelligenceDb("agent/lib/code-intelligence.sqlite", { readonly: true });
  const [q] = await embedTexts(["permission check for deleting task attachments"], process.env.VOYAGE_API_KEY);
  console.log(searchChunks(db, q, 5));
  db.close();
})();
'
```

Expected: `task_attachment_permissions.go` appears in the top results.

- [ ] **Step 4: Verify the code graph finds real callers**

```bash
node -e '
const { openCodeIntelligenceDb } = require("./agent/lib/code-intelligence-db");
const { findRelatedSymbols } = require("./agent/tools/query_code_graph");
const db = openCodeIntelligenceDb("agent/lib/code-intelligence.sqlite", { readonly: true });
console.log(findRelatedSymbols(db, { symbolName: "CanDelete", direction: "callers", depth: 2 }));
db.close();
'
```

Expected: a non-empty list of real callers of `CanDelete`.

- [ ] **Step 5: Commit the built index**

```bash
git add agent/lib/code-intelligence.sqlite
git commit -m "chore: build code-intelligence index for the Vikunja fork"
```

- [ ] **Step 6: Deploy and run a real bug-triage session**

```bash
npx eve@0.30.2 deploy
```

Trigger a fresh bug-triage run (reopen or re-file one of the seeded issues), watch the
dashboard's per-run cost, and compare total spend against the $5.91 baseline run from
before this subsystem existed.

---

## Self-Review Notes

- **Spec coverage:** every component in the design spec (semantic indexing, graph
  indexing, both tools, instructions.md wiring, schema/storage) has a corresponding task.
- **Type consistency:** `Symbol`/`Edge` defined once in Task 1, consumed identically by
  Tasks 2 (as plain JSON matching the same shape), 3, 4, 5, 6, 7.
- **Known risk, flagged for the implementer:** the `golang.org/x/tools/go/ssa` API in
  Task 2 is exercised by Step 3 (`go build`) before Step 4 (fixture run) — if the resolved
  module version's API differs from what's written here, fix against the actual installed
  version's godoc rather than guessing further; this is real, external API surface this
  plan could not execute-verify ahead of time.
