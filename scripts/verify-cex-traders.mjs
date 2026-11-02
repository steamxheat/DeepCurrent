import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { binanceHistoryStats, cexRetryable, cexVisible, finiteCexNumber, stableTradeNotional30d } from "../src/lib/cex-screening.ts";

const exchange = process.argv[2]; assert.ok(["binance", "htx"].includes(exchange), "Usage: verify-cex-traders.mjs binance|htx [directory]");
const directory = path.resolve(process.argv[3] ?? `backups/${exchange}-screen-20261015`);
mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(path.join(directory, "screening.sqlite"));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS traders(id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS responses(key TEXT PRIMARY KEY,received_at INTEGER NOT NULL,body TEXT NOT NULL);");
const get = key => { const row = db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; };
const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
assert.ok(!get("exchange") || get("exchange") === exchange, "wrong_exchange_directory"); set("exchange", exchange);
const previous = get("pid");
if (previous) { let alive = true; try { process.kill(previous, 0); } catch { alive = false; } assert.ok(!alive, `Already running ${previous}`); }
set("pid", process.pid); let running = true; let nextRequest = 0; let requests = get("requests") ?? 0; let rateLimits = get("rateLimits") ?? 0;
process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, details = {}) => { const row = { at: Date.now(), event, ...details }; appendFileSync(path.join(directory, "actions.jsonl"), JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };
function save(status = "running") {
  const rows = db.prepare("SELECT * FROM traders").all();
  const reviewed = rows.filter(row => row.result).map(row => ({ id: row.id, trader: JSON.parse(row.payload), result: JSON.parse(row.result) }));
  const summary = { exchange, status, pid: process.pid, updatedAt: Date.now(), total: rows.length, reviewed: reviewed.length, pending: rows.length - reviewed.length,
    reportedCriteriaCandidates: reviewed.filter(row => row.result.reportedCriteriaPass).length, fullyVerified: 0, requests, rateLimits,
    criteria: { volume30d: 9000000, averageDailyVolume: 300000, minClosedPositions60d: 20, minNetWinRate: 60, positivePnl30d: true },
    limitation: "Public lead strategy only; fees, all accounts, unique fills and <=3s live not fully established" };
  for (const [file, value] of [["summary.json", summary], ["report.json", { ...summary, traders: reviewed }]]) {
    writeFileSync(path.join(directory, file + ".tmp"), JSON.stringify(value, null, 2)); renameSync(path.join(directory, file + ".tmp"), path.join(directory, file));
  }
}
async function request(route, parameters = {}, body, fresh = false) {
  const prefix = exchange === "binance" ? "https://www.binance.com/bapi/futures/v1/" : "https://www.htx.com/-/x/hbg/v1/futures/copytrading/";
  const url = new URL(prefix + route);
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const key = url.toString() + (body ? JSON.stringify(body) : "") + (fresh ? ":fresh" : "");
  const cached = db.prepare("SELECT body FROM responses WHERE key=?").get(key); if (cached) return JSON.parse(cached.body).data;
  for (let attempt = 0; attempt < 3 && running; attempt++) {
    await pause(Math.max(0, nextRequest - Date.now())); assert.ok(running, "stopped"); nextRequest = Date.now() + 1300;
    requests++; set("requests", requests);
    const response = await fetch(url, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (response.status === 429) { rateLimits++; set("rateLimits", rateLimits); log("rate_limit", { route }); save(); for (let i = 0; i < 60 && running; i++) await pause(1000); continue; }
    assert.equal(response.status, 200, `HTTP_${response.status}`);
    const text = await response.text(); let payload; try { payload = JSON.parse(text); } catch { throw new Error("non_json_response"); }
    if (cexRetryable(response.status, payload.code)) { rateLimits++; set("rateLimits", rateLimits); log("rate_limit", { route, code: payload.code }); save(); for (let i = 0; i < 60 && running; i++) await pause(1000); continue; }
    assert.ok(payload.success === true && (exchange === "binance" ? payload.code === "000000" : payload.code === 200), `API_${payload.code}: ${payload.message ?? ""}`);
    assert.ok(payload.data !== undefined && payload.data !== null, "missing_data");
    db.prepare("INSERT INTO responses VALUES(?,?,?)").run(key, Date.now(), text); log("request", { route }); save(); return payload.data;
  }
  throw new Error(running ? "persistent_rate_limit" : "stopped");
}
async function discover() {
  let page = get("page") ?? 1; let indexValue = get("indexValue");
  while (running) {
    const data = exchange === "binance" ? await request("friendly/future/copy-trade/home-page/query-list", {}, {
      dataType: "PNL", favoriteOnly: false, hideFull: false, order: "DESC", pageNumber: page, pageSize: 20,
      portfolioType: "ALL", timeRange: "30D", useAiRecommended: false, userAsset: 0, nickname: "", ...(indexValue ? { indexValue } : {})
    }) : await request("new-rank", { rankType: 2, pageNo: page, pageSize: 12, timeDimension: 1 });
    const list = exchange === "binance" ? data.list : data.itemList; assert.ok(Array.isArray(list), "invalid_leaderboard");
    const total = finiteCexNumber(data.total); assert.ok(Number.isSafeInteger(total) && total >= 0, "invalid_total");
    if (data.indexValue) { indexValue = data.indexValue; set("indexValue", indexValue); }
    let reachedNonpositive = false;
    for (const trader of list) {
      const id = exchange === "binance" ? trader.leadPortfolioId : trader.userSign; assert.ok(typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id), "invalid_trader_id");
      const pnl = finiteCexNumber(exchange === "binance" ? trader.pnl : trader.profit);
      if (pnl <= 0) { reachedNonpositive = true; continue; }
      db.prepare("INSERT OR IGNORE INTO traders(id,payload) VALUES(?,?)").run(id, JSON.stringify(trader));
    }
    page++; set("page", page); save();
    if (!list.length || reachedNonpositive || (page - 1) * (exchange === "binance" ? 20 : 12) >= total) { set("discovered", true); return; }
  }
}
async function binancePages(id, endpoint) {
  const rows = []; let indexValue; let previous;
  for (let page = 1; page <= 100 && running; page++) {
    const data = await request(`friendly/future/copy-trade/lead-portfolio/${endpoint}`, {}, { portfolioId: id, pageNumber: page, pageSize: 50, ...(indexValue ? { indexValue } : {}) });
    assert.ok(Array.isArray(data.list), "invalid_history_list");
    const fingerprint = JSON.stringify(data.list); assert.ok(!data.list.length || fingerprint !== previous, "repeated_page"); previous = fingerprint;
    rows.push(...data.list); indexValue = data.indexValue;
    if (data.list.length < 50 || rows.length >= finiteCexNumber(data.total)) return rows;
  }
  throw new Error(running ? "history_page_cap" : "stopped");
}
async function check(id, trader) {
  const checkedAt = Date.now();
  if (exchange === "htx") {
    const current = await request("trader-info/current-positions", { userSign: id });
    if (!cexVisible("htx", current.isHide)) return { status: "needs_review", reason: "hidden_current_positions", checkedAt };
    const first = await request("trader-info/history-positions", { userSign: id, pageNo: 1, pageSize: 10 });
    if (!cexVisible("htx", first.isHide)) return { status: "needs_review", reason: "hidden_history", checkedAt };
    const rows = [...first.positions]; const total = finiteCexNumber(first.total);
    for (let page = 2; rows.length < total && page <= 100 && running; page++) {
      const data = await request("trader-info/history-positions", { userSign: id, pageNo: page, pageSize: 10 });
      assert.ok(cexVisible("htx", data.isHide) && Array.isArray(data.positions) && data.positions.length, "hidden_or_incomplete_history"); rows.push(...data.positions);
    }
    assert.equal(rows.length, total, "history_page_cap_or_changed");
    return { status: "needs_review", historyRecords: rows.length, currentPositionRecords: current.positions?.length,
      rankPnl30d: trader.profit, rankWinRate30d: trader.winRate, checkedAt,
      unverified: ["Contract multipliers and lifecycle/fees not reconciled", "60d history and all accounts not proven", "No exact volume or net-winrate acceptance"] };
  }
  const detail = await request("friendly/future/copy-trade/lead-portfolio/detail", { portfolioId: id });
  if (!cexVisible("binance", detail.positionShow)) return { status: "needs_review", reason: "hidden_current_positions", checkedAt };
  const perf = await request("public/future/copy-trade/lead-portfolio/performance", { portfolioId: id, timeRange: "30D" });
  if (finiteCexNumber(perf.pnl) <= 0) return { status: "rejected", reason: "nonpositive_30d_pnl", pnl30d: perf.pnl, checkedAt };
  const history = await binancePages(id, "position-history"); const stats = binanceHistoryStats(history, Date.now());
  if (stats.observedClosedCycles60d < 20 || stats.reportedWinRate60d < 60) return { ...stats, status: "needs_review", reason: "public_history_below_minimum_or_incomplete", pnl30d: perf.pnl, checkedAt };
  const trades = await binancePages(id, "trade-history"); const volume = stableTradeNotional30d(trades, Date.now());
  const current = await request("friendly/future/copy-trade/lead-data/positions", { portfolioId: id }, undefined, true);
  const freshDetail = await request("friendly/future/copy-trade/lead-portfolio/detail", { portfolioId: id }, undefined, true);
  assert.ok(cexVisible("binance", freshDetail.positionShow) && Array.isArray(current), "position_visibility_changed");
  return { ...stats, ...volume, status: "needs_review", reportedCriteriaPass: volume.observedNotional30d >= 9000000,
    pnl30d: perf.pnl, currentPositionRecords: current.length, checkedAt: Date.now(),
    unverified: ["Net fee/funding basis per full lifecycle", "Current opening/size reconciliation", "All accounts/subaccounts", "Unique execution IDs and full history", "Live delay<=3s and copy execution"] };
}
try {
  log("start", { exchange, pid: process.pid }); save(); if (!get("discovered")) await discover();
  while (running) {
    const row = db.prepare("SELECT * FROM traders WHERE result IS NULL ORDER BY rowid LIMIT 1").get(); if (!row) break;
    let result;
    try { result = await check(row.id, JSON.parse(row.payload)); }
    catch (error) { if (!running) break; if (/HTTP_(401|403|451)|non_json|persistent_rate_limit/.test(error.message)) throw error; result = { status: "needs_review", error: error.message, checkedAt: Date.now() }; }
    db.prepare("UPDATE traders SET result=? WHERE id=?").run(JSON.stringify(result), row.id); log("trader_checked", { id: row.id, reason: result.reason ?? result.error, reportedCriteriaPass: result.reportedCriteriaPass ?? false }); save();
  }
  save(running ? "cohort_complete" : "stopped"); log("finish");
} catch (error) { log(running ? "fatal" : "stop", { error: error.message }); save(running ? "blocked" : "stopped"); process.exitCode = running ? 1 : 0; }
finally { set("pid", null); db.close(); }
