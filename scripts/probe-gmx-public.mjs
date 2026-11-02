import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function executions(payload) {
  assert.ok(Array.isArray(payload.trades) && typeof payload.hasMore === "boolean", "missing_public_history");
  for (const row of payload.trades) assert.ok(typeof row.id === "string" && row.id && typeof row.eventName === "string" && /^0x[0-9a-f]{40}$/i.test(row.account) && Number.isSafeInteger(row.timestamp) && row.timestamp > 0, "invalid_trade_identity_or_time");
  return payload.trades.filter(row => row.eventName === "OrderExecuted" && [2, 3, 4, 5, 6, 7].includes(row.orderType));
}
if (process.argv.includes("--self-test")) {
  const row = { id: "tx:1", account: "0x" + "a".repeat(40), timestamp: 1, eventName: "OrderExecuted", orderType: 2 };
  assert.equal(executions({ trades: [row], hasMore: false }).length, 1);
  assert.equal(executions({ trades: [{ ...row, eventName: "OrderCancelled" }, { ...row, orderType: 0 }], hasMore: false }).length, 0);
  assert.throws(() => executions({ trades: [{ ...row, timestamp: null }], hasMore: false }));
  console.log("GMX probe self-checks: 3 passed");
} else {
  const directory = path.resolve(process.argv[2] ?? `backups/gmx-live-probe-${Date.now()}`); mkdirSync(directory, { recursive: true });
  const durationSeconds = Number(process.argv[3] ?? 60);
  assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 60 && durationSeconds <= 3600, "invalid_probe_duration");
  const db = new DatabaseSync(path.join(directory, "evidence.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS responses(id INTEGER PRIMARY KEY,started_at INTEGER,received_at INTEGER,http INTEGER,payload TEXT); CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,exchange_at INTEGER,received_at INTEGER,payload TEXT);");
  assert.equal(db.prepare("SELECT count(*) n FROM responses").get().n, 0, "use_a_new_probe_directory");
  const startedAt = Date.now(), deadline = startedAt + durationSeconds * 1000, known = new Set(), samples = [], errors = [], gaps = [];
  let running = true, lastRequest = 0, previousPoll = null, requests = 0;
  process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    while (running && Date.now() < deadline) {
      await pause(Math.max(0, lastRequest + 2000 - Date.now())); if (!running || Date.now() >= deadline) break;
      const sentAt = Date.now(); lastRequest = sentAt; requests++;
      const response = await fetch("https://arbitrum.gmxapi.io/v1/trades/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forAllAccounts: true, limit: 100 }), signal: AbortSignal.timeout(20000) });
      const body = await response.text(), receivedAt = Date.now();
      db.prepare("INSERT INTO responses(started_at,received_at,http,payload) VALUES(?,?,?,?)").run(sentAt, receivedAt, response.status, body);
      assert.equal(response.status, 200, `HTTP_${response.status}`);
      const payload = JSON.parse(body), rows = executions(payload);
      if (previousPoll && payload.hasMore && Math.min(...payload.trades.map(row => row.timestamp * 1000)) > previousPoll) gaps.push({ previousPoll, receivedAt, error: "response_window_saturated" });
      for (const row of rows) {
        const seen = known.has(row.id); known.add(row.id);
        // Exclude the initial snapshot and events predating observation, not slow newly observed events.
        if (!previousPoll || seen || row.timestamp * 1000 < startedAt) continue;
        const sample = { id: row.id, account: row.account, exchangeAt: row.timestamp * 1000, receivedAt, delayMs: receivedAt - row.timestamp * 1000 };
        samples.push(sample); db.prepare("INSERT INTO executions VALUES(?,?,?,?)").run(row.id, sample.exchangeAt, receivedAt, JSON.stringify(row));
      }
      previousPoll = sentAt;
    }
  } catch (error) { errors.push(error.message); process.exitCode = 1; }
  finally {
    const report = { status: errors.length ? "needs_review" : running ? "complete" : "stopped", pid: process.pid, durationSeconds, startedAt, finishedAt: Date.now(), requests, samples, errors, gaps,
      maxDelayMs: samples.length ? Math.max(...samples.map(row => row.delayMs)) : null, over5000: samples.filter(row => row.delayMs > 5000).length,
      negativeDelays: samples.filter(row => row.delayMs < 0).length,
      fullyAccepted: 0, liveProven: false, limitations: ["REST route qualification, not a selected trader cohort or full-history audit", "Polling, source publication lag and second-resolution timestamps are included", "No samples does not pass latency; HTTP duration is not event latency", "This does not test direct on-chain RPC logs or Bybit execution"] };
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2)); db.close(); console.log(JSON.stringify(report));
  }
}
