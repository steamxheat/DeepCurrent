import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { auditDydxReportedHistory, dydxOfficialPnl30d } from "../src/lib/dydx-screening.ts";
import { copySelectionCriteria, copyQualityDecision } from "../src/lib/copy-selection.ts";
import { decimalAdd, decimalSign, validDecimal } from "../src/lib/position-reducer.ts";

const directory = path.resolve(process.argv[2] ?? "backups/dydx-screen-20261015");
const maximumProfiles = Number(process.argv[3] ?? 10);
assert.ok(Number.isInteger(maximumProfiles) && maximumProfiles > 0 && maximumProfiles <= 200);
mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(path.join(directory, "screening.sqlite"));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS profiles(address TEXT PRIMARY KEY,priority REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT); CREATE TABLE IF NOT EXISTS responses(id INTEGER PRIMARY KEY,url TEXT,received_at INTEGER,http INTEGER,payload TEXT); CREATE TABLE IF NOT EXISTS pages(key TEXT PRIMARY KEY,payload TEXT NOT NULL);");
const get = key => { const row = db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; };
const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
const prior = get("pid");
if (prior) { let live = true; try { process.kill(prior, 0); } catch { live = false; } assert.ok(!live, `already_running_${prior}`); }
const qualityOnly = process.argv[4] === "--quality-only";
const selectedFile = qualityOnly ? null : process.argv[4];
// Small capability cohorts only; do not scan the entire chain before live and independent history acceptance.
if (qualityOnly) {
  assert.ok(db.prepare("SELECT count(*) n FROM profiles").get().n > 0, "quality_cohort_not_seeded");
} else if (selectedFile) {
  const selection = JSON.parse(readFileSync(selectedFile, "utf8"));
  assert.ok(selection.revision === "dydx-active-v1" && selection.status === "complete" && Array.isArray(selection.accounts) && selection.accounts.length && selection.accounts.length <= 80, "invalid_active_selection");
  assert.ok(Number.isFinite(selection.updatedAt) && selection.updatedAt <= Date.now() && Date.now() - selection.updatedAt < 15 * 60000, "stale_active_selection");
  for (const account of selection.accounts) {
    assert.ok(/^dydx1[a-z0-9]{38}$/.test(account.id?.owner) && Number.isInteger(account.id?.number) && account.id.number >= 0 && account.snapshot?.address === account.id.owner && Number.isFinite(Number(account.snapshot.equity)), "invalid_active_account");
    db.prepare("INSERT INTO profiles(address,priority) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET priority=max(priority,excluded.priority)").run(account.id.owner, Number(account.snapshot.equity) * 1e6);
  }
} else {
  const probe = new DatabaseSync("backups/dydx-public-probe-20261015/evidence.sqlite", { readOnly: true });
  for (const row of probe.prepare("SELECT payload FROM accounts").all()) {
    const a = JSON.parse(row.payload), priority = Number(a.asset_positions?.find(x => x.asset_id === 0)?.quantums ?? 0);
    db.prepare("INSERT INTO profiles(address,priority) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET priority=max(priority,excluded.priority)").run(a.id.owner, priority);
  }
  probe.close();
}
set("pid", process.pid);
let running = true, lastRequest = 0, requests = get("requests") ?? 0;
process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, data = {}) => { const entry = { at: Date.now(), event, ...data }; appendFileSync(path.join(directory, "actions.jsonl"), JSON.stringify(entry) + "\n"); console.log(JSON.stringify(entry)); };
function save(status = "running", error = null) {
  const counts = Object.fromEntries(db.prepare("SELECT status,count(*) n FROM profiles GROUP BY status").all().map(row => [row.status, row.n]));
  const legacyResults = db.prepare("SELECT result FROM profiles WHERE result IS NOT NULL").all().filter(row => JSON.parse(row.result).criteriaRevision !== copySelectionCriteria.revision).length;
  const profitThresholdPassed = db.prepare("SELECT result FROM profiles WHERE result IS NOT NULL").all().filter(row => JSON.parse(row.result).profitThresholdPassed === true).length;
  const summary = { status, error, pid: process.pid, updatedAt: Date.now(), requests, criteria: copySelectionCriteria, phase: qualityOnly ? "official_profit30d_only" : "reported_history", maximumProfiles, counts, legacyResults, profitThresholdPassed, fullyAccepted: 0,
    countsIncludeLegacyResults: true,
    note: "Reported lifecycle audit, not independent raw-fill verification or live acceptance. No provisional additions to application." };
  const profiles = db.prepare("SELECT address,status,result FROM profiles WHERE result IS NOT NULL").all().map(row => ({ address: row.address, status: row.status, ...JSON.parse(row.result) }));
  for (const [name, data] of [["summary.json", summary], ["report.json", { ...summary, profiles }]]) {
    writeFileSync(path.join(directory, name + ".tmp"), JSON.stringify(data, null, 2)); renameSync(path.join(directory, name + ".tmp"), path.join(directory, name));
  }
}
async function request(route, params = {}) {
  const url = new URL("https://indexer.dydx.trade/v4/" + route); Object.entries(params).forEach(([k, v]) => { if (v !== null && v !== undefined) url.searchParams.set(k, String(v)); });
  for (let attempt = 0; attempt < 3 && running; attempt++) {
    await pause(Math.max(0, lastRequest + 1500 - Date.now())); assert.ok(running, "stopped"); lastRequest = Date.now();
    requests++; set("requests", requests); const response = await fetch(url, { signal: AbortSignal.timeout(25000) }); const body = await response.text();
    db.prepare("INSERT INTO responses(url,received_at,http,payload) VALUES(?,?,?,?)").run(String(url), Date.now(), response.status, body);
    if (response.status === 429) { log("rate_limit", { route }); save("rate_limit_backoff"); for (let n = 0; n < 60 && running; n++) await pause(1000); continue; }
    assert.equal(response.status, 200, `HTTP_${response.status}`); const payload = JSON.parse(body); assert.ok(!payload.errors, "api_errors"); return payload;
  }
  throw Error(running ? "persistent_rate_limit" : "stopped");
}
async function pagedHistory(address, subaccountNumber, fillCount) {
  const rows = []; let total = null; const pageSize = 1000;
  for (let page = 1; running; page++) {
    const key = `${address}/${subaccountNumber}/history1000/${page}`, stored = db.prepare("SELECT payload FROM pages WHERE key=?").get(key);
    const payload = stored ? JSON.parse(stored.payload) : await request("tradeHistory", { address, subaccountNumber, limit: pageSize, page });
    assert.ok(Array.isArray(payload.tradeHistory) && Number.isSafeInteger(payload.totalResults) && payload.offset === (page - 1) * pageSize, "invalid_history_pagination");
    assert.ok(total === null || total === payload.totalResults, "history_changed_during_pagination"); total = payload.totalResults;
    if (!stored) db.prepare("INSERT INTO pages VALUES(?,?)").run(key, JSON.stringify(payload));
    rows.push(...payload.tradeHistory); save();
    assert.ok(total <= fillCount * 2, "history_saturated_or_inconsistent");
    assert.ok(total <= 26000, "public_history_offset_limit");
    if (rows.length >= total) { assert.equal(rows.length, total, "history_count_mismatch"); break; }
    assert.ok(payload.tradeHistory.length === pageSize, "short_incomplete_page");
  }
  assert.ok(running, "stopped");
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "duplicate_history_across_pages");
  const head = await request("tradeHistory", { address, subaccountNumber, limit: 1, page: 1 });
  assert.ok(head.totalResults === total && JSON.stringify(head.tradeHistory?.[0]) === JSON.stringify(rows[0]), "history_changed_before_snapshot");
  return rows;
}
async function allPositions(address, subaccountNumber) {
  const found = new Map(); let boundary = null;
  for (let page = 0; running && page < 2000; page++) {
    const payload = await request("perpetualPositions", { address, subaccountNumber, limit: 1000, createdBeforeOrAtHeight: boundary });
    assert.ok(Array.isArray(payload.positions), "missing_positions"); let added = 0;
    for (const p of payload.positions) {
      assert.ok(p.subaccountNumber === subaccountNumber && ["OPEN", "CLOSED"].includes(p.status) && Number.isSafeInteger(Number(p.createdAtHeight)), "invalid_position");
      const key = JSON.stringify([p.market, p.createdAt, p.side]); if (!found.has(key)) added++; found.set(key, p);
    }
    if (payload.positions.length < 1000) return [...found.values()];
    assert.ok(added > 0, "position_height_boundary_saturated");
    const next = Math.min(...payload.positions.map(p => Number(p.createdAtHeight))); assert.ok(boundary === null || next < boundary, "position_height_boundary_saturated"); boundary = next;
  }
  throw Error(running ? "position_history_saturated" : "stopped");
}
async function check(address) {
  const snapshot = await request(`addresses/${address}`); assert.ok(Array.isArray(snapshot.subaccounts) && snapshot.subaccounts.length, "missing_subaccounts");
  assert.ok(snapshot.subaccounts.every(a => a.address === address), "wrong_snapshot_address");
  const numbers = snapshot.subaccounts.map(a => a.subaccountNumber); assert.equal(new Set(numbers).size, numbers.length, "duplicate_subaccount");
  const pnlAccounts = []; let actions60d = 0;
  for (const subaccountNumber of numbers) {
    assert.ok(Number.isInteger(subaccountNumber) && subaccountNumber >= 0, "invalid_subaccount_number");
    const payload = await request("pnl", { address, subaccountNumber, limit: 1 });
    const latest = payload.pnl?.[0]; assert.ok(latest && validDecimal(latest.totalPnl) && Number.isFinite(Number(latest.totalPnl)), "missing_official_lifetime_pnl");
    assert.ok(Date.parse(latest.createdAt) <= Date.now() && Date.now() - Date.parse(latest.createdAt) < 2 * 3600000, "stale_official_pnl");
    pnlAccounts.push({ subaccountNumber, head: latest, startRows: [], endRows: undefined });
  }
  const endAt = Math.min(...pnlAccounts.map(a => Date.parse(a.head.createdAt))), startAt = endAt - 30 * 86400000;
  for (const account of pnlAccounts) {
    // The API filters raw rows before hourly aggregation: fetch adjacent buckets, then select the exact timestamp.
    const rowsAt = async at => {
      const response = await request("pnl", { address, subaccountNumber: account.subaccountNumber, limit: 3, createdBeforeOrAt: new Date(at + 3600000).toISOString() });
      assert.ok(Array.isArray(response.pnl), "missing_pnl_boundary_rows"); return response.pnl;
    };
    account.startRows = await rowsAt(startAt);
    if (Date.parse(account.head.createdAt) !== endAt) account.endRows = await rowsAt(endAt);
    save();
  }
  const profit = dydxOfficialPnl30d(pnlAccounts, Date.now()), pnlAll = profit.officialPnlAll;
  const accounts = profit.accounts.map(a => ({ subaccountNumber: a.subaccountNumber, officialPnl: a.end, officialPnl30dStart: a.start }));
  const fresh = await request(`addresses/${address}`);
  assert.deepEqual(fresh.subaccounts?.map(a => a.subaccountNumber).sort((a, b) => a - b), [...numbers].sort((a, b) => a - b), "subaccount_set_changed_during_pnl");
  const quality = copyQualityDecision({ officialNetPnl30dUsd: profit.officialNetPnl30dUsd, maximumDrawdownPct: null, drawdownVerified: false, nonScalpingVerified: null });
  const profitEvidence = { officialNetPnl30dUsd: profit.officialNetPnl30dUsd, pnlWindowStartAt: profit.startAt, pnlWindowEndAt: profit.endAt, quality, pnlAll, accounts, checkedAt: Date.now(), fullyAccepted: false };
  if (quality.status === "rejected") return { status: "rejected", reason: "net_pnl30d_below_50000", profitThresholdPassed: false, ...profitEvidence };
  if (decimalSign(pnlAll) <= 0) return { status: "rejected", reason: "nonpositive_official_lifetime_pnl", profitThresholdPassed: true, ...profitEvidence };
  if (qualityOnly) return { status: "needs_review", reason: "profit_passed_risk_style_history_live_pending", profitThresholdPassed: true, ...profitEvidence };
  for (const account of accounts) {
    const params = { address, subaccountNumber: account.subaccountNumber };
    const recent = await request("fills", { ...params, limit: 10 }); assert.ok(Array.isArray(recent.fills), "missing_recent_fills");
    for (const f of recent.fills) assert.ok(f.subaccountNumber === account.subaccountNumber && f.id && Number.isFinite(Date.parse(f.createdAt)) && Date.parse(f.createdAt) <= Date.now(), "invalid_recent_fill");
    actions60d += new Set(recent.fills.filter(f => Date.now() - Date.parse(f.createdAt) <= 60 * 86400000).map(f => f.id)).size;
  }
  if (actions60d < 5) return { status: "rejected", reason: "fewer_than_five_recent_executions", pnlAll, accounts, observedRecentExecutions60d: actions60d };
  for (const account of accounts) {
    const params = { address, subaccountNumber: account.subaccountNumber };
    const metadata = await request("fills", { ...params, limit: 1, page: 1 }); assert.ok(Number.isSafeInteger(metadata.totalResults) && metadata.totalResults >= 0 && metadata.totalResults < 100000, "raw_fill_history_cap_or_unknown_count");
    const rows = await pagedHistory(address, account.subaccountNumber, metadata.totalResults);
    assert.ok(rows.every(row => row.subaccountNumber === account.subaccountNumber), "wrong_history_subaccount");
    const positions = await allPositions(address, account.subaccountNumber);
    const fresh = await request(`addresses/${address}`); assert.deepEqual(fresh.subaccounts?.map(a => a.subaccountNumber).sort((a, b) => a - b), [...numbers].sort((a, b) => a - b), "subaccount_set_changed");
    const current = fresh.subaccounts.find(a => a.subaccountNumber === account.subaccountNumber);
    assert.ok(current && current.openPerpetualPositions && typeof current.openPerpetualPositions === "object", "missing_current_positions");
    account.audit = auditDydxReportedHistory(rows, positions, Object.values(current.openPerpetualPositions), true, Date.now());
  }
  const closed = accounts.reduce((n, a) => n + a.audit.closedPositionsLifetime, 0), wins = accounts.reduce((n, a) => n + a.audit.winsLifetime, 0);
  const volume = accounts.reduce((n, a) => decimalAdd(n, a.audit.volume30dUsd), "0"), winRate = closed ? wins * 100 / closed : null;
  const basicPassed = closed > 0 && wins * 100 >= closed * 60 && decimalSign(decimalAdd(volume, "-300000")) >= 0;
  return { ...profitEvidence, status: basicPassed ? quality.status : "rejected", criteriaRevision: copySelectionCriteria.revision, basicPassed, profitThresholdPassed: true, volume30dUsd: volume, closedPositionsLifetime: closed, winsLifetime: wins, winRateLifetime: winRate, observedRecentExecutions60d: actions60d, accounts, checkedAt: Date.now(), fullyAccepted: false };
}
try {
  log("start", { pid: process.pid, maximumProfiles }); save();
  const alreadyChecked = db.prepare("SELECT count(*) n FROM profiles WHERE status NOT IN ('pending','checking')").get().n;
  for (let n = alreadyChecked; running && n < maximumProfiles; n++) {
    const row = db.prepare("SELECT address FROM profiles WHERE status IN ('pending','checking') ORDER BY priority DESC LIMIT 1").get(); if (!row) break;
    db.prepare("UPDATE profiles SET status='checking' WHERE address=?").run(row.address); save();
    let result;
    try { result = await check(row.address); }
    catch (error) {
      if (!running) break;
      if (/HTTP_(401|403|451)|persistent_rate_limit/.test(error.message)) throw error;
      result = { status: "needs_review", error: error.message, checkedAt: Date.now(), fullyAccepted: false };
    }
    result.criteriaRevision = copySelectionCriteria.revision;
    db.prepare("UPDATE profiles SET status=?,result=? WHERE address=?").run(result.status, JSON.stringify(result), row.address); log("profile_checked", { address: row.address, ...result, accounts: undefined }); save();
  }
  save(running ? "pilot_complete" : "stopped");
} catch (error) { log("fatal", { error: error.message }); save(running ? "blocked" : "stopped", error.message); process.exitCode = running ? 1 : 0; }
finally { set("pid", null); db.close(); }
