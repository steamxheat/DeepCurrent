import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decimalEqual, validDecimal } from "../src/lib/position-reducer.ts";

function sameExecution(left, right) {
  if ((left.market ?? left.ticker) !== (right.market ?? right.ticker) || left.side !== right.side || left.createdAt !== right.createdAt) return false;
  return ["price", "size", "fee", "builderFee", "orderRouterFee"].every(key => {
    const optional = key === "builderFee" || key === "orderRouterFee";
    const a = optional ? left[key] ?? "0" : left[key], b = optional ? right[key] ?? "0" : right[key];
    return validDecimal(a) && validDecimal(b) && decimalEqual(a, b);
  });
}
function connectionWindowEnd(connection, current, cutoff) {
  if (Number.isSafeInteger(connection.closed_at)) return connection.closed_at;
  // A previous crashed run with no close checkpoint is not proof of continuous observation.
  return current.status === "observing" && connection.opened_at >= current.startedAt ? cutoff : null;
}
if (process.argv.includes("--self-test")) {
  const fill = { market: "BTC-USD", side: "BUY", createdAt: "2026-10-15T00:00:00Z", price: "100", size: "1", fee: "-0.1" };
  assert.equal(sameExecution(fill, { ...fill, market: undefined, ticker: "BTC-USD", price: "100.0", builderFee: null }), true);
  assert.equal(sameExecution(fill, { ...fill, size: "2" }), false);
  assert.equal(sameExecution(fill, { ...fill, fee: undefined }), false);
  assert.equal(sameExecution(fill, { ...fill, orderRouterFee: "1" }), false);
  assert.equal(connectionWindowEnd({ closed_at: 200, opened_at: 100 }, { status: "complete", startedAt: 300 }, 400), 200);
  assert.equal(connectionWindowEnd({ closed_at: null, opened_at: 100 }, { status: "observing", startedAt: 300 }, 400), null);
  assert.equal(connectionWindowEnd({ closed_at: null, opened_at: 310 }, { status: "observing", startedAt: 300 }, 400), 400);
  console.log("dYdX reconciliation self-checks: 7 passed");
} else {
  const source = path.resolve(process.argv[2]), directory = path.resolve(process.argv[3]); mkdirSync(directory, { recursive: true });
  const probe = new DatabaseSync(path.join(source, "evidence.sqlite"), { readOnly: true });
  const evidence = new DatabaseSync(path.join(directory, "evidence.sqlite"));
  evidence.exec("CREATE TABLE IF NOT EXISTS responses(id INTEGER PRIMARY KEY,url TEXT,received_at INTEGER,http INTEGER,payload TEXT);");
  const current = JSON.parse(readFileSync(path.join(source, "summary.json"), "utf8"));
  const runs = probe.prepare("SELECT value FROM state WHERE key LIKE '%report_%'").all().map(row => JSON.parse(row.value)); runs.push(current);
  const connections = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'").get() ? new Map(probe.prepare("SELECT * FROM connections").all().map(row => [row.id, row])) : new Map();
  const acknowledgements = probe.prepare("SELECT received_at,payload FROM messages WHERE json_extract(payload,'$.type')='subscribed' AND json_extract(payload,'$.channel')='v4_subaccounts'").all().map(row => ({ at: row.received_at, message: JSON.parse(row.payload) }));
  assert.ok(acknowledgements.length, "no_acknowledged_accounts");
  const start = Math.min(...acknowledgements.map(a => a.at)), end = Math.min(Date.now() - 2000, current.status === "observing" ? Date.now() - 2000 : current.updatedAt);
  const accounts = [...new Set(acknowledgements.map(a => a.message.id))];
  const expected = [], perAccount = [], errors = []; let lastRequest = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (const account of accounts) {
      const [address, number] = account.split("/"); assert.ok(/^dydx1[a-z0-9]{38}$/.test(address) && /^\d+$/.test(number), "invalid_account");
      const url = new URL("https://indexer.dydx.trade/v4/fills"); Object.entries({ address, subaccountNumber: number, limit: "1000", createdBeforeOrAt: new Date(end).toISOString() }).forEach(([k, v]) => url.searchParams.set(k, v));
      let payload, receivedAt;
      for (let attempt = 0; attempt < 3; attempt++) {
        await pause(Math.max(0, lastRequest + 1500 - Date.now())); lastRequest = Date.now();
        const response = await fetch(url, { signal: AbortSignal.timeout(25000) }); const body = await response.text(); receivedAt = Date.now();
        evidence.prepare("INSERT INTO responses(url,received_at,http,payload) VALUES(?,?,?,?)").run(String(url), receivedAt, response.status, body);
        if (response.status === 429 && attempt < 2) { await pause(60000); continue; }
        assert.equal(response.status, 200, `HTTP_${response.status}`); payload = JSON.parse(body); break;
      }
      assert.ok(Array.isArray(payload?.fills), "missing_history");
      assert.ok(payload.fills.every(f => f.subaccountNumber === Number(number) && typeof f.id === "string" && f.id && Number.isSafeInteger(Date.parse(f.createdAt)) && Date.parse(f.createdAt) <= end), "wrong_history_scope");
      const earliest = payload.fills.length ? Math.min(...payload.fills.map(f => Date.parse(f.createdAt))) : null;
      assert.ok(payload.fills.length < 1000 || earliest < start, "saturated_reconciliation_window");
      const rows = payload.fills.filter(fill => Date.parse(fill.createdAt) >= start + 2000);
      for (const fill of rows) expected.push({ account, fill, receivedAt });
      perAccount.push({ account, expected: rows.length, sourceRows: payload.fills.length, earliestAvailableAt: earliest });
    }
    const observed = new Map(probe.prepare("SELECT * FROM executions").all().map(row => [`${row.account}:${row.id}`, { ...row, fill: JSON.parse(row.payload) }]));
    const missing = [], conflicts = [], socketDelays = [], seen = new Set();
    for (const row of expected) {
      const key = `${row.account}:${row.fill.id}`; assert.ok(!seen.has(key), "duplicate_history_execution"); seen.add(key);
      const stored = observed.get(key), exchangeAt = Date.parse(row.fill.createdAt);
      if (stored) {
        if (!sameExecution(row.fill, stored.fill)) conflicts.push({ account: row.account, id: row.fill.id });
        socketDelays.push(stored.received_at - exchangeAt); continue;
      }
      const connected = acknowledgements.filter(a => a.message.id === row.account).some(ack => {
        const connection = connections.get(ack.message.connection_id);
        if (connection) {
          const closedAt = connectionWindowEnd(connection, current, end);
          return closedAt !== null && exchangeAt >= ack.at + 2000 && exchangeAt <= closedAt - 2000;
        }
        const run = runs.find(run => run.status !== "observing" && run.startedAt <= ack.at && run.updatedAt >= ack.at);
        return run && exchangeAt >= ack.at + 2000 && exchangeAt <= (run.status === "observing" ? end : run.updatedAt - 2000);
      });
      missing.push({ account: row.account, id: row.fill.id, exchangeAt, auditFirstReceivedAt: row.receivedAt, auditDelayMs: row.receivedAt - exchangeAt,
        category: connected ? "not_seen_during_acknowledged_window" : "disconnected_or_subscription_boundary", recoveredToAuditStore: true });
    }
    const notInRest = [...observed.values()].filter(row => row.exchange_at >= start + 2000 && row.exchange_at <= end && !seen.has(`${row.account}:${row.id}`)).map(row => ({ account: row.account, id: row.id }));
    const report = { status: "complete", startedAt: start, cutoff: end, finishedAt: Date.now(), accounts: perAccount, expectedExecutions: expected.length,
      matchedSocketExecutions: socketDelays.length, maxSocketDelayMs: socketDelays.length ? Math.max(...socketDelays) : null, socketOver5000: socketDelays.filter(n => n > 5000).length, socketNegative: socketDelays.filter(n => n < 0).length,
      missing, conflicts, observedNotInRest: notInRest, errors, fullyAccepted: false, liveProven: false,
      limitations: ["Read-only reconciliation and recovery into a separate audit evidence store, not production collector recovery", "Two-second subscription boundaries are distinguished from unexplained live misses", "Raw receive times are not clock-calibrated or Bybit execution times", "No observed events is not a successful latency test"] };
    writeFileSync(path.join(directory, "report.json.tmp"), JSON.stringify(report, null, 2)); renameSync(path.join(directory, "report.json.tmp"), path.join(directory, "report.json"));
    console.log(JSON.stringify({ ...report, accounts: perAccount.length, missing: missing.length, conflicts: conflicts.length }));
  } catch (error) {
    errors.push(error.message); writeFileSync(path.join(directory, "report.json"), JSON.stringify({ status: "needs_review", start, end, errors, fullyAccepted: false }, null, 2)); process.exitCode = 1;
  } finally { evidence.close(); probe.close(); }
}
