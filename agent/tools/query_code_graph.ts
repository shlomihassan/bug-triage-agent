import { defineTool } from "eve/tools";
import { z } from "zod";
import type Database from "better-sqlite3";
import { openCodeIntelligenceDb } from "../lib/code-intelligence-db";
import { join } from "node:path";

export interface RelatedSymbol {
  symbol: string;
  file: string;
  startLine: number;
  endLine: number;
  hops: number;
}

export interface QueryResult {
  matches: RelatedSymbol[];
  note?: string;
  ambiguousCandidates?: Array<{ name: string; file: string; startLine: number; endLine: number }>;
}

export function findRelatedSymbols(
  db: Database.Database,
  input: { symbolName: string; direction: "callers" | "callees"; depth: number; file?: string },
): QueryResult {
  // Check for ambiguous symbol names (multiple symbols with same name in different files)
  const ambiguousCheck = db
    .prepare(
      `
    SELECT DISTINCT name, file, start_line, end_line FROM symbols WHERE name = ?
    `,
    )
    .all(input.symbolName) as Array<{ name: string; file: string; start_line: number; end_line: number }>;

  if (ambiguousCheck.length > 1 && !input.file) {
    return {
      matches: [],
      note: `Symbol name "${input.symbolName}" is ambiguous (${ambiguousCheck.length} symbols found in different files). Please provide a file to disambiguate.`,
      ambiguousCandidates: ambiguousCheck.map((c) => ({
        name: c.name,
        file: c.file,
        startLine: c.start_line,
        endLine: c.end_line,
      })),
    };
  }

  const edgeDirection = input.direction === "callers" ? "to_symbol_id" : "from_symbol_id";
  const targetDirection = input.direction === "callers" ? "from_symbol_id" : "to_symbol_id";

  let whereClause = "WHERE s.name = ?";
  const params: (string | number)[] = [input.symbolName];

  if (input.file) {
    whereClause += " AND s.file = ?";
    params.push(input.file);
  }

  const sql = `
    WITH RECURSIVE related(id, hops) AS (
      SELECT s.id, 0
      FROM symbols s
      ${whereClause}
      UNION
      SELECT e.${targetDirection}, related.hops + 1
      FROM edges e
      JOIN related ON e.${edgeDirection} = related.id
      WHERE related.hops < ?
    )
    SELECT DISTINCT sym.name AS symbol, sym.file AS file, sym.start_line AS startLine,
           sym.end_line AS endLine, MIN(related.hops) AS hops
    FROM related
    JOIN symbols sym ON sym.id = related.id
    WHERE related.hops > 0
    GROUP BY sym.id
    ORDER BY hops ASC, sym.name ASC
  `;

  params.push(input.depth);
  const matches = db.prepare(sql).all(...params) as RelatedSymbol[];
  return { matches };
}

const DB_PATH = join(process.cwd(), "agent/lib/code-intelligence.sqlite");

const inputSchema = z.object({
  symbolName: z.string().describe("The function or method name to look up, e.g. 'CanDelete'"),
  direction: z.enum(["callers", "callees"]).describe("'callers' finds what calls this symbol; 'callees' finds what this symbol calls"),
  depth: z.number().int().min(1).max(5).default(2).describe("How many hops to traverse (default 2)"),
  file: z.string().optional().describe("Optional: file path to disambiguate when the symbol name appears in multiple files"),
});

const outputSchema = z.object({
  matches: z.array(
    z.object({
      symbol: z.string(),
      file: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      hops: z.number(),
    }),
  ),
  note: z.string().optional(),
  ambiguousCandidates: z
    .array(
      z.object({
        name: z.string(),
        file: z.string(),
        startLine: z.number(),
        endLine: z.number(),
      }),
    )
    .optional(),
});

export default defineTool({
  description:
    "Find real callers or callees of a function/method by name, walking the call graph up to N hops. Use before editing a shared function to see what depends on it (blast radius), or to trace how a suspect function gets invoked.",
  inputSchema,
  outputSchema,
  async execute({ symbolName, direction, depth, file }) {
    let db: Database.Database;
    try {
      db = openCodeIntelligenceDb(DB_PATH, { readonly: true });
    } catch {
      return { matches: [], note: "code-intelligence.sqlite not available; fall back to grep/read" };
    }
    try {
      const result = findRelatedSymbols(db, { symbolName, direction, depth, file });
      return result;
    } finally {
      db.close();
    }
  },
});
