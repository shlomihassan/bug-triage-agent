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

export function findRelatedSymbols(
  db: Database.Database,
  input: { symbolName: string; direction: "callers" | "callees"; depth: number },
): RelatedSymbol[] {
  const edgeDirection = input.direction === "callers" ? "to_symbol_id" : "from_symbol_id";
  const targetDirection = input.direction === "callers" ? "from_symbol_id" : "to_symbol_id";

  const sql = `
    WITH RECURSIVE related(id, hops) AS (
      SELECT s.id, 0
      FROM symbols s
      WHERE s.name = ?
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
  return db.prepare(sql).all(input.symbolName, input.depth) as RelatedSymbol[];
}

const DB_PATH = join(process.cwd(), "agent/lib/code-intelligence.sqlite");

const inputSchema = z.object({
  symbolName: z.string().describe("The function or method name to look up, e.g. 'CanDelete'"),
  direction: z.enum(["callers", "callees"]).describe("'callers' finds what calls this symbol; 'callees' finds what this symbol calls"),
  depth: z.number().int().min(1).max(5).default(2).describe("How many hops to traverse (default 2)"),
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
});

export default defineTool({
  description:
    "Find real callers or callees of a function/method by name, walking the call graph up to N hops. Use before editing a shared function to see what depends on it (blast radius), or to trace how a suspect function gets invoked.",
  inputSchema,
  outputSchema,
  async execute({ symbolName, direction, depth }) {
    let db: Database.Database;
    try {
      db = openCodeIntelligenceDb(DB_PATH, { readonly: true });
    } catch {
      return { matches: [], note: "code-intelligence.sqlite not available; fall back to grep/read" };
    }
    try {
      const matches = findRelatedSymbols(db, { symbolName, direction, depth });
      return { matches };
    } finally {
      db.close();
    }
  },
});
