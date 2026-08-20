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
    const result = db.exec(`
      SELECT file_path, start_line, end_line FROM chunks WHERE rowid = ?
    `, [rowid]);

    if (result.length && result[0].values.length) {
      const [filePath, startLine, endLine] = result[0].values[0] as [string, number, number];
      chunks.push({ filePath, startLine, endLine, score });
    }
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
      return { matches: [], note: "VOYAGE_API_KEY not configured; fall back to grep/read" };
    }
    let db: SqlJsDatabase;
    try {
      db = await openCodeIntelligenceDb(DB_PATH, { readonly: true });
    } catch {
      return { matches: [], note: "code-intelligence.sqlite not available; fall back to grep/read" };
    }
    try {
      const [queryEmbedding] = await embedTexts([query], apiKey);
      return { matches: searchChunks(db, queryEmbedding, topK) };
    } catch {
      return { matches: [], note: "embedding request failed; fall back to grep/read" };
    }
  },
});
