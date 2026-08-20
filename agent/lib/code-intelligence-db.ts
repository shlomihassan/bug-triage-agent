import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL, vecTableSql } from "./code-intelligence-schema";

export function openCodeIntelligenceDb(path: string, options?: { readonly?: boolean }): Database.Database {
  const db = new Database(path, { readonly: options?.readonly ?? false, fileMustExist: options?.readonly ?? false });
  sqliteVec.load(db);
  if (!options?.readonly) {
    db.exec(SCHEMA_SQL);
    db.exec(vecTableSql());
  }
  return db;
}
