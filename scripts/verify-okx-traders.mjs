import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { screenOkxLead, visibleOkxPosition } from "../src/lib/okx-screening.ts";

const directory = path.resolve(process.argv[2] ?? "backups/okx-screen-20261015");
mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(path.join(directory, "screening.sqlite"));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS traders(code TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT); CREATE TABLE IF NOT EXISTS responses(key TEXT PRIMARY KEY,received_at INTEGER NOT NULL,body TEXT NOT NULL);");
const get = key => { const row = db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; };
const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
const previous = get("pid");
if (previous) { let alive = true; try { process.kill(previous, 0); } catch { alive = false; } assert.ok(!alive, `Already running: ${previous}`); }
set("pid", process.pid);
let running = true; let requests = get("requests") ?? 0; let rateLimits = get("rateLimits") ?? 0; let nextRequest = 0;
process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
const log = (event, data = {}) => { const row = { at: Date.now(), event, ...data }; appendFileSync(path.join(directory, "actions.jsonl"), JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function save(status = "running") {
  const counts = Object.fromEntries(db.prepare("SELECT status,COUNT(*) n FROM traders GROUP BY status").all().map(row => [row.status, row.n]));
  const results = db.prepare("SELECT code,payload,result,status FROM traders WHERE status!='pending'").all().map(row => ({ code: row.code, trader: JSON.parse(row.payload), status: row.status, evidence: JSON.parse(row.result) }));
  const summary = { status, pid: process.pid, updatedAt: Date.now(), requests, rateLimits, counts, total: db.prepare("SELECT COUNT(*) n FROM traders").get().n,
    reportedCriteriaCandidates: results.filter(row => row.evidence?.reportedCriteriaPass).length, fullyVerified: 0,
    scope: "OKX public lead strategies only", criteria: { averageDailyNotional: 300000, volume30d: 9000000, minClosedPositions60d: 20, netWinRate: 60, positivePnl30d: true },
    unverified: ["Full account/subaccount history", "Per-position net fee/funding basis", "Unique trade transactions", "Live <=3s", "500 users/100 copying accounts"] };
  for (const [file, data] of [["summary.json", summary], ["report.json", { ...summary, traders: results }]]) {
    writeFileSync(path.join(directory, file + ".tmp"), JSON.stringify(data, null, 2)); renameSync(path.join(directory, file + ".tmp"), path.join(directory, file));
  }
}
async function request(route, parameters = {}, tag = "") {
  const url = new URL(`https://www.okx.com/api/v5/${route}`);
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const key = url.toString() + tag; const cached = db.prepare("SELECT body FROM responses WHERE key=?").get(key);
  if (cached) return JSON.parse(cached.body);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.ok(running, "stopped"); await pause(Math.max(0, nextRequest - Date.now())); assert.ok(running, "stopped");
    nextRequest = Date.now() + 650; requests++; set("requests", requests);
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const body = await response.text(); let payload;
    try { payload = JSON.parse(body); } catch { throw new Error(`non_json_HTTP_${response.status}`); }
    if (response.status === 429 || payload.code === "50011") {
      rateLimits++; set("rateLimits", rateLimits); log("rate_limit", { route }); save();
      for (let i = 0; i < 60 && running; i++) await pause(1000);
      continue;
    }
    assert.equal(response.status, 200, `HTTP_${response.status}`); assert.equal(payload.code, "0", `API_${payload.code}: ${payload.msg}`); assert.ok(Array.isArray(payload.data), "invalid_data");
    db.prepare("INSERT INTO responses VALUES(?,?,?)").run(key, Date.now(), body); log("request", { route, rows: payload.data.length }); save(); return payload;
  }
  throw new Error("persistent_rate_limit");
}
async function positions(code, history, tag = "") {
  const rows = []; let after;
  for (let page = 0; page < 100 && running; page++) {
    const data = (await request(`copytrading/public-${history ? "subpositions-history" : "current-subpositions"}`, { instType: "SWAP", uniqueCode: code, limit: 100, after }, tag)).data;
    rows.push(...data);
    if (!history && data.some(row => !visibleOkxPosition(row))) return rows;
    if (data.length < 100) return rows;
    const cursor = data.at(-1)?.subPosId; assert.ok(typeof cursor === "string" && cursor !== after, "stuck_position_cursor"); after = cursor;
  }
  throw new Error(running ? "position_history_page_cap" : "stopped");
}
try {
  log("start", { pid: process.pid, directory }); save();
  if (!get("discovered")) {
    let page = get("page") ?? 1; let version = get("version");
    while (running) {
      const result = (await request("copytrading/public-lead-traders", { instType: "SWAP", sortType: "pnl", page, limit: 20, dataVer: version })).data[0];
      assert.ok(result && Array.isArray(result.ranks) && Number.isSafeInteger(Number(result.totalPage)), "invalid_leaderboard");
      if (version) assert.equal(result.dataVer, version, "leaderboard_version_changed"); else { version = result.dataVer; set("version", version); }
      for (const trader of result.ranks) {
        assert.ok(/^[A-Za-z0-9]{16,18}$/.test(trader.uniqueCode), "invalid_trader_code");
        db.prepare("INSERT OR IGNORE INTO traders(code,payload) VALUES(?,?)").run(trader.uniqueCode, JSON.stringify(trader));
      }
      page++; set("page", page); save();
      if (page > Number(result.totalPage) || !result.ranks.length) { set("discovered", true); break; }
    }
  }
  const metadata = await request("public/instruments", { instType: "SWAP" });
  const instruments = new Map(metadata.data.map(row => [row.instId, row]));
  while (running) {
    const trader = db.prepare("SELECT * FROM traders WHERE status='pending' ORDER BY CAST(json_extract(payload,'$.pnl') AS REAL) DESC LIMIT 1").get();
    if (!trader) break;
    let result;
    try {
      const current = await positions(trader.code, false);
      if (current.some(row => !visibleOkxPosition(row))) result = { status: "needs_review", reason: "hidden_current_positions", observedRows: current.length, checkedAt: Date.now() };
      else {
        const history = await positions(trader.code, true);
        const pnl = (await request("copytrading/public-pnl", { instType: "SWAP", uniqueCode: trader.code, lastDays: 3 })).data;
        const fresh = await positions(trader.code, false, ":final");
        const fingerprint = rows => JSON.stringify(rows.map(row => [row.subPosId, row.instId, row.posSide, row.openTime, row.subPos, row.openAvgPx]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
        assert.equal(fingerprint(fresh), fingerprint(current), "positions_changed_during_scan");
        result = screenOkxLead(history, fresh, pnl, instruments, Date.now());
      }
    } catch (error) {
      if (!running) break;
      result = { status: "needs_review", error: error.message, checkedAt: Date.now() };
      if (/HTTP_403|HTTP_401|persistent_rate_limit|non_json/.test(error.message)) throw error;
    }
    db.prepare("UPDATE traders SET status=?,result=? WHERE code=?").run(result.status, JSON.stringify(result), trader.code);
    log("trader_checked", { code: trader.code, reason: result.reason ?? result.error ?? result.failures, reportedCriteriaPass: result.reportedCriteriaPass ?? false }); save();
  }
  save(running ? "source_exhausted" : "stopped"); log("finish");
} catch (error) { log(running ? "fatal" : "stop", { error: error.message }); save(running ? "blocked" : "stopped"); process.exitCode = running ? 1 : 0; }
finally { set("pid", null); db.close(); }
