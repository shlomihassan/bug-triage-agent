import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

// Load .env.local
const envContent = readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const [key, ...valueParts] = line.split("=");
  if (key && valueParts.length > 0) {
    let value = valueParts.join("=").trim();
    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  console.error("❌ Redis credentials not available");
  process.exit(1);
}

const redis = new Redis({ url, token });

async function checkRuns() {
  try {
    const runIds = await redis.lrange("bug-run-index", 0, -1);
    console.log(`\n📊 Found ${runIds.length} runs in Redis\n`);

    for (const runId of runIds.slice(0, 10)) {
      const run = await redis.get(`bug-run:${runId}`);
      if (run) {
        console.log(`Run: ${runId}`);
        console.log(`  Issue #${run.issueNumber}: ${run.issueTitle}`);
        console.log(`  Started: ${run.startedAt}`);
        console.log(`  Status: ${run.status}`);
        console.log(`  Severity: ${run.severity || '-'}`);
        console.log();
      }
    }
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

checkRuns();
