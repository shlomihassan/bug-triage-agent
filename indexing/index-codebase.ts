// indexing/index-codebase.ts
//
// Orchestrator: builds the Go call graph, the TS/JS/Vue call graph, and the semantic
// embedding index for a Vikunja clone, and writes them all into the shared
// code-intelligence SQLite DB that query_code_graph and search_codebase_semantic read
// from at runtime.
//
// Usage: VOYAGE_API_KEY=... npx tsx indexing/index-codebase.ts <path-to-vikunja-clone>
// Must be run from the repo root (it resolves the Go extractor and the output DB path
// relative to process.cwd(), matching the convention already used by
// agent/tools/query_code_graph.ts and agent/tools/search_codebase_semantic.ts).
import { execFileSync } from "node:child_process";
import { readFileSync, globSync } from "node:fs";
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
