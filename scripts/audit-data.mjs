// Read-only stage-one audit: writes evidence and backups only under ignored .data.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { positionOpenedAt, netClosedPnl, findConfluences } from "../src/lib/stats.ts";
import { mergePulseFills } from "../src/lib/live.ts";
import { coinParticipants } from "../src/lib/coin-intelligence.ts";

const directory = process.argv[2] || path.join(process.cwd(), ".data", `audit-${new Date().toISOString().replaceAll(":", "-")}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const source = process.env.DEEPCURRENT_DB_PATH || path.join(process.cwd(), ".data", "deep-current.sqlite");
const db = new DatabaseSync(source, { readOnly: true });
if (!existsSync(path.join(directory, "backup.sqlite"))) await backup(db, path.join(directory, "backup.sqlite"));
for (const name of [".env.local", ".env", ".data/admin-state.json"]) {
  if (existsSync(name)) copyFileSync(name, path.join(directory, path.basename(name)));
}
const query = (sql) => db.prepare(sql).all();
const tables = query("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name);
const counts = Object.fromEntries(tables.map((name) => [name, query(`SELECT COUNT(*) AS count FROM "${name}"`)[0].count]));
const evidence = {
  startedAt: Date.now(), directory, integrity: query("PRAGMA integrity_check"), counts,
  eventsBySource: query("SELECT source, precision, COUNT(*) AS count FROM wallet_events GROUP BY source, precision"),
  duplicateExecutions: query("SELECT wallet, coin, occurred_at, tid, COUNT(*) AS count, GROUP_CONCAT(action) AS actions FROM wallet_events WHERE tid IS NOT NULL GROUP BY wallet, coin, occurred_at, tid HAVING COUNT(*) > 1 LIMIT 30"),
  snapshotAge: query("SELECT MIN(latest) AS oldest, MAX(latest) AS newest, COUNT(*) AS wallets FROM (SELECT wallet, MAX(captured_at) AS latest FROM position_snapshots GROUP BY wallet)"),
  repeatedOpenings: query("SELECT wallet, opened_at, COUNT(*) AS positions FROM wallet_positions WHERE opened_at IS NOT NULL GROUP BY wallet, opened_at HAVING COUNT(*) > 1 ORDER BY positions DESC LIMIT 20"),
  negativeFeeRows: query("SELECT SUM(CASE WHEN fee > 0 THEN 1 ELSE 0 END) AS positive, SUM(CASE WHEN fee < 0 THEN 1 ELSE 0 END) AS negative FROM wallet_events"),
  checks: {}, wallets: [], requests: [], errors: [],
};
if (existsSync(path.join(directory, "evidence.json"))) Object.assign(evidence, JSON.parse(readFileSync(path.join(directory, "evidence.json"), "utf8")));
const fill = { coin: "BTC", px: "100", sz: "1", side: "B", time: 100, dir: "Open Long", closedPnl: "10", fee: "1", hash: "h", tid: 1, startPosition: "0", wallet: "0xa", source: "user" };
evidence.checks.feeSign = { actual: netClosedPnl(fill), expected: 9 };
evidence.checks.inconsistentOpening = { actual: positionOpenedAt(1, "BTC", [{ ...fill, startPosition: "20" }]), expected: null };
evidence.checks.duplicateTidBuffer = { actual: mergePulseFills([], [fill, { ...fill, tid: 2 }]).length, expected: 2 };
evidence.checks.closedSnapshotParticipant = { actual: coinParticipants([], [{ wallet: "0xa", coin: "BTC", size: 0, capturedAt: 100, positionValue: 0 }], 100).length, expected: 0 };
evidence.checks.activityAfterClose = { actual: coinParticipants([
  { eventKey: "close", wallet: "0xa", coin: "BTC", action: "CLOSE", direction: "LONG", time: 120, price: 100, size: 1, beforeSize: 1, afterSize: 0 },
  { eventKey: "open", wallet: "0xa", coin: "BTC", action: "OPEN", direction: "LONG", time: 100, price: 100, size: 1, beforeSize: 0, afterSize: 1 },
], [], 130), expected: "Historical activity, never a verified current position" };
evidence.checks.confluenceStaleState = findConfluences([fill, { ...fill, wallet: "0xb", time: 101 }], 110, 1000).map((row) => ({ stillOpen: row.stillOpen, wallets: row.wallets }));
assert.equal(netClosedPnl({ closedPnl: "10", fee: "0" }), 10);
assert.equal(positionOpenedAt(1, "BTC", [{ ...fill, startPosition: "0" }]), 100);
assert.equal(mergePulseFills([], [fill, fill]).length, 1);
for (const name of ["feeSign", "inconsistentOpening", "duplicateTidBuffer", "closedSnapshotParticipant"]) {
  evidence.checks[name].passed = evidence.checks[name].actual === evidence.checks[name].expected;
}
db.close();

// Conservative rolling budget; returned history rows add API weight.
let windowStart = Date.now(); let weight = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function post(body) {
  for (let attempt = 0; attempt < 8; attempt++) {
  if (weight >= 700) { await sleep(Math.max(0, 61_000 - (Date.now() - windowStart))); windowStart = Date.now(); weight = 0; }
  if (Date.now() - windowStart >= 61_000) { windowStart = Date.now(); weight = 0; }
  const start = Date.now();
  const response = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
  const text = await response.text();
  evidence.requests.push({ type: body.type, dex: body.dex, status: response.status, ms: Date.now() - start, bytes: Buffer.byteLength(text) });
  weight += body.type === "clearinghouseState" ? 2 : 20;
  if (response.status === 429 && attempt < 7) { await sleep(10_000); continue; }
  if (!response.ok) throw new Error(`API ${response.status}`);
  const value = JSON.parse(text);
  if (Array.isArray(value) && body.type.startsWith("userFills")) weight += Math.ceil(value.length / 20);
  return value;
  }
  throw new Error("API retry exhausted");
}
const registry = JSON.parse(readFileSync("src/lib/wallet-registry.json", "utf8"));
const leaderboardResponse = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { signal: AbortSignal.timeout(25_000) });
assert.ok(leaderboardResponse.ok);
const leaderboard = await leaderboardResponse.json();
const byAddress = new Map(leaderboard.leaderboardRows.map((row) => [row.ethAddress.toLowerCase(), row]));
const eligible = registry.filter(([address]) => byAddress.has(address));
const sample = Array.from({ length: Math.min(50, eligible.length) }, (_, index) => eligible[Math.floor(index * eligible.length / Math.min(50, eligible.length))]);
const dexes = await post({ type: "perpDexs" });
evidence.dexes = dexes.flatMap((row) => row?.name ? [row.name] : []);
evidence.selection = "50 evenly spaced bundled-registry wallets present in current leaderboard; main dex all 50, other dexs first 5; no 60-day requalification claimed";
for (const [index, [address, , , registeredWinRate]] of sample.entries()) {
  if (evidence.wallets.some((row) => row.address === address && !row.error)) continue;
  const row = { address, registeredWinRate, positions: [], checkedAt: Date.now() };
  try {
    const fills = await post({ type: "userFills", user: address, aggregateByTime: false });
    row.fillCount = fills.length;
    row.historyCapped = fills.length >= 2000;
    row.oldestFill = fills.length ? Math.min(...fills.map((fill) => fill.time)) : null;
    row.latestFill = fills.length ? Math.max(...fills.map((fill) => fill.time)) : null;
    row.positiveFees = fills.filter((fill) => Number(fill.fee) > 0).length;
    row.negativeFees = fills.filter((fill) => Number(fill.fee) < 0).length;
    row.feeSignPnlDifference = fills.reduce((sum, fill) => sum + 2 * Number(fill.fee || 0), 0);
    const scopes = ["", ...(index < 5 ? evidence.dexes : [])];
    for (const dex of scopes) {
      const state = await post({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) });
      for (const { position } of state.assetPositions ?? []) {
        if (!Number(position.szi)) continue;
        const relevant = fills.filter((fill) => fill.coin === position.coin).sort((a, b) => b.time - a.time);
        const latest = relevant[0];
        const latestAfter = latest ? Number(latest.startPosition) + Number(latest.sz) * (latest.side === "B" ? 1 : -1) : null;
        const size = Number(position.szi);
        const agrees = latestAfter !== null && Math.abs(latestAfter - size) <= Math.max(1, Math.abs(size)) * 1e-8;
        row.positions.push({ coin: position.coin, dex, size, openedAt: positionOpenedAt(size, position.coin, fills), latestFill: latest?.time ?? null, latestAfter, latestMatchesSnapshot: agrees, warning: latestAfter === null ? "no fill in available history" : agrees ? null : "race, missing history, or non-fill position change; cannot label opening exact" });
      }
    }
    const month = byAddress.get(address).windowPerformances.find(([name]) => name === "month")?.[1];
    row.monthPnl = Number(month?.pnl ?? 0);
  } catch (error) { row.error = error.message; evidence.errors.push({ address, message: error.message }); }
  evidence.wallets = evidence.wallets.filter((existing) => existing.address !== address);
  evidence.wallets.push(row);
  writeFileSync(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`${index + 1}/${sample.length} ${address} fills=${row.fillCount ?? "error"} positions=${row.positions.length}`);
  await sleep(300);
}
evidence.finishedAt = Date.now();
evidence.summary = { sampled: evidence.wallets.length, successful: evidence.wallets.filter((row) => !row.error).length, cappedHistory: evidence.wallets.filter((row) => row.historyCapped).length, positions: evidence.wallets.flatMap((row) => row.positions).length, unknownOpenings: evidence.wallets.flatMap((row) => row.positions).filter((row) => row.openedAt === null).length, disagreements: evidence.wallets.flatMap((row) => row.positions).filter((row) => row.latestAfter !== null && !row.latestMatchesSnapshot).length };
writeFileSync(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ directory, summary: evidence.summary }));
