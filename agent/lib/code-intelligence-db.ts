import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { join } from "node:path";
import { SCHEMA_SQL, vecTableSql } from "./code-intelligence-schema";

/**
 * Location of the prebuilt, committed index, relative to the project root.
 *
 * Deliberately NOT under `agent/lib/` (where the design doc originally put it): eve's
 * module discovery treats every entry under the agent root's `lib/` as an authored source
 * module and fails the build outright on a binary file —
 * `Expected ".../agent/lib/code-intelligence.sqlite" to be a supported authored module
 * within "lib/"`. A top-level `data/` directory sits outside the agent root, so discovery
 * ignores it while `vercel deploy` still uploads it with the rest of the project.
 */
export const CODE_INTELLIGENCE_DB_PATH = join(process.cwd(), "data/code-intelligence.sqlite");

export function openCodeIntelligenceDb(path: string, options?: { readonly?: boolean }): Database.Database {
  const db = new Database(path, { readonly: options?.readonly ?? false, fileMustExist: options?.readonly ?? false });
  sqliteVec.load(db);
  if (!options?.readonly) {
    db.exec(SCHEMA_SQL);
    db.exec(vecTableSql());
  }
  return db;
}
