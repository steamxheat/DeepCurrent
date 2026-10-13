import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { collectorHealthReport } from "../src/lib/collector-health.ts";

const hours = Number(process.argv[2] ?? 24);
assert.ok(Number.isFinite(hours) && hours > 0 && hours <= 720, "Usage: npm run report:collector -- <hours: 1..720>");
const db = new DatabaseSync(process.env.DEEPCURRENT_DB_PATH || ".data/deep-current.sqlite", { readOnly: true });
try { console.log(JSON.stringify(collectorHealthReport(db, Math.max(0, Date.now() - Math.round(hours * 3600000))), null, 2)); }
finally { db.close(); }
