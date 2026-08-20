import { defineTool } from "eve/tools";
import { z } from "zod";
import { createNeonDb, table } from "../lib/neon-db";

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

async function findRelatedSymbols(
  input: { symbolName: string; direction: "callers" | "callees"; depth: number; file?: string },
): Promise<QueryResult> {
  const db = createNeonDb();

  // Check for ambiguous symbol names, applying file filter if provided
  let ambiguityQuery = `SELECT DISTINCT name, file, start_line, end_line FROM ${table("symbols")} WHERE name = $1`;
  const ambiguityParams: any[] = [input.symbolName];

  if (input.file) {
    ambiguityQuery += ` AND file = $2`;
    ambiguityParams.push(input.file);
  }

  const ambiguityResult = await db.query(ambiguityQuery, ambiguityParams);
  const ambiguousCheck = ambiguityResult.rows.map((row) => ({
    name: row.name as string,
    file: row.file as string,
    start_line: row.start_line as number,
    end_line: row.end_line as number,
  }));

  if (ambiguousCheck.length > 1) {
    const candidateDesc = input.file
      ? `(${ambiguousCheck.length} symbols with same name in file "${input.file}", distinguished by line numbers)`
      : `(${ambiguousCheck.length} symbols found in different files)`;
    return {
      matches: [],
      note: `Symbol name "${input.symbolName}" is ambiguous ${candidateDesc}. Please provide ${input.file ? "start and end line numbers to" : "a file to"} disambiguate.`,
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

  let paramIndex = 1;
  let whereClause = `WHERE s.name = $${paramIndex++}`;
  const params: any[] = [input.symbolName];

  if (input.file) {
    whereClause += ` AND s.file = $${paramIndex++}`;
    params.push(input.file);
  }

  const sql = `
    WITH RECURSIVE related(id, hops) AS (
      SELECT s.id, 0
      FROM ${table("symbols")} s
      ${whereClause}
      UNION
      SELECT e.${targetDirection}, related.hops + 1
      FROM ${table("edges")} e
      JOIN related ON e.${edgeDirection} = related.id
      WHERE related.hops < $${paramIndex}
    )
    SELECT DISTINCT sym.name AS symbol, sym.file AS file, sym.start_line AS startLine,
           sym.end_line AS endLine, MIN(related.hops) AS hops
    FROM related
    JOIN ${table("symbols")} sym ON sym.id = related.id
    WHERE related.hops > 0
    GROUP BY sym.id
    ORDER BY hops ASC, sym.name ASC
  `;

  params.push(input.depth);
  const result = await db.query(sql, params);
  const matches: RelatedSymbol[] = result.rows.map((row) => ({
    symbol: row.symbol as string,
    file: row.file as string,
    startLine: row.startline as number,
    endLine: row.endline as number,
    hops: row.hops as number,
  }));

  return { matches };
}

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
    if (!process.env.DATABASE_URL_UNPOOLED) {
      return { matches: [], note: "Code intelligence database not configured; fall back to grep/read" };
    }

    try {
      const result = await findRelatedSymbols({ symbolName, direction, depth, file });
      return result;
    } catch (err) {
      console.error("Query failed:", err);
      return { matches: [], note: "Query failed; fall back to grep/read" };
    }
  },
});
