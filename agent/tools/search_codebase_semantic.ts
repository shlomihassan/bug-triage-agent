import { defineTool } from "eve/tools";
import { z } from "zod";
import type { Database as SqlJsDatabase } from "sql.js";
import { CODE_INTELLIGENCE_DB_PATH, openCodeIntelligenceDb } from "../lib/code-intelligence-db";
import { embedTexts } from "../../indexing/embed-semantic";

export interface ChunkMatch {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function searchChunks(db: SqlJsDatabase, queryEmbedding: number[], topK: number): ChunkMatch[] {
  // Load all embeddings and compute similarity scores
  const result = db.exec(`
    SELECT rowid, embedding FROM chunks_vec
  `);

  if (!result.length) return [];

  const rows = result[0].values as Array<[number, string]>;
  const similarities = rows.map(([rowid, embeddingJson]) => {
    const embedding = JSON.parse(embeddingJson);
    return { rowid, score: cosineSimilarity(queryEmbedding, embedding) };
  });

  // Sort by similarity and get top K
  const topResults = similarities.sort((a, b) => b.score - a.score).slice(0, topK);

  // Get chunk metadata for top results
  const chunks: ChunkMatch[] = [];
  for (const { rowid, score } of topResults) {
    const stmt = db.prepare(`
      SELECT file_path, start_line, end_line FROM chunks WHERE rowid = ?
    `);
    stmt.bind([rowid]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { file_path: string; start_line: number; end_line: number };
      chunks.push({ filePath: row.file_path, startLine: row.start_line, endLine: row.end_line, score });
    }
    stmt.free();
  }

  return chunks;
}

const DB_PATH = CODE_INTELLIGENCE_DB_PATH;

export default defineTool({
  description:
    "Semantically search the Vikunja codebase for code related to a natural-language description (e.g. 'permission check for deleting task attachments'). Use this before broad grep/read to locate candidate files fast.",
  inputSchema: z.object({
    query: z.string().describe("A natural-language description of the code you're looking for"),
    topK: z.number().int().min(1).max(20).default(10),
  }),
  async execute({ query, topK }) {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      console.log("VOYAGE_API_KEY not configured");
      return { matches: [], note: "VOYAGE_API_KEY not configured; fall back to grep/read" };
    }
    let db: SqlJsDatabase;
    try {
      console.log(`Opening database from ${DB_PATH}`);
      db = await openCodeIntelligenceDb(DB_PATH, { readonly: true });
      console.log("Database opened successfully");
    } catch (err) {
      console.error("Failed to open database:", err);
      return { matches: [], note: "code-intelligence.sqlite not available; fall back to grep/read" };
    }
    try {
      console.log(`Embedding query: "${query}"`);
      const [queryEmbedding] = await embedTexts([query], apiKey);
      console.log("Query embedding successful, searching chunks...");
      const results = searchChunks(db, queryEmbedding, topK);
      console.log(`Search returned ${results.length} results`);
      return { matches: results };
    } catch (err) {
      console.error("Search failed:", err);
      return { matches: [], note: "embedding request failed; fall back to grep/read" };
    }
  },
});
