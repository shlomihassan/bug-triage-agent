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
import { join, relative, resolve } from "node:path";
import { openCodeIntelligenceDb } from "../agent/lib/code-intelligence-db";
import { extractTsGraph } from "./build-ts-graph";
import { embedTextsWithUsage, hashContent, truncateForEmbedding, upsertChunks } from "./embed-semantic";
import type { Symbol, Edge } from "../agent/lib/code-intelligence-schema";

/**
 * Both extractors emit absolute paths from the machine that ran the index. The agent, at
 * runtime, works inside a sandbox where the same repo is checked out at `/workspace`, so
 * an index full of `/Users/<someone>/projects/vikunja/...` paths hands the model file
 * locations that do not exist there — every grep/read follow-up on a search hit would
 * fail. Store repo-relative paths (`pkg/models/...`, `frontend/src/...`) instead, which
 * are valid against any checkout, and rebuild the symbol ids to match so ids stay stable
 * across machines.
 */
function toRepoRelative(symbols: Symbol[], repoRoot: string): { symbols: Symbol[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const rewritten = symbols.map((s) => {
    const file = relative(repoRoot, s.file);
    const id = `${file}:${s.name}:${s.startLine}`;
    idMap.set(s.id, id);
    return { ...s, id, file };
  });
  return { symbols: rewritten, idMap };
}

async function main() {
  const repoPath = process.argv[2] && resolve(process.argv[2]);
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
  const frontendSrc = join(repoPath, "frontend/src");
  const tsFiles = globSync(join(frontendSrc, "**/*.{ts,js,vue}"));
  // Vikunja's Vite config aliases `@` to `frontend/src` (frontend/vite.config.ts), and
  // essentially every cross-file import in the frontend uses it, so without this mapping
  // the TS/Vue call graph collapses to intra-file edges only.
  const tsGraph = extractTsGraph(tsFiles, { aliases: { "@/": `${frontendSrc}/` } });

  const { symbols: allSymbols, idMap } = toRepoRelative(
    [...goGraph.symbols, ...tsGraph.symbols],
    repoPath,
  );
  const rawEdges = [...goGraph.edges, ...tsGraph.edges];
  // Drop edges whose endpoints were never emitted as symbols (e.g. a callee outside the
  // indexed tree) rather than writing dangling ids the graph query can never resolve.
  const allEdges: Edge[] = [];
  let droppedEdges = 0;
  for (const e of rawEdges) {
    const from = idMap.get(e.fromSymbolId);
    const to = idMap.get(e.toSymbolId);
    if (!from || !to) {
      droppedEdges++;
      continue;
    }
    allEdges.push({ fromSymbolId: from, toSymbolId: to, kind: e.kind });
  }
  if (droppedEdges > 0) console.log(`  (dropped ${droppedEdges} edges with unresolvable endpoints)`);

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
    // Edges are fully re-derived on every run, so clear them first — INSERT OR IGNORE
    // alone would leave behind edges for calls that have since been deleted from the
    // codebase, silently inflating every later blast-radius answer. (Symbols are left in
    // place and upserted: deleting them would orphan the chunks whose content hashes make
    // re-indexing cheap.)
    db.prepare("DELETE FROM edges").run();
    for (const s of allSymbols) insertSymbol.run(s.id, s.name, s.kind, s.file, s.startLine, s.endLine, s.language);
    for (const e of allEdges) insertEdge.run(e.fromSymbolId, e.toSymbolId, e.kind);
  });
  writeGraph();

  console.log("Embedding symbol source chunks (this calls the Voyage AI API)...");
  // Symbols are grouped by file, so many consecutive symbols come from the same source
  // file; re-reading and re-splitting it per symbol meant thousands of redundant reads of
  // the same file across the real tree.
  const lineCache = new Map<string, string[]>();
  const linesOf = (relPath: string): string[] => {
    let lines = lineCache.get(relPath);
    if (!lines) {
      lines = readFileSync(join(repoPath, relPath), "utf8").split("\n");
      lineCache.set(relPath, lines);
    }
    return lines;
  };

  const sourceOf = (s: Symbol) =>
    truncateForEmbedding(linesOf(s.file).slice(s.startLine - 1, s.endLine).join("\n"));

  // upsertChunks already skips a symbol whose content hash is unchanged — but only AFTER
  // its embedding has been paid for. On an unpaid Voyage key (3 RPM / 10k TPM) a full
  // index takes over an hour, so a restart that re-embedded everything would be brutal.
  // Do the same hash check up front and never send unchanged symbols to the API at all,
  // which makes the run resumable and makes re-indexing after a few commits nearly free.
  const existingHashes = new Map<string, string>();
  for (const row of db.prepare("SELECT symbol_id, content_hash FROM chunks").all() as Array<{
    symbol_id: string;
    content_hash: string;
  }>) {
    existingHashes.set(row.symbol_id, row.content_hash);
  }
  const pending = allSymbols.filter((s) => existingHashes.get(s.id) !== hashContent(sourceOf(s)));
  const skipped = allSymbols.length - pending.length;
  if (skipped > 0) console.log(`  ${skipped} symbols already embedded and unchanged; skipping them.`);

  const BATCH_SIZE = 100;
  let totalTokens = 0;
  let embeddedChunks = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const texts = batch.map(sourceOf);
    const { embeddings, totalTokens: batchTokens } = await embedTextsWithUsage(texts, apiKey);
    totalTokens += batchTokens;
    upsertChunks(
      db,
      batch.map((symbol, idx) => ({ symbol, text: texts[idx], embedding: embeddings[idx] })),
    );
    embeddedChunks += batch.length;
    console.log(
      `  embedded ${Math.min(i + BATCH_SIZE, pending.length)}/${pending.length} (${totalTokens.toLocaleString()} Voyage tokens so far)`,
    );
  }

  const chunkCount = (db.prepare("SELECT count(*) AS c FROM chunks").get() as { c: number }).c;
  const symbolCount = (db.prepare("SELECT count(*) AS c FROM symbols").get() as { c: number }).c;
  const edgeCount = (db.prepare("SELECT count(*) AS c FROM edges").get() as { c: number }).c;
  db.close();
  console.log(`Done. Wrote ${dbPath}`);
  console.log(
    `Index contents: ${symbolCount} symbols, ${edgeCount} edges, ${chunkCount} chunks (${embeddedChunks} embedded this run).`,
  );
  console.log(`Voyage tokens used this run (reported by the API): ${totalTokens.toLocaleString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
