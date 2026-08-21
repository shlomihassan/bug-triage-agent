import { defineTool } from "eve/tools";
import { z } from "zod";
import { createNeonDb, table } from "../lib/neon-db";
import { embedTexts } from "../../indexing/embed-semantic";

export interface ChunkMatch {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
}

async function searchChunks(queryEmbedding: number[], topK: number): Promise<ChunkMatch[]> {
  const db = createNeonDb();
  // chunks_vec.embedding is a native pgvector `vector(1024)` column (see
  // scripts/migrate-embeddings-to-vector.ts) backed by an IVFFlat index. `<=>` is pgvector's
  // cosine-distance operator; ORDER BY it ASC with LIMIT pushes the whole nearest-neighbor
  // search into Postgres instead of pulling every embedding over the wire and ranking in JS —
  // the previous version fetched all 5,306 rows (measured: 115MB, ~9.3s) on every call, with
  // no logging anywhere in the path, so a slow or degraded run of that query looked identical
  // to a silent hang.
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;
  const result = await db.query(
    `SELECT c.file_path, c.start_line, c.end_line, 1 - (v.embedding <=> $1::vector) AS score
     FROM ${table("chunks_vec")} v
     JOIN ${table("chunks")} c ON c.id = v.id
     ORDER BY v.embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral, topK],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    filePath: row.file_path as string,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    score: Number(row.score),
  }));
}

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

    if (!process.env.DATABASE_URL_UNPOOLED) {
      return { matches: [], note: "Code intelligence database not configured; fall back to grep/read" };
    }

    console.log(`[search_codebase_semantic] query="${query}" topK=${topK}`);
    const startedAt = Date.now();
    try {
      const [queryEmbedding] = await embedTexts([query], apiKey);
      const results = await searchChunks(queryEmbedding, topK);
      console.log(
        `[search_codebase_semantic] ✅ ${results.length} matches in ${Date.now() - startedAt}ms`,
      );
      return { matches: results };
    } catch (err) {
      console.error(`[search_codebase_semantic] ✖ failed after ${Date.now() - startedAt}ms:`, err);
      return { matches: [], note: "Search failed; fall back to grep/read" };
    }
  },
});
