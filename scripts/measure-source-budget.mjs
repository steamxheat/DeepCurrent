import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const hours = Number(process.argv.slice(2).find(argument => !argument.startsWith("--")) ?? 1);
assert.ok(Number.isFinite(hours) && hours > 0 && hours <= 24);
const percentile = (values, fraction) => {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? null;
};
assert.equal(percentile([], .95), null);
assert.equal(percentile([20, 5, -1, NaN], .5), 20);
if (process.argv.includes("--self-test")) { console.log("source-budget self-check passed"); process.exit(0); }
const db = new DatabaseSync(process.env.DEEPCURRENT_DB_PATH || ".data/deep-current.sqlite", { readOnly: true });
try {
  const now = Date.now(), since = now - Math.round(hours * 3600000);
  db.exec("BEGIN");
  const status = name => { const row = db.prepare("SELECT payload,updated_at FROM collector_status WHERE name=?").get(name); return row ? { value: JSON.parse(row.payload), updatedAt: row.updated_at } : null; };
  const targets = status("targets"), collector = status("collector"), catalog = status("catalog");
  const run = db.prepare("SELECT MIN(time) time FROM collector_health WHERE kind='start' AND run_id=(SELECT run_id FROM collector_health ORDER BY id DESC LIMIT 1)").get();
  const cohortFrom = Math.max(since, run.time ?? since);
  // Leave 30 seconds for confirmation; late/unconfirmed events remain in the denominator.
  const cohortThrough = now - 30000;
  const rows = db.prepare(`SELECT f.wallet,f.coin,f.occurred_at,f.received_at,f.payload,f.conflict,e.confirmed_at
    FROM canonical_fills f LEFT JOIN lifecycle_events e ON e.id=f.id
    WHERE f.occurred_at BETWEEN ? AND ? AND f.mode!='history'
    ORDER BY f.occurred_at DESC LIMIT 100001`).all(cohortFrom, cohortThrough);
  const capped = rows.length > 100000, sample = rows.slice(0, 100000);
  const windows = new Map(), wallets = new Map();
  for (const row of sample) {
    const window = Math.floor(row.occurred_at / 10000);
    if (!windows.has(window)) windows.set(window, new Set());
    windows.get(window).add(row.wallet);
    const previous = wallets.get(row.wallet) ?? { address: row.wallet, fills: 0, authoritative: 0, confirmed: 0, latestAt: 0 };
    previous.fills++; previous.latestAt = Math.max(previous.latestAt, row.occurred_at);
    if (JSON.parse(row.payload).startPosition !== undefined && !row.conflict) previous.authoritative++;
    if (row.confirmed_at !== null) previous.confirmed++;
    wallets.set(row.wallet, previous);
  }
  const windowCounts = [];
  for (let bucket = Math.ceil(cohortFrom / 10000); bucket < Math.floor(cohortThrough / 10000); bucket++) windowCounts.push(windows.get(bucket)?.size ?? 0);
  const confirmations = sample.filter(row => row.confirmed_at !== null).map(row => row.confirmed_at - row.occurred_at);
  const http = db.prepare(`SELECT json_extract(payload,'$.operation') operation, json_extract(payload,'$.code') code,
    COUNT(*) requests,AVG(json_extract(payload,'$.durationMs')) averageMs,MAX(json_extract(payload,'$.durationMs')) maxMs
    FROM collector_health WHERE kind='http' AND time>=? GROUP BY operation,code`).all(since);
  const snapshots = http.filter(row => ["clearinghouseState", "spotClearinghouseState"].includes(row.operation)).reduce((sum, row) => sum + row.requests, 0);
  const floorWeight = http.reduce((sum, row) => sum + row.requests * (["clearinghouseState", "spotClearinghouseState", "allMids", "l2Book", "orderStatus", "exchangeStatus"].includes(row.operation) ? 2 : row.operation === "userRole" ? 60 : 20), 0);
  const report = {
    generatedAt: now, since, requestedHours: hours, runtimeStartedAt: run.time, targets: targets?.value.wallets?.length ?? null,
    collector, catalog: catalog ? { updatedAt: catalog.updatedAt, markets: catalog.value.markets?.length ?? null } : null,
    cohort: { from: cohortFrom, through: cohortThrough, rows: sample.length, capped, uniqueWallets: wallets.size,
      freshFillsPerObservedHour: sample.length / Math.max(1 / 3600000, (cohortThrough - cohortFrom) / 3600000),
      activeWalletsPerTenSeconds: { windows: windowCounts.length, p50: percentile(windowCounts, .5), p95: percentile(windowCounts, .95), max: percentile(windowCounts, 1) },
      receiveP95Ms: percentile(sample.map(row => row.received_at - row.occurred_at), .95),
      confirmed: confirmations.length, unconfirmed: sample.length - confirmations.length, confirmationP50Ms: percentile(confirmations, .5), confirmationP95Ms: percentile(confirmations, .95),
      confirmedWithinTenSeconds: confirmations.filter(value => value >= 0 && value <= 10000).length,
      withinTenSecondsShareIncludingUnconfirmed: sample.length ? confirmations.filter(value => value >= 0 && value <= 10000).length / sample.length : null },
    candidates: [...wallets.values()].sort((a, b) => b.fills - a.fills).slice(0, 50),
    http, budget: { snapshotRequests: snapshots, snapshotFloorWeight: snapshots * 2, totalFloorWeight: floorWeight,
      snapshotFloorWeightShare: floorWeight ? snapshots * 2 / floorWeight : null, floorWeightPerMinute: floorWeight / (hours * 60),
      note: "Lower bound only: diagnostics do not record returned-row weight. Retries are counted; do not infer exact budget compliance from this value." },
    recovery: db.prepare("SELECT COUNT(*) count,MIN(queued_at) oldestQueuedAt,MAX(attempts) maxAttempts FROM recovery_jobs").get(),
    snapshots: db.prepare("SELECT COUNT(*) scopes,COUNT(DISTINCT wallet) wallets,SUM(received_at>=? AND received_at<=? AND last_error IS NULL) freshScopes FROM scope_snapshots").get(now - 30000, now),
    scope: "Read-only persisted observed cohort, not independent exchange completeness, provider speed, or browser latency. Daily extrapolation is not a measured daily quota." };
  db.exec("COMMIT");
  const directory = path.resolve("backups", `source-budget-${now}`);
  mkdirSync(directory, { mode: 0o700 }); writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, ...report }, null, 2));
} finally { db.close(); }
