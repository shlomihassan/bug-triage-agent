import { readFileSync } from "node:fs";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { join } from "node:path";

export const CODE_INTELLIGENCE_DB_PATH =
  process.env.CODE_INTELLIGENCE_DB_PATH ?? join(process.cwd(), "data/code-intelligence.sqlite");

let sqlJsInstance: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs() {
  if (!sqlJsInstance) {
    sqlJsInstance = await initSqlJs();
  }
  return sqlJsInstance;
}

export async function openCodeIntelligenceDb(path: string, _options?: { readonly?: boolean }): Promise<SqlJsDatabase> {
  const SQL = await getSqlJs();
  try {
    const fileBuffer = readFileSync(path);
    return new SQL.Database(fileBuffer);
  } catch (err) {
    console.error(`Failed to load database from ${path}:`, err);
    throw err;
  }
}
