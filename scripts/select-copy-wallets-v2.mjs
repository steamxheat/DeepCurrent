import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { copySelectionCriteria, lifetimeLighterAccount, lifetimeWalletDecision } from "../src/lib/copy-selection.ts";

const directory = path.resolve(process.argv[2] ?? "backups/copy-selection-v2-20261015"); mkdirSync(directory, { recursive: true });
const old = new DatabaseSync("backups/lighter-screen-IUKF5i/screening.sqlite", { readOnly: true });
const db = new DatabaseSync(path.join(directory, "screening.sqlite"));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS wallets(address TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT,priority REAL NOT NULL); CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY,address TEXT NOT NULL,payload TEXT NOT NULL,cursor TEXT,cached_complete INTEGER NOT NULL DEFAULT 0,old_head TEXT,status TEXT NOT NULL DEFAULT 'pending',result TEXT,last_attempt INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS trades(account INTEGER NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,id)); CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY,url TEXT NOT NULL,received_at INTEGER NOT NULL,payload TEXT NOT NULL);");
const get = key => { const r = db.prepare("SELECT value FROM state WHERE key=?").get(key); return r ? JSON.parse(r.value) : null; };
const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
const prior = get("pid"); if (prior) { let live = true; try { process.kill(prior, 0); } catch { live = false; } assert.ok(!live, `Already running ${prior}`); }
set("pid", process.pid); let running = true; let nextRequest = 0; let requests = get("requests") ?? 0;
process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, data = {}) => { const row = { at: Date.now(), event, ...data }; appendFileSync(path.join(directory, "actions.jsonl"), JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };
function save(status = "running", error = null) {
  const counts = Object.fromEntries(db.prepare("SELECT status,count(*) n FROM wallets GROUP BY status").all().map(r => [r.status, r.n]));
  const historical = db.prepare("SELECT address,result FROM wallets WHERE status='historical_candidate_pending_live'").all().map(r => ({ address: r.address, ...JSON.parse(r.result) }));
  const candidates = historical.filter(r => r.criteriaRevision === copySelectionCriteria.revision);
  const summary = { status, error, pid: process.pid, updatedAt: Date.now(), criteria: copySelectionCriteria, requests, counts,
    historicalCandidates: candidates.length, legacyCandidates: historical.length - candidates.length, countsIncludeLegacyResults: true, fullyAccepted: 0, liveDelayVerified: false,
    exclusions: ["CEX rankings lack proven complete public per-trader streams", "Pacifica all-subaccount enumeration requires owner signature", "Hyperliquid free per-user WS limit10/IP"],
    note: "Historical candidate is not full acceptance; all-time API provenance, funding attribution, actual live/delivery and reconnect remain separate gates" };
  for (const [name, value] of [["summary.json", summary], ["historical-candidates.json", { ...summary, candidates }]]) {
    writeFileSync(path.join(directory, name + ".tmp"), JSON.stringify(value, null, 2)); renameSync(path.join(directory, name + ".tmp"), path.join(directory, name));
  }
}
async function request(route, params) {
  for (let attempt = 0; attempt < 3 && running; attempt++) {
    await pause(Math.max(0, nextRequest - Date.now())); assert.ok(running, "stopped"); nextRequest = Date.now() + 1300;
    const url = new URL("https://mainnet.zklighter.elliot.ai/api/v1/" + route); Object.entries(params).forEach(([k, v]) => { if (v !== null && v !== undefined) url.searchParams.set(k, String(v)); });
    requests++; set("requests", requests);
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if ([429, 405].includes(response.status)) { log("rate_limit", { route, http: response.status }); save(); for (let n = 0; n < 60 && running; n++) await pause(1000); continue; }
    assert.equal(response.status, 200, `HTTP_${response.status}`); const payload = await response.json();
    db.prepare("INSERT INTO evidence(url,received_at,payload) VALUES(?,?,?)").run(url.toString(), Date.now(), JSON.stringify(payload));
    assert.equal(payload.code, 200, `API_${payload.code}`); log("request", { route }); return payload;
  }
  throw Error(running ? "persistent_rate_limit" : "stopped");
}
async function leaderboard(address, window) {
  const response = await request("pnlLeaderboard", { time_window: window, search: address, limit: 5, offset: 0 });
  const row = response.entries?.find(x => x.l1_address?.toLowerCase() === address);
  assert.ok(row && Number.isFinite(row.pnl) && Number.isFinite(row.volume), "missing_official_pnl_or_volume");
  assert.ok(Number.isFinite(response.updated_at) && response.updated_at * 1000 <= Date.now() && Date.now() - response.updated_at * 1000 < 3 * 3600000, "stale_leaderboard");
  return { ...row, sourceUpdatedAt: response.updated_at * 1000, receivedAt: Date.now() };
}
async function initialize(row) {
  const month = await leaderboard(row.address, "30d"); const all = await leaderboard(row.address, "all");
  if (month.volume < 300000 || all.pnl <= 0 || month.pnl < copySelectionCriteria.minimumNetPnl30dUsd) { db.prepare("UPDATE wallets SET status='rejected',result=? WHERE address=?").run(JSON.stringify({ criteriaRevision: copySelectionCriteria.revision, reason: "official_volume_or_pnl_threshold", month, all }), row.address); return; }
  const response = await request("account", { by: "l1_address", value: row.address });
  assert.ok(Array.isArray(response.accounts) && response.accounts.length && !response.next_cursor && (!response.total || response.total <= response.accounts.length), "incomplete_subaccounts");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const a of response.accounts) {
      assert.ok(Number.isSafeInteger(a.index) && a.l1_address.toLowerCase() === row.address && Array.isArray(a.positions), "invalid_subaccount");
      const cached = old.prepare("SELECT * FROM accounts WHERE id=?").get(a.index);
      const complete = cached?.status === "checked" && cached.pages > 0 && cached.cursor === null;
      let oldHead = null;
      if (complete) {
        for (const t of old.prepare("SELECT id,payload FROM trades WHERE account=?").all(a.index)) {
          const data = JSON.parse(t.payload); if (!oldHead || data.timestamp > oldHead.time) oldHead = { id: t.id, time: data.timestamp };
          db.prepare("INSERT OR IGNORE INTO trades VALUES(?,?,?)").run(a.index, t.id, t.payload);
        }
      }
      db.prepare("INSERT OR IGNORE INTO accounts(id,address,payload,cached_complete,old_head) VALUES(?,?,?,?,?)").run(a.index, row.address, JSON.stringify(a), complete && oldHead ? 1 : 0, oldHead?.id ?? null);
    }
    db.prepare("UPDATE wallets SET status='checking',result=? WHERE address=?").run(JSON.stringify({ month, all }), row.address); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
async function checkAccount(row) {
  db.prepare("UPDATE accounts SET last_attempt=? WHERE id=?").run(Date.now(), row.id);
  const response = await request("trades", { account_index: row.id, sort_by: "timestamp", sort_dir: "desc", market_type: "perp", limit: 100, cursor: row.cursor });
  assert.ok(Array.isArray(response.trades), "missing_trades");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of response.trades) {
      assert.ok(typeof t.trade_id_str === "string" && [t.ask_account_id, t.bid_account_id].includes(row.id), "invalid_trade_identity");
      const prior = db.prepare("SELECT payload FROM trades WHERE account=? AND id=?").get(row.id, t.trade_id_str);
      assert.ok(!prior || prior.payload === JSON.stringify(t), "conflicting_trade");
      db.prepare("INSERT OR IGNORE INTO trades VALUES(?,?,?)").run(row.id, t.trade_id_str, JSON.stringify(t));
    }
    assert.ok(!response.next_cursor || response.next_cursor !== row.cursor, "stuck_cursor");
    db.prepare("UPDATE accounts SET cursor=? WHERE id=?").run(response.next_cursor ?? null, row.id); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const joinedCache = row.cached_complete && response.trades.some(t => t.trade_id_str === row.old_head);
  if (response.next_cursor && !joinedCache) return;
  const fresh = await request("account", { by: "index", value: row.id }); const a = fresh.accounts?.find(a => a.index === row.id);
  assert.ok(a && Array.isArray(a.positions), "missing_current_snapshot");
  const trades = db.prepare("SELECT payload FROM trades WHERE account=?").all(row.id).map(r => JSON.parse(r.payload));
  const result = lifetimeLighterAccount(trades, row.id, a.positions, true, Date.now());
  db.prepare("UPDATE accounts SET status='checked',result=?,payload=? WHERE id=?").run(JSON.stringify({ ...result, checkedAt: Date.now(), snapshot: a }), JSON.stringify(a), row.id);
  log("account_checked", { account: row.id, closedLifetime: result.closedPositionsLifetime, winRate: result.winRateLifetime, positionsVerified: result.positionsVerified });
}
async function finishWallets() {
  for (const w of db.prepare("SELECT * FROM wallets WHERE status='checking'").all()) {
    const rows = db.prepare("SELECT * FROM accounts WHERE address=?").all(w.address); if (rows.some(a => a.status === "pending")) continue;
    const evidence = JSON.parse(w.result); let decision;
    if (rows.some(a => a.status === "needs_review")) decision = { status: "needs_review", reason: "account_error" };
    else decision = lifetimeWalletDecision(rows.map(a => JSON.parse(a.result)), evidence.all.pnl, evidence.month.volume,
      { officialNetPnl30dUsd: String(evidence.month.pnl), maximumDrawdownPct: null, drawdownVerified: false, nonScalpingVerified: null });
    db.prepare("UPDATE wallets SET status=?,result=? WHERE address=?").run(decision.status, JSON.stringify({ ...evidence, ...decision, accounts: rows.map(a => JSON.parse(a.result)), checkedAt: Date.now() }), w.address);
    log("wallet_checked", { address: w.address, ...decision });
  }
}
try {
  log("start", { pid: process.pid, criteria: copySelectionCriteria });
  if (!get("seeded")) {
    const rows = old.prepare("SELECT address,payload,result FROM candidates").all();
    db.exec("BEGIN IMMEDIATE");
    try { for (const r of rows) { const p = JSON.parse(r.payload); const prev = r.result ? JSON.parse(r.result) : null; if (p.volume >= 300000) db.prepare("INSERT OR IGNORE INTO wallets VALUES(?,?,'pending',NULL,?)").run(r.address, r.payload, (prev?.winRate >= 60 ? 1e12 : 0) + Math.min(p.volume, 1e10)); } set("seeded", true); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  save(); let turns = 0;
  while (running) {
    if (db.prepare("SELECT count(*) n FROM wallets WHERE status='historical_candidate_pending_live'").get().n >= copySelectionCriteria.target) break;
    const pending = db.prepare("SELECT * FROM wallets WHERE status='pending' ORDER BY priority DESC LIMIT 1").get();
    const account = db.prepare("SELECT * FROM accounts WHERE status='pending' ORDER BY last_attempt,id LIMIT 1").get();
    if (!pending && !account) break;
    const initializing = pending && (!account || turns++ % 4 === 0);
    try { if (initializing) await initialize(pending); else await checkAccount(account); }
    catch (error) {
      if (!running) break; if (/HTTP_(401|403|451)|persistent_rate_limit/.test(error.message)) throw error;
      if (initializing) db.prepare("UPDATE wallets SET status='needs_review',result=? WHERE address=?").run(JSON.stringify({ error: error.message }), pending.address);
      else db.prepare("UPDATE accounts SET status='needs_review',result=? WHERE id=?").run(JSON.stringify({ error: error.message }), account.id);
      log("needs_review", { address: initializing ? pending.address : account.address, error: error.message });
    }
    await finishWallets(); save();
  }
  save(running ? "historical_stage_complete_pending_live" : "stopped");
} catch (error) { log("fatal", { error: error.message }); save(running ? "blocked" : "stopped", error.message); process.exitCode = running ? 1 : 0; }
finally { set("pid", null); db.close(); old.close(); }
