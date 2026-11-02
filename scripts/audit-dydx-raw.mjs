import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { replayDydxRawFills } from "../src/lib/dydx-raw-audit.ts";
import { decimalAdd, decimalSign, validDecimal } from "../src/lib/position-reducer.ts";
import { copySelectionCriteria, copyQualityDecision } from "../src/lib/copy-selection.ts";

const directory = path.resolve(process.argv[2]); const address = process.argv[3];
assert.ok(/^dydx1[a-z0-9]{38}$/.test(address), "invalid_address"); mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(path.join(directory, "evidence.sqlite"));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS responses(url TEXT PRIMARY KEY,received_at INTEGER,http INTEGER,payload TEXT);");
const get = key => { const row = db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; };
const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
const prior = get("pid"); if (prior) { let alive = true; try { process.kill(prior, 0); } catch { alive = false; } assert.ok(!alive, `already_running_${prior}`); }
assert.ok(!get("address") || get("address") === address, "wrong_audit_directory"); set("address", address); set("pid", process.pid);
let running = true, requests = get("requests") ?? 0, lastRequest = 0;
process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, details = {}) => { const row = { at: Date.now(), event, ...details }; appendFileSync(path.join(directory, "actions.jsonl"), JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };
function save(status, data = {}) {
  const report = { status, address, pid: process.pid, updatedAt: Date.now(), requests, criteria: copySelectionCriteria, fullyAccepted: false, ...data };
  writeFileSync(path.join(directory, "report.json.tmp"), JSON.stringify(report, null, 2)); renameSync(path.join(directory, "report.json.tmp"), path.join(directory, "report.json"));
}
async function request(url) {
  const cached = db.prepare("SELECT http,payload FROM responses WHERE url=?").get(url); if (cached?.http === 200) return JSON.parse(cached.payload);
  for (let attempt = 0; attempt < 3 && running; attempt++) {
    await pause(Math.max(0, lastRequest + 1500 - Date.now())); assert.ok(running, "stopped"); lastRequest = Date.now(); requests++; set("requests", requests);
    let response, body;
    try { response = await fetch(url, { signal: AbortSignal.timeout(25000) }); body = await response.text(); }
    catch (error) { log("transport_retry", { attempt, error: error.message }); if (attempt === 2) throw error; await pause(2000); continue; }
    db.prepare("INSERT INTO responses VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET received_at=excluded.received_at,http=excluded.http,payload=excluded.payload").run(url, Date.now(), response.status, body);
    if (response.status === 429) { log("rate_limit"); save("rate_limit_backoff"); for (let n = 0; n < 60 && running; n++) await pause(1000); continue; }
    assert.equal(response.status, 200, `HTTP_${response.status}`); const result = JSON.parse(body); assert.ok(!result.errors, "api_errors"); save("running", { currentUrl: url }); return result;
  }
  throw Error(running ? "persistent_rate_limit" : "stopped");
}
const info = (route, params) => {
  const url = new URL("https://indexer.dydx.trade/v4/" + route); Object.entries(params ?? {}).forEach(([key, value]) => { if (value !== null && value !== undefined) url.searchParams.set(key, String(value)); }); return request(String(url));
};
async function anchoredFills(subaccountNumber, height) {
  const fills = []; let total = null;
  for (let page = 1; running; page++) {
    const result = await info("fills", { address, subaccountNumber, limit: 1000, page, createdBeforeOrAtHeight: height });
    assert.ok(Array.isArray(result.fills) && Number.isSafeInteger(result.totalResults) && result.totalResults >= 0 && result.offset === (page - 1) * 1000, "invalid_raw_pagination");
    assert.ok(result.totalResults <= 26000, "public_raw_offset_limit");
    assert.ok(total === null || total === result.totalResults, "anchored_history_changed"); total = result.totalResults;
    assert.ok(result.fills.every(fill => fill.subaccountNumber === subaccountNumber), "wrong_fill_subaccount"); fills.push(...result.fills);
    if (fills.length >= total) { assert.equal(fills.length, total); return fills; }
    assert.equal(result.fills.length, 1000, "incomplete_raw_page");
  }
  throw Error("stopped");
}
async function positions(subaccountNumber, cutoff) {
  const collected = new Map(); let boundary = cutoff;
  for (let page = 0; running && page < 1000; page++) {
    const response = await info("perpetualPositions", { address, subaccountNumber, limit: 1000, createdBeforeOrAtHeight: boundary });
    assert.ok(Array.isArray(response.positions), "missing_positions"); let added = 0;
    for (const position of response.positions) {
      assert.ok(position.subaccountNumber === subaccountNumber && /^\d+$/.test(String(position.createdAtHeight)), "invalid_position");
      const key = JSON.stringify([position.market, position.createdAt, position.side]); if (!collected.has(key)) added++; collected.set(key, position);
    }
    if (response.positions.length < 1000) return [...collected.values()];
    const next = Math.min(...response.positions.map(position => Number(position.createdAtHeight)));
    assert.ok(added && next < boundary, "saturated_position_boundary"); boundary = next;
  }
  throw Error(running ? "position_page_budget" : "stopped");
}
try {
  save("running"); const baseline = get("baseline") ?? await info(`addresses/${address}`);
  assert.ok(Array.isArray(baseline.subaccounts) && baseline.subaccounts.length, "missing_subaccounts"); set("baseline", baseline);
  assert.equal(new Set(baseline.subaccounts.map(a => a.subaccountNumber)).size, baseline.subaccounts.length, "duplicate_subaccounts");
  const results = []; let pnlAll = "0";
  for (const account of baseline.subaccounts) {
    assert.ok(account.address === address && Number.isSafeInteger(account.subaccountNumber) && account.subaccountNumber >= 0, "wrong_subaccount");
    const height = Number(account.latestProcessedBlockHeight); assert.ok(Number.isSafeInteger(height) && height > 0, "missing_baseline_height");
    const block = await request(`https://dydx-dao-api.polkachu.com/cosmos/base/tendermint/v1beta1/blocks/${height}`);
    assert.equal(String(block.block?.header?.height), String(height), "wrong_anchor_block"); const asOf = Date.parse(block.block.header.time); assert.ok(Number.isSafeInteger(asOf), "invalid_block_time");
    const fills = await anchoredFills(account.subaccountNumber, height), allPositions = await positions(account.subaccountNumber, height);
    const result = replayDydxRawFills(fills, allPositions, Object.values(account.openPerpetualPositions ?? {}), height, asOf, true);
    const pnl = await info("pnl", { address, subaccountNumber: account.subaccountNumber, limit: 1, createdBeforeOrAtHeight: height }); const latest = pnl.pnl?.[0];
    assert.ok(latest && validDecimal(latest.totalPnl) && Date.parse(latest.createdAt) <= asOf && asOf - Date.parse(latest.createdAt) < 2 * 3600000, "missing_or_stale_official_pnl");
    pnlAll = decimalAdd(pnlAll, latest.totalPnl); results.push({ subaccountNumber: account.subaccountNumber, officialPnl: latest, ...result });
    log("account_replayed", { subaccountNumber: account.subaccountNumber, executions: fills.length, closed: result.closedPositionsLifetime, winRate: result.winRateLifetime });
  }
  const closed = results.reduce((n, a) => n + a.closedPositionsLifetime, 0), wins = results.reduce((n, a) => n + a.winsLifetime, 0), actions = results.reduce((n, a) => n + a.tradeActions60d, 0);
  const volume = results.reduce((n, a) => decimalAdd(n, a.volume30dUsd), "0");
  const passes = closed > 0 && wins * 100 >= closed * 60 && actions >= 5 && decimalSign(pnlAll) > 0 && decimalSign(decimalAdd(volume, "-300000")) >= 0;
  const quality = copyQualityDecision();
  save(passes ? quality.status : "rejected", { criteriaRevision: copySelectionCriteria.revision, basicPassed: passes, quality, officialPnlAll: pnlAll, closedPositionsLifetime: closed, winsLifetime: wins, winRateLifetime: closed ? wins * 100 / closed : null, tradeActions60d: actions, volume30dUsd: volume, sampleWarning: closed < 20 ? "Small lifetime sample" : null, accounts: results,
    limitations: ["Frozen historical anchor, not a continuously fresh wallet", "Independent fill replay, but funding aggregates still sourced from indexer position records", "Nonzero builder/router fees require separate reconciliation and cannot pass", "All-time archive and individual live/reconnect/app/Bybit execution not fully accepted"] });
} catch (error) { log("audit_incomplete", { error: error.message }); save(running ? "needs_review" : "stopped", { error: error.message }); process.exitCode = running ? 1 : 0; }
finally { set("pid", null); db.close(); }
