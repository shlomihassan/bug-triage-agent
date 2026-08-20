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
  const findExisting = db.prepare("SELECT rowid, content_hash FROM chunks WHERE symbol_id = ?");
  const deleteChunk = db.prepare("DELETE FROM chunks WHERE rowid = ?");
  const deleteVec = db.prepare("DELETE FROM chunks_vec WHERE rowid = ?");
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, symbol_id, file_path, start_line, end_line, language, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertVec = db.prepare("INSERT INTO chunks_vec (embedding) VALUES (vec_f32(?))");
  const getLastVecRowid = db.prepare("SELECT last_insert_rowid() as rowid");

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
    insertVec.run(JSON.stringify(chunk.embedding));
  });

  for (const chunk of chunks) upsertOne(chunk);
}
