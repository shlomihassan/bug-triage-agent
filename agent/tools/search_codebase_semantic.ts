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
  // First get the nearest chunks by embedding similarity
  const vecSql = `
    SELECT rowid, distance
    FROM chunks_vec
    WHERE embedding MATCH vec_f32(?)
    ORDER BY distance
    LIMIT ?
  `;
  const vecResults = db.prepare(vecSql).all(JSON.stringify(queryEmbedding), topK) as Array<{ rowid: number; distance: number }>;

  // Then join with chunks table to get full metadata
  const chunkSql = `
    SELECT file_path AS filePath, start_line AS startLine, end_line AS endLine
    FROM chunks
    WHERE rowid = ?
  `;
  const getChunk = db.prepare(chunkSql);

  return vecResults
    .map((result) => {
      const chunk = getChunk.get(result.rowid) as { filePath: string; startLine: number; endLine: number } | undefined;
      return chunk ? { ...chunk, score: result.distance } : null;
    })
    .filter((r): r is ChunkMatch => r !== null);
}

const DB_PATH = join(process.cwd(), "agent/lib/code-intelligence.sqlite");

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
