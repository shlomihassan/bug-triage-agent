import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
});

async function test() {
  try {
    console.log("Testing Neon connection...");

    const symbolCount = await pool.query(
      `SELECT COUNT(*) FROM code_intelligence.symbols`
    );
    console.log(`✓ Symbols: ${symbolCount.rows[0].count}`);

    const edgeCount = await pool.query(
      `SELECT COUNT(*) FROM code_intelligence.edges`
    );
    console.log(`✓ Edges: ${edgeCount.rows[0].count}`);

    const chunkCount = await pool.query(
      `SELECT COUNT(*) FROM code_intelligence.chunks`
    );
    console.log(`✓ Chunks: ${chunkCount.rows[0].count}`);

    const sample = await pool.query(
      `SELECT name, file FROM code_intelligence.symbols LIMIT 1`
    );
    console.log(`✓ Sample symbol: ${sample.rows[0].name} in ${sample.rows[0].file}`);

    console.log("\n✅ Database is ACCESSIBLE and has data!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Database error:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

test();
