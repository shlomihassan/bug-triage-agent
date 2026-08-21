/**
 * Convert code_intelligence.chunks_vec.embedding from TEXT (a JSON array string) to pgvector's
 * native `vector(1024)` type.
 *
 * Why this exists: migrate-embeddings.ts created the column as TEXT and stored each embedding
 * as JSON.stringify(floats) — even though `CREATE EXTENSION vector` had already been run. That
 * meant every call to search_codebase_semantic had to fetch all 5,306 rows (measured: 115MB,
 * ~9.3s) and compute cosine similarity in JavaScript, because the column was never actually
 * using pgvector's type, operators, or indexing — the extension was enabled but unused.
 *
 * Run once: npx tsx scripts/migrate-embeddings-to-vector.ts
 */
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const SCHEMA = "code_intelligence";

function loadEnvLocal(): void {
  const raw = readFileSync(".env.local", "utf-8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq);
    let v = t.slice(eq + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error("DATABASE_URL_UNPOOLED not set");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  try {
    const before = await pool.query(
      `SELECT data_type, udt_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'chunks_vec' AND column_name = 'embedding'`,
      [SCHEMA],
    );
    console.log("Current embedding column type:", before.rows[0]);

    if (before.rows[0]?.udt_name === "vector") {
      console.log("Already vector type — nothing to do.");
      return;
    }

    console.log("Adding embedding_vec vector(1024) column...");
    await pool.query(
      `ALTER TABLE ${SCHEMA}.chunks_vec ADD COLUMN IF NOT EXISTS embedding_vec vector(1024)`,
    );

    console.log("Backfilling from the JSON-text column (cast via pgvector's own parser)...");
    const result = await pool.query(
      `UPDATE ${SCHEMA}.chunks_vec SET embedding_vec = embedding::vector WHERE embedding_vec IS NULL`,
    );
    console.log(`Backfilled ${result.rowCount} rows.`);

    console.log("Swapping columns: embedding (TEXT) -> embedding_old, embedding_vec -> embedding...");
    await pool.query(`ALTER TABLE ${SCHEMA}.chunks_vec RENAME COLUMN embedding TO embedding_old`);
    await pool.query(`ALTER TABLE ${SCHEMA}.chunks_vec RENAME COLUMN embedding_vec TO embedding`);
    await pool.query(`ALTER TABLE ${SCHEMA}.chunks_vec ALTER COLUMN embedding SET NOT NULL`);

    // IVFFlat needs training data present at CREATE INDEX time (it does), and `lists` should be
    // roughly sqrt(row count) per pgvector's own guidance — sqrt(5306) ≈ 73.
    console.log("Building IVFFlat index for fast approximate nearest-neighbor search...");
    await pool.query(
      `CREATE INDEX IF NOT EXISTS chunks_vec_embedding_idx ON ${SCHEMA}.chunks_vec
       USING ivfflat (embedding vector_cosine_ops) WITH (lists = 73)`,
    );

    console.log("Dropping the old TEXT column...");
    await pool.query(`ALTER TABLE ${SCHEMA}.chunks_vec DROP COLUMN embedding_old`);

    const after = await pool.query(
      `SELECT data_type, udt_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'chunks_vec' AND column_name = 'embedding'`,
      [SCHEMA],
    );
    console.log("New embedding column type:", after.rows[0]);

    const count = await pool.query(`SELECT COUNT(*) FROM ${SCHEMA}.chunks_vec WHERE embedding IS NOT NULL`);
    console.log(`\n✓ Done. ${count.rows[0].count} rows now hold native vector(1024) embeddings.`);
  } finally {
    await pool.end();
  }
}

void main();
