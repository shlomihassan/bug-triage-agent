import { readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { Pool } from "pg";

const DB_PATH = join(process.cwd(), "data/code-intelligence.sqlite");
const SCHEMA = "code_intelligence";

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
    console.log(`Creating schema '${SCHEMA}'...`);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

    console.log("Creating tables...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.symbols (
        id BIGINT PRIMARY KEY,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.edges (
        id BIGINT PRIMARY KEY,
        from_symbol_id BIGINT NOT NULL,
        to_symbol_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (from_symbol_id) REFERENCES ${SCHEMA}.symbols(id),
        FOREIGN KEY (to_symbol_id) REFERENCES ${SCHEMA}.symbols(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.chunks (
        id TEXT PRIMARY KEY,
        symbol_id BIGINT NOT NULL,
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
        id BIGINT PRIMARY KEY,
        embedding VECTOR(1024),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("Clearing existing data...");
    await pool.query(`TRUNCATE TABLE ${SCHEMA}.chunks_vec`);
    await pool.query(`TRUNCATE TABLE ${SCHEMA}.chunks`);
    await pool.query(`TRUNCATE TABLE ${SCHEMA}.edges`);
    await pool.query(`TRUNCATE TABLE ${SCHEMA}.symbols`);

    console.log("Migrating symbols...");
    const symbolsResult = db.exec("SELECT id, name, file, start_line, end_line FROM symbols");
    if (symbolsResult.length) {
      const cols = symbolsResult[0].columns;
      for (const row of symbolsResult[0].values) {
        await pool.query(
          `INSERT INTO ${SCHEMA}.symbols (id, name, file, start_line, end_line) VALUES ($1, $2, $3, $4, $5)`,
          [
            row[cols.indexOf("id")],
            row[cols.indexOf("name")],
            row[cols.indexOf("file")],
            row[cols.indexOf("start_line")],
            row[cols.indexOf("end_line")],
          ],
        );
      }
      console.log(`Migrated ${symbolsResult[0].values.length} symbols`);
    }

    console.log("Migrating edges...");
    const edgesResult = db.exec("SELECT id, from_symbol_id, to_symbol_id FROM edges");
    if (edgesResult.length) {
      const cols = edgesResult[0].columns;
      for (const row of edgesResult[0].values) {
        await pool.query(
          `INSERT INTO ${SCHEMA}.edges (id, from_symbol_id, to_symbol_id) VALUES ($1, $2, $3)`,
          [
            row[cols.indexOf("id")],
            row[cols.indexOf("from_symbol_id")],
            row[cols.indexOf("to_symbol_id")],
          ],
        );
      }
      console.log(`Migrated ${edgesResult[0].values.length} edges`);
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
          `INSERT INTO ${SCHEMA}.chunks_vec (id, embedding) VALUES ($1, $2::vector)`,
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
