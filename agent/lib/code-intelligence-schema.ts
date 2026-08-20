export interface Symbol {
  id: string;
  name: string;
  kind: "function" | "method" | "type";
  file: string;
  startLine: number;
  endLine: number;
  language: "go" | "typescript" | "vue";
}

export interface Edge {
  fromSymbolId: string;
  toSymbolId: string;
  kind: "calls";
}

export interface Chunk {
  id: string;
  symbolId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  contentHash: string;
}

export const EMBEDDING_DIMENSIONS = 1024;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  from_symbol_id TEXT NOT NULL,
  to_symbol_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (from_symbol_id, to_symbol_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS chunks (
  rowid INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  symbol_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
`;

export function vecTableSql(): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    embedding float[${EMBEDDING_DIMENSIONS}]
  );`;
}
