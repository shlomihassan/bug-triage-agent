import { Pool, QueryResult } from "pg";

const SCHEMA = "code_intelligence";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
    });
  }
  return pool;
}

export interface QueryExecResult {
  columns: string[];
  values: (string | number | null)[][];
}

export class NeonDatabase {
  async exec(sql: string): Promise<QueryExecResult[]> {
    const client = getPool();
    try {
      const result = await client.query(sql);
      if (result.rows.length === 0) return [];
      return [
        {
          columns: result.fields.map((f) => f.name),
          values: result.rows.map((row) => Object.values(row)),
        },
      ];
    } catch (err) {
      console.error(`Query failed: ${sql}`, err);
      throw err;
    }
  }

  async queryScalar<T>(sql: string, params: any[] = []): Promise<T | null> {
    const client = getPool();
    try {
      const result = await client.query(sql, params);
      if (result.rows.length === 0) return null;
      return Object.values(result.rows[0])[0] as T;
    } catch (err) {
      console.error(`Query failed: ${sql}`, err);
      throw err;
    }
  }

  async query(sql: string, params: any[] = []): Promise<QueryResult> {
    const client = getPool();
    try {
      return await client.query(sql, params);
    } catch (err) {
      console.error(`Query failed: ${sql}`, err);
      throw err;
    }
  }
}

export function createNeonDb(): NeonDatabase {
  return new NeonDatabase();
}

export async function closeNeonDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Helper to qualify table names with schema
export function table(name: string): string {
  return `${SCHEMA}.${name}`;
}
