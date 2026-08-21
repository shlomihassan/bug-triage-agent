/**
 * Migrate the semantic embeddings from the committed SQLite index into Neon.
 *
 * Why this is a separate script from migrate-to-neon.ts: the embeddings live in `chunks_vec`,
 * a `vec0` virtual table created by the sqlite-vec extension. migrate-to-neon.ts reads the file
 * with sql.js, which cannot load SQLite extensions at all, so its embedding pass dies with
 * "no such module: vec0" and silently skips 5,310 vectors. Neon ends up with symbols and edges
 * but an empty chunks_vec, which makes search_codebase_semantic return nothing and fall back to
 * grep — working, but blind.
 *
 * better-sqlite3 + sqlite-vec read that table fine; they were only dropped from the runtime
 * because better-sqlite3 will not compile on Vercel (Python 3.12 removed distutils, which
 * node-gyp needs). That constraint does not apply here: this is a one-off local script, and
 * both packages are already devDependencies.
 *
 * Run: npx tsx scripts/migrate-embeddings.ts
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { Pool } from "pg";

const DB_PATH = "data/code-intelligence.sqlite";
const SCHEMA = "code_intelligence";
const BATCH = 250;

function loadEnvLocal(): void {
  let raw: string;
  try {
    raw = readFileSync(".env.local", "utf-8");
  } catch {
    return;
  }
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

  const sqlite = new Database(DB_PATH, { readonly: true });
  sqliteVec.load(sqlite);

  // The chunks table carries two keys: an INTEGER rowid and a TEXT id like
  // "pkg/models/api_tokens.go:72-77". chunks_vec.rowid links to chunks.ROWID, not chunks.id.
  // Neon's chunks_vec.id is TEXT with an FK to chunks(id), so translate through the rowid here
  // and store the text id — that is the key the runtime tool can actually join on.
  const linkage = sqlite
    .prepare("SELECT COUNT(*) AS n FROM chunks_vec v JOIN chunks c ON c.rowid = v.rowid")
    .get() as { n: number };
  const total = (sqlite.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get() as { n: number }).n;
  console.log(`chunks_vec rows: ${total}, of which ${linkage.n} join to chunks.rowid`);
  if (linkage.n === 0) throw new Error("rowid linkage is broken — aborting");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  try {
    const rows = sqlite
      .prepare(
        "SELECT c.id AS id, v.embedding AS embedding " +
          "FROM chunks_vec v JOIN chunks c ON c.rowid = v.rowid",
      )
      .all() as { id: string; embedding: Buffer }[];

    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values = batch.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(",");
      const params = batch.flatMap((r) => {
        // sqlite-vec stores each vector as packed float32. The runtime tool JSON.parse()s the
        // embedding column, so serialise to a plain JSON array of numbers here.
        const floats = new Float32Array(
          r.embedding.buffer,
          r.embedding.byteOffset,
          r.embedding.byteLength / 4,
        );
        return [r.id, JSON.stringify(Array.from(floats))];
      });
      await pool.query(
        `INSERT INTO ${SCHEMA}.chunks_vec (id, embedding) VALUES ${values} ` +
          `ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        params,
      );
      done += batch.length;
      console.log(`  ${done}/${rows.length}`);
    }

    const check = await pool.query(`SELECT COUNT(*) FROM ${SCHEMA}.chunks_vec`);
    console.log(`\nNeon chunks_vec now holds ${check.rows[0].count} embeddings.`);
  } finally {
    sqlite.close();
    await pool.end();
  }
}

void main();
