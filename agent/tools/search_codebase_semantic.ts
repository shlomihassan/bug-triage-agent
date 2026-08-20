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

async function searchChunks(queryEmbedding: number[], topK: number): Promise<ChunkMatch[]> {
  const db = createNeonDb();

  // Load all embeddings and compute similarity scores
  const vecResult = await db.exec(`SELECT id, embedding FROM ${table("chunks_vec")}`);
  if (!vecResult.length) return [];

  const similarities = vecResult[0].values.map((row) => {
    const id = row[0] as number;
    const embeddingJson = row[1] as string;
    const embedding = JSON.parse(embeddingJson);
    return { id, score: cosineSimilarity(queryEmbedding, embedding) };
  });

  // Sort by similarity and get top K
  const topResults = similarities.sort((a, b) => b.score - a.score).slice(0, topK);

  // Load all chunks to join with top results
  const chunkResult = await db.exec(`SELECT id, file_path, start_line, end_line FROM ${table("chunks")}`);
  const chunkMap = new Map<number, { filePath: string; startLine: number; endLine: number }>();
  if (chunkResult.length) {
    chunkResult[0].values.forEach((row) => {
      const id = row[0] as unknown as number;
      const filePath = row[1] as string;
      const startLine = row[2] as number;
      const endLine = row[3] as number;
      chunkMap.set(Number(id), { filePath, startLine, endLine });
    });
  }

  // Match top similarity results with chunk metadata
  const chunks: ChunkMatch[] = [];
  for (const { id, score } of topResults) {
    const chunk = chunkMap.get(id);
    if (chunk) {
      chunks.push({ ...chunk, score });
    }
  }

  return chunks;
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

    try {
      const [queryEmbedding] = await embedTexts([query], apiKey);
      const results = await searchChunks(queryEmbedding, topK);
      return { matches: results };
    } catch (err) {
      console.error("Search failed:", err);
      return { matches: [], note: "Search failed; fall back to grep/read" };
    }
  },
});
