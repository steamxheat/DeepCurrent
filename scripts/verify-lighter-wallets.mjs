import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { screenLighterAccount, shouldExpandLighterCandidates, summarizeLighterWallet } from "../src/lib/lighter-screening.ts";

const target = 300;
const reviewAll = process.argv.includes("--review-all");
mkdirSync("backups", { recursive: true });
const directory = path.resolve(process.argv[2] ?? mkdtempSync("backups/lighter-screen-"));
mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(path.join(directory, "screening.sqlite"));
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS candidates(address TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT);
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY,address TEXT NOT NULL,payload TEXT NOT NULL,cursor TEXT,pages INTEGER NOT NULL DEFAULT 0,covered INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',result TEXT,last_attempt INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS trades(account INTEGER NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account,id));`);
const get = key => { const row = db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; };
const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
const previousPid = get("pid");
if (previousPid && previousPid !== process.pid) { let alive = true; try { process.kill(previousPid, 0); } catch { alive = false; } assert.ok(!alive, `Screening already running: PID ${previousPid}`); }
set("pid", process.pid);
const asOf = get("asOf") ?? Date.now(); set("asOf", asOf);
let running = true;
let requests = get("requests") ?? 0;
let nextRequest = 0;
let exhausted = get("exhausted") ?? false;
let offset = get("offset") ?? 0;
let rateLimits = get("rateLimits") ?? 0;
let spacingMs = get("spacingMs") ?? 1025;
let nextDiscoveryPage = get("nextDiscoveryPage") ?? 0;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const log = (event, details = {}) => { const row = { at: Date.now(), event, ...details }; appendFileSync(path.join(directory, "actions.jsonl"), `${JSON.stringify(row)}\n`); console.log(JSON.stringify(row)); };
const count = status => Number(db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status=?").get(status).n);
const cohortSize = reviewAll ? get("cohortSize") ?? Number(db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n) : null;
if (reviewAll) { assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n), cohortSize, "cohort_changed"); set("cohortSize", cohortSize); }
function save(status = "running") {
  const summary = { status, pid: process.pid, asOf, updatedAt: Date.now(), target, reviewAll, cohortSize, directory, requests, rateLimits, requestSpacingMs: spacingMs, leaderboardOffset: offset, sourceExhausted: exhausted,
    candidates: Number(db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n), pending: count("pending"), checking: count("checking"), verifiedWalletData: count("verified_wallet_data"), rejected: count("rejected"), needsReview: count("needs_review"),
    accounts: Number(db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n), historyPages: Number(db.prepare("SELECT COALESCE(SUM(pages),0) AS n FROM accounts").get().n),
    fullyAcceptedForAutocopy: 0, unverifiedRequirements: ["Per-wallet realtime monitoring", "Source-to-Bybit execution <=3 seconds", "500 application users and 100 copy accounts"],
    criteria: { activeWithinDays: 60, minimumTransactions: 6, minimumCompletedPositions: 20, minimumWinRate: 60, positivePnlDays: 30 } };
  writeFileSync(path.join(directory, "summary.json.tmp"), JSON.stringify(summary, null, 2)); renameSync(path.join(directory, "summary.json.tmp"), path.join(directory, "summary.json"));
  const verified = db.prepare("SELECT address,payload,result FROM candidates WHERE status='verified_wallet_data'").all().map(row => ({ address: row.address, candidate: JSON.parse(row.payload), verification: JSON.parse(row.result) }));
  writeFileSync(path.join(directory, "verified-wallets.json.tmp"), JSON.stringify({ ...summary, wallets: verified }, null, 2)); renameSync(path.join(directory, "verified-wallets.json.tmp"), path.join(directory, "verified-wallets.json"));
}
async function request(route, parameters) {
  for (let attempt = 0; attempt < 3 && running; attempt++) {
    await sleep(Math.max(0, nextRequest - Date.now())); nextRequest = Date.now() + spacingMs;
    requests++; set("requests", requests);
    const url = new URL(`https://mainnet.zklighter.elliot.ai/api/v1/${route}`);
    for (const [key, value] of Object.entries(parameters)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    const began = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if ([429, 405].includes(response.status)) { rateLimits++; set("rateLimits", rateLimits); spacingMs = 1300; set("spacingMs", spacingMs); log("rate_limit", { route, http: response.status, spacingMs }); save(); await sleep(60000); continue; }
      assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
      const payload = await response.json(); assert.equal(payload.code, 200, `${route}: code ${payload.code}: ${payload.message ?? ""}`);
      log("request", { route, durationMs: Date.now() - began, account: parameters.account_index ?? parameters.value ?? null });
      return payload;
    } catch (error) { log("request_error", { route, attempt, error: error.message }); if (attempt === 2) throw error; await sleep(3000 * (attempt + 1)); }
  }
  throw new Error("screening_stopped_or_rate_limited");
}
async function discover() {
  const page = await request("pnlLeaderboard", { time_window: "30d", sort_by: "pnl", sort_dir: "desc", limit: 100, offset });
  assert.ok(Array.isArray(page.entries));
  appendFileSync(path.join(directory, "leaderboard.jsonl"), `${JSON.stringify({ receivedAt: Date.now(), offset, ...page })}\n`);
  for (const entry of page.entries) {
    assert.ok(/^0x[\da-f]{40}$/i.test(entry.l1_address) && Number.isFinite(entry.pnl), "invalid_leaderboard_entry");
    if (entry.pnl <= 0) { exhausted = true; break; }
    db.prepare("INSERT OR IGNORE INTO candidates(address,payload) VALUES(?,?)").run(entry.l1_address.toLowerCase(), JSON.stringify(entry));
  }
  offset += page.entries.length;
  if (!page.entries.length || offset >= page.total) exhausted = true;
  set("offset", offset); set("exhausted", exhausted); save();
}
async function initialize(row) {
  const payload = await request("account", { by: "l1_address", value: row.address });
  assert.ok(Array.isArray(payload.accounts) && payload.accounts.length > 0, "missing_accounts");
  // A capped address response cannot prove all subaccounts were checked.
  assert.ok(!payload.next_cursor && (!payload.total || payload.accounts.length >= payload.total), "incomplete_subaccounts");
  assert.ok(payload.accounts.every(account => Number.isSafeInteger(account.index) && typeof account.l1_address === "string" && account.l1_address.toLowerCase() === row.address && Array.isArray(account.positions)), "invalid_account_snapshot");
  for (const account of payload.accounts) {
    db.prepare("INSERT OR IGNORE INTO accounts(id,address,payload) VALUES(?,?,?)").run(account.index, row.address, JSON.stringify(account));
  }
  db.prepare("UPDATE candidates SET status='checking' WHERE address=?").run(row.address);
}
async function monthPnl(address) {
  // The 30-day leaderboard is wallet-wide; an hourly chart cannot recover this old boundary.
  const payload = await request("pnlLeaderboard", { time_window: "30d", sort_by: "pnl", sort_dir: "desc", limit: 20, offset: 0, search: address });
  const entry = payload.entries?.find(row => row.l1_address?.toLowerCase() === address);
  assert.ok(entry && Number.isFinite(entry.pnl), "missing_wallet_month_pnl");
  return { pnl: entry.pnl, updatedAt: payload.updated_at, receivedAt: Date.now(), source: "Lighter official wallet-wide 30d P&L", entry };
}
async function checkAccount(row) {
  db.prepare("UPDATE accounts SET last_attempt=? WHERE id=?").run(Date.now(), row.id);
  const page = await request("trades", { account_index: row.id, sort_by: "timestamp", sort_dir: "desc", market_type: "perp", limit: 100, cursor: row.cursor });
  assert.ok(Array.isArray(page.trades), "invalid_history_page");
  for (const trade of page.trades) {
    assert.ok(Number.isSafeInteger(trade.timestamp) && [trade.ask_account_id, trade.bid_account_id].includes(row.id) && typeof trade.trade_id_str === "string", "invalid_history_trade");
    const existing = db.prepare("SELECT payload FROM trades WHERE account=? AND id=?").get(row.id, trade.trade_id_str);
    if (existing) assert.equal(existing.payload, JSON.stringify(trade), "conflicting_trade");
    db.prepare("INSERT OR IGNORE INTO trades VALUES(?,?,?)").run(row.id, trade.trade_id_str, JSON.stringify(trade));
  }
  const complete = !page.next_cursor;
  assert.ok(complete || page.next_cursor !== row.cursor, "stuck_history_cursor");
  const covered = complete || page.trades.some(trade => trade.timestamp <= asOf - 60 * 86400000);
  db.prepare("UPDATE accounts SET cursor=?,pages=pages+1,covered=? WHERE id=?").run(page.next_cursor ?? null, covered ? 1 : row.covered, row.id);
  if (!covered && !row.covered) return;
  const trades = db.prepare("SELECT payload FROM trades WHERE account=?").all(row.id).map(trade => JSON.parse(trade.payload));
  let result = screenLighterAccount(trades, row.id, JSON.parse(row.payload).positions, true, asOf);
  if (!complete && (result.unknownOutcomes || !result.positionsVerified)) return;
  const state = await request("account", { by: "index", value: row.id });
  const current = state.accounts?.find(account => account.index === row.id);
  assert.ok(current && Array.isArray(current.positions), "missing_current_positions");
  result = screenLighterAccount(trades, row.id, current.positions, true, asOf);
  result = { ...result, account: row.id, checkedAt: Date.now(), snapshot: current,
    source: "Lighter public REST", status: "checked", realtimeLatencyVerified: false };
  db.prepare("UPDATE accounts SET status=?,result=?,payload=? WHERE id=?").run(result.status, JSON.stringify(result), JSON.stringify(current), row.id);
  log("account_checked", { account: row.id, address: row.address, status: result.status, winRate: result.winRate, pages: row.pages + 1 });
  await finishCandidate(row.address);
}
async function finishCandidate(address) {
  const accounts = db.prepare("SELECT id,status,result FROM accounts WHERE address=?").all(address);
  if (accounts.some(account => account.status === "pending")) return;
  const details = accounts.map(account => ({ account: account.id, status: account.status, details: JSON.parse(account.result) }));
  const outcomes = details.map(account => account.details);
  const tx = db.prepare("SELECT t.payload FROM trades t JOIN accounts a ON a.id=t.account WHERE a.address=?").all(address).map(row => JSON.parse(row.payload)).filter(trade => trade.timestamp >= asOf - 60 * 86400000 && trade.timestamp <= asOf);
  const transactions60d = new Set(tx.map(trade => trade.tx_hash)).size;
  const month = await monthPnl(address);
  const { closedPositions60d, wins, winRate, status } = summarizeLighterWallet(outcomes, transactions60d, month.pnl);
  db.prepare("UPDATE candidates SET status=?,result=? WHERE address=?").run(status, JSON.stringify({ accounts: details, transactions60d, closedPositions60d, wins, winRate, monthPnl: month, realtimeLatencyVerified: false }), address);
  appendFileSync(path.join(directory, "pnl-evidence.jsonl"), `${JSON.stringify({ address, ...month })}\n`);
  log("wallet_checked", { address, status, transactions60d, closedPositions60d, winRate, monthPnl: month.pnl });
}
process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
log("start", { directory, pid: process.pid, target, reviewAll, cohortSize, asOf }); save();
try {
  while (running && (reviewAll ? count("pending") + count("checking") > 0 : count("verified_wallet_data") < target)) {
    const disk = statfsSync(directory); if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error("insufficient_disk_space");
    if (!reviewAll && Number(db.prepare("SELECT COUNT(*) AS n FROM candidates").get().n) < 300 && !exhausted) { await discover(); continue; }
    const historyPages = Number(db.prepare("SELECT COALESCE(SUM(pages),0) AS n FROM accounts").get().n);
    // Keep looking for candidates while expensive histories continue in the same queue.
    if (!reviewAll && shouldExpandLighterCandidates(count("pending"), historyPages, nextDiscoveryPage, exhausted)) {
      await discover();
      nextDiscoveryPage = historyPages + 100;
      set("nextDiscoveryPage", nextDiscoveryPage);
    }
    const pending = db.prepare("SELECT * FROM candidates WHERE status='pending' ORDER BY rowid LIMIT 1").get();
    if (pending) {
      try { await initialize(pending); } catch (error) { if (!running) break; db.prepare("UPDATE candidates SET status='needs_review',result=? WHERE address=?").run(JSON.stringify({ error: error.message }), pending.address); log("candidate_error", { address: pending.address, error: error.message }); }
      save();
    }
    const account = db.prepare("SELECT * FROM accounts WHERE status='pending' ORDER BY pages,last_attempt,id LIMIT 1").get();
    if (account) {
      try { await checkAccount(account); } catch (error) { if (!running) break; db.prepare("UPDATE accounts SET status='needs_review',result=? WHERE id=?").run(JSON.stringify({ error: error.message }), account.id); try { await finishCandidate(account.address); } catch (reviewError) { db.prepare("UPDATE candidates SET status='needs_review',result=? WHERE address=?").run(JSON.stringify({ error: reviewError.message }), account.address); } log("account_error", { account: account.id, error: error.message }); }
      save(); continue;
    }
    if (reviewAll) {
      const unfinished = db.prepare("SELECT address FROM candidates WHERE status='checking' ORDER BY rowid LIMIT 1").get();
      if (unfinished) { try { await finishCandidate(unfinished.address); } catch (error) { db.prepare("UPDATE candidates SET status='needs_review',result=? WHERE address=?").run(JSON.stringify({ error: error.message }), unfinished.address); log("candidate_error", { address: unfinished.address, error: error.message }); } save(); continue; }
    }
    if (!exhausted && !reviewAll) { await discover(); continue; }
    break;
  }
  if (running && reviewAll) assert.equal(count("pending") + count("checking"), 0, "unfinished_cohort");
  save(running ? reviewAll ? "cohort_complete" : count("verified_wallet_data") >= target ? "target_reached" : "source_exhausted" : "stopped");
  log("finish", { verifiedWalletData: count("verified_wallet_data"), needsReview: count("needs_review"), rejected: count("rejected") });
} catch (error) { log("fatal", { error: error.message }); save("blocked"); process.exitCode = 1; }
finally { set("pid", null); db.close(); }
