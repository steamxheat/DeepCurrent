import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectorHealthReport } from "../src/lib/collector-health.ts";

const directory = mkdtempSync(path.join(tmpdir(), "dc-collector-restart-")), filename = path.join(directory, "collector.sqlite");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now(); let child;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
}
process.on("SIGINT", () => { void stop().then(() => process.exit(130)); });
try {
  const rounds = [];
  for (let round = 1; round <= 2; round++) {
    child = spawn(process.execPath, ["--experimental-strip-types", "scripts/collector.mjs"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env,
      DEEPCURRENT_DB_PATH: filename, TRACKED_WALLETS: "10", DC_JOURNAL_MODE: "shadow", TELEGRAM_BOT_TOKEN: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" } });
    let stderrLines = 0;
    child.stderr.on("data", (chunk) => { const text = String(chunk); if (!text.includes("ExperimentalWarning") && !text.includes("trace-warnings") && stderrLines++ < 5) process.stderr.write(text.slice(0, 1000)); });
    const deadline = Date.now() + 90000; let connected = false;
    while (Date.now() < deadline) {
      assert.ok(child.exitCode === null && child.signalCode === null, "Collector exited before connecting");
      try {
        const db = new DatabaseSync(filename, { readOnly: true });
        try { const row = db.prepare("SELECT payload FROM collector_status WHERE name='collector'").get(); connected = Boolean(row && JSON.parse(row.payload).connected); } finally { db.close(); }
      } catch { /* startup schema/catalog can still be pending */ }
      if (connected) break; await sleep(500);
    }
    assert.ok(connected, "Real collector did not connect within 90 seconds");
    const subscriptionDeadline = Date.now() + 30000;
    while (Date.now() < subscriptionDeadline) {
      const check = new DatabaseSync(filename, { readOnly: true });
      const status = JSON.parse(check.prepare("SELECT payload FROM collector_status WHERE name='collector'").get().payload); check.close();
      if (status.subscriptionLimited || status.acknowledgedMarkets === status.marketCount && status.exactUsers === 10) break;
      await sleep(500);
    }
    await sleep(3000);
    const liveDb = new DatabaseSync(filename, { readOnly: true });
    const status = JSON.parse(liveDb.prepare("SELECT payload FROM collector_status WHERE name='collector'").get().payload); liveDb.close();
    await stop();
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_outbox").get().n, 0, "Shadow must never enqueue external notifications");
      const fills = Number(db.prepare("SELECT COUNT(*) n FROM canonical_fills").get().n);
      if (rounds.length) assert.ok(fills >= rounds[0].fills, "Restart must preserve fills");
      const health = collectorHealthReport(db, started);
      rounds.push({ round, fills, connected, acknowledgedMarkets: status.acknowledgedMarkets, requestedMarkets: status.marketCount, exactUsers: status.exactUsers,
        subscriptionLimited: status.subscriptionLimited ?? false,
        health: { counts: health.counts, max: health.max, latency: health.latency, dataState: health.dataState,
          errors: health.events.filter((event) => event.error).slice(0, 10).map((event) => ({ ...event, error: event.error.split("\n")[0] })) } });
    } finally { db.close(); }
  }
  assert.equal(Number(rounds[1].health.counts.find((row) => row.kind === "start").count), 2);
  assert.equal(Number(rounds[1].health.counts.find((row) => row.kind === "connect").count), 2);
  console.log(JSON.stringify({ directory, rounds, realApi: true, productionChanged: false, externalNotificationsSent: false,
    limitation: "Two short real shadow runs with 10 wallets and one controlled process restart; not a 24–72 hour soak, abrupt power failure or all 1000 wallets." }, null, 2));
} finally { await stop(); }
