import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { publicSourceData, publicTiming, publicTraderPage } from "../src/lib/public-exchange-screening.ts";

const exchange = process.argv[2];
assert.ok(["gate", "bitget", "bingx"].includes(exchange), "Usage: verify-public-exchanges.mjs gate|bitget|bingx [directory]");
const directory = path.resolve(process.argv[3] ?? `backups/${exchange}-screen-20261015`); mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(path.join(directory, "screening.sqlite"));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS traders(id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS responses(key TEXT PRIMARY KEY,received_at INTEGER NOT NULL,body TEXT NOT NULL,timing TEXT NOT NULL);");
const get = key => { const r = db.prepare("SELECT value FROM state WHERE key=?").get(key); return r ? JSON.parse(r.value) : null; };
const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
assert.ok(!get("exchange") || get("exchange") === exchange, "wrong_exchange_directory");
const previous = get("pid"); if (previous) { let alive = true; try { process.kill(previous, 0); } catch { alive = false; } assert.ok(!alive, `Already running ${previous}`); }
set("exchange", exchange); set("pid", process.pid);
let running = true; let nextRequest = 0; let requests = get("requests") ?? 0;
process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, data = {}) => { const row = { at: Date.now(), event, ...data }; appendFileSync(path.join(directory, "actions.jsonl"), JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };
const unverified = ["Full 60d position lifecycles and net fees/funding", "Unique fills and >=9m USD actual 30d volume", "All accounts/subaccounts", "Current opening/size continuity", "Live event latency<=3s; no public per-user stream established"];
function save(status, error = null) {
  const traders = db.prepare("SELECT * FROM traders").all().map(r => ({ id: r.id, trader: JSON.parse(r.payload), result: r.result ? JSON.parse(r.result) : null }));
  const summary = { exchange, status, pid: process.pid, updatedAt: Date.now(), requests, total: traders.length,
    reviewed: traders.filter(r => r.result).length, fullyVerified: 0, liveProven: false, stage: "public_discovery_and_evidence", error, unverified };
  for (const [file, value] of [["summary.json", summary], ["report.json", { ...summary, traders }]]) {
    writeFileSync(path.join(directory, file + ".tmp"), JSON.stringify(value, null, 2)); renameSync(path.join(directory, file + ".tmp"), path.join(directory, file));
  }
}
async function request(url, body, cache = true) {
  const key = url + (body ? JSON.stringify(body) : "");
  const old = db.prepare("SELECT body,timing FROM responses WHERE key=?").get(key);
  if (cache && old) { const payload = JSON.parse(old.body); return { payload, data: publicSourceData(exchange, payload), timing: JSON.parse(old.timing) }; }
  for (let attempt = 0; attempt < 3 && running; attempt++) {
    await pause(Math.max(0, nextRequest - Date.now())); assert.ok(running, "stopped");
    const startedAt = Date.now(); nextRequest = startedAt + 1500; requests++; set("requests", requests);
    const response = await fetch(url, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const text = await response.text(); const receivedAt = Date.now();
    if (response.status === 429) { log("rate_limit", { url }); save("running"); for (let n = 0; n < 60 && running; n++) await pause(1000); continue; }
    assert.equal(response.status, 200, `HTTP_${response.status}`);
    let payload; try { payload = JSON.parse(text); } catch { throw Error("non_json_response"); }
    const timing = publicTiming(payload, startedAt, receivedAt);
    // Preserve unsuccessful responses too: missing access must not look like an empty ranking.
    db.prepare("INSERT OR REPLACE INTO responses VALUES(?,?,?,?)").run(key, receivedAt, text, JSON.stringify(timing));
    const data = publicSourceData(exchange, payload); log("request", { url, ...timing }); save("running"); return { payload, data, timing };
  }
  throw Error(running ? "persistent_rate_limit" : "stopped");
}
const gateUrl = (route, params) => "https://www.gate.com" + route + "?" + new URLSearchParams(params);
async function discover() {
  let page = get("page") ?? 1;
  while (running) {
    const response = exchange === "gate"
      ? await request(gateUrl("/apiw/v2/copy/leader/list", { cycle: "month", order_by: "profit", sort_by: "desc", page, page_size: 20, status: "running" }))
      : exchange === "bitget"
        ? await request("https://www.bitget.com/v1/trigger/public/uta/traderView", { pageNo: page, pageSize: 20 })
        : await request("https://api-app.qq-os.com/copy-trade-facade/v1/trader/search?" + new URLSearchParams({ pageId: page - 1, pageSize: 20, sort: "pnl", order: "desc" }), { filterDays: 30, conditions: [], nickName: "" });
    const data = publicTraderPage(exchange, response.data, page);
    const fingerprint = JSON.stringify(data.ids); assert.ok(!data.more || fingerprint !== get("lastPageIds"), "repeated_page");
    db.exec("BEGIN IMMEDIATE");
    try {
      data.rows.forEach((row, i) => db.prepare("INSERT OR IGNORE INTO traders VALUES(?,?,NULL)").run(data.ids[i], JSON.stringify({ ...row, discoveryTiming: response.timing })));
      set("page", page + 1); set("lastPageIds", fingerprint); if (!data.more) set("discovered", true); db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    log("discovered", { page, rows: data.rows.length }); save("running");
    if (!data.more) return; page++;
  }
}
async function gateEvidence(id, trader) {
  const detail = await request(`https://www.gate.com/api/copytrade/copy_trading/trader/detail/${id}`);
  const config = detail.data.config; assert.ok(config && typeof config === "object", "missing_config");
  if (config.is_hide !== 0 || trader.is_private_leader === true) return { status: "needs_review", reason: "hidden_or_private_strategy", checkedAt: Date.now(), unverified };
  const positions = await request(gateUrl("/apiw/v2/copy/leader/position", { leader_id: id, page: 1, page_size: 20 }));
  assert.ok(Array.isArray(positions.data), "invalid_positions");
  const history = [];
  for (let page = 1; page <= 100 && running; page++) {
    const response = await request(gateUrl("/apiw/v2/copy/leader/close_position", { leader_id: id, page, page_size: 20 }));
    assert.ok(Array.isArray(response.data), "invalid_position_history");
    const fingerprint = JSON.stringify(response.data); assert.ok(!response.data.length || fingerprint !== history.at(-1), "repeated_history_page"); history.push(fingerprint);
    const { pagecount } = response.payload; assert.ok(Number.isSafeInteger(pagecount) && pagecount >= 0, "missing_history_pagecount");
    if (page >= pagecount) return { status: "needs_review", checkedAt: Date.now(), historyRecords: history.reduce((sum, value) => sum + JSON.parse(value).length, 0), currentPositionRecords: positions.data.length,
      currentTiming: positions.timing, historyPages: page, historyScope: "Public website history, 60d completeness not proven", unverified };
  }
  throw Error(running ? "history_page_cap" : "stopped");
}
try {
  log("start", { pid: process.pid, exchange }); save("running"); if (!get("discovered")) await discover();
  while (running) {
    const row = db.prepare("SELECT * FROM traders WHERE result IS NULL ORDER BY rowid LIMIT 1").get(); if (!row) break;
    let result;
    try { result = exchange === "gate" ? await gateEvidence(row.id, JSON.parse(row.payload)) : { status: "needs_review", checkedAt: Date.now(), reason: "ranking_only_current_history_stream_not_established", unverified }; }
    catch (error) { if (!running) break; if (/HTTP_|Illegal Request|persistent_rate_limit|non_json/.test(error.message)) throw error; result = { status: "needs_review", checkedAt: Date.now(), error: error.message, unverified }; }
    db.prepare("UPDATE traders SET result=? WHERE id=?").run(JSON.stringify(result), row.id); log("trader_checked", { id: row.id, reason: result.reason ?? result.error }); save("running");
  }
  save(running ? "discovery_complete_needs_review" : "stopped"); log("finish");
} catch (error) { save(running ? "blocked" : "stopped", error.message); log(running ? "blocked" : "stop", { error: error.message }); process.exitCode = running ? 1 : 0; }
finally { set("pid", null); db.close(); }
