import { readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { Pool } from "pg";

const DB_PATH = join(process.cwd(), "data/code-intelligence.sqlite");
const SCHEMA = "code_intelligence";

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  initialDelayMs = 2000,
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const delay = initialDelayMs * Math.pow(2, i);
      console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Should not reach here");
}

async function migrate() {
  console.log("Loading SQLite database...");
  const SQL = await initSqlJs();
  const fileBuffer = readFileSync(DB_PATH);
  const db = new SQL.Database(fileBuffer);

  console.log("Connecting to Neon...");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_UNPOOLED,
  });

  try {
    console.log(`Creating schema '${SCHEMA}' if not exists...`);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

    console.log("Enabling pgvector extension...");
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {
      console.log("pgvector not available, using TEXT for embeddings");
    });

    console.log("Creating tables...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.symbols (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.edges (
        from_symbol_id TEXT NOT NULL,
        to_symbol_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (from_symbol_id) REFERENCES ${SCHEMA}.symbols(id),
        FOREIGN KEY (to_symbol_id) REFERENCES ${SCHEMA}.symbols(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.chunks (
        id TEXT PRIMARY KEY,
        symbol_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        language TEXT,
        content_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (symbol_id) REFERENCES ${SCHEMA}.symbols(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.chunks_vec (
        id TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (id) REFERENCES ${SCHEMA}.chunks(id)
      )
    `);


    console.log("Migrating symbols...");
    const symbolsResult = db.exec("SELECT id, name, file, start_line, end_line FROM symbols");
    if (symbolsResult.length) {
      const cols = symbolsResult[0].columns;
      const symbols = symbolsResult[0].values;
      const batchSize = 500;
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const values = batch
          .map(
            (_, idx) =>
              `($${idx * 5 + 1}, $${idx * 5 + 2}, $${idx * 5 + 3}, $${idx * 5 + 4}, $${idx * 5 + 5})`,
          )
          .join(",");
        const params = batch.flatMap((row) => [
          row[cols.indexOf("id")],
          row[cols.indexOf("name")],
          row[cols.indexOf("file")],
          row[cols.indexOf("start_line")],
          row[cols.indexOf("end_line")],
        ]);
        await retryWithBackoff(
          () =>
            pool.query(
              `INSERT INTO ${SCHEMA}.symbols (id, name, file, start_line, end_line) VALUES ${values} ON CONFLICT DO NOTHING`,
              params,
            ),
          5,
          2000,
        );
        console.log(
          `Migrated symbols batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(symbols.length / batchSize)}`,
        );
      }
      console.log(`Migrated ${symbols.length} symbols total`);
    }

    console.log("Migrating edges...");
    const edgesResult = db.exec("SELECT from_symbol_id, to_symbol_id FROM edges");
    if (edgesResult.length) {
      const cols = edgesResult[0].columns;
      const edges = edgesResult[0].values;
      const batchSize = 1000;
      for (let i = 0; i < edges.length; i += batchSize) {
        const batch = edges.slice(i, i + batchSize);
        const values = batch
          .map(
            (row, idx) =>
              `($${idx * 2 + 1}, $${idx * 2 + 2})`,
          )
          .join(",");
        const params = batch.flatMap((row) => [
          row[cols.indexOf("from_symbol_id")],
          row[cols.indexOf("to_symbol_id")],
        ]);
        await retryWithBackoff(
          () =>
            pool.query(
              `INSERT INTO ${SCHEMA}.edges (from_symbol_id, to_symbol_id) VALUES ${values}`,
              params,
            ),
          5,
          2000,
        );
        console.log(`Migrated edges batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(edges.length / batchSize)}`);
      }
      console.log(`Migrated ${edges.length} edges total`);
    }

    console.log("Migrating chunks...");
    const chunksResult = db.exec(
      "SELECT id, symbol_id, file_path, start_line, end_line, language, content_hash FROM chunks",
    );
    if (chunksResult.length) {
      const cols = chunksResult[0].columns;
      for (const row of chunksResult[0].values) {
        await pool.query(
          `INSERT INTO ${SCHEMA}.chunks (id, symbol_id, file_path, start_line, end_line, language, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            row[cols.indexOf("id")],
            row[cols.indexOf("symbol_id")],
            row[cols.indexOf("file_path")],
            row[cols.indexOf("start_line")],
            row[cols.indexOf("end_line")],
            row[cols.indexOf("language")],
            row[cols.indexOf("content_hash")],
          ],
        );
      }
      console.log(`Migrated ${chunksResult[0].values.length} chunks`);
    }

    console.log("Migrating embeddings...");
    const vecResult = db.exec("SELECT rowid, embedding FROM chunks_vec");
    if (vecResult.length) {
      const cols = vecResult[0].columns;
      for (const row of vecResult[0].values) {
        await pool.query(
          `INSERT INTO ${SCHEMA}.chunks_vec (id, embedding) VALUES ($1, $2)`,
          [row[cols.indexOf("rowid")], row[cols.indexOf("embedding")]],
        );
      }
      console.log(`Migrated ${vecResult[0].values.length} embeddings`);
    }

    console.log("✓ Migration complete!");
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
