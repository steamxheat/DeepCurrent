import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const now = Date.now();
const directory = path.resolve("backups", `lighter-candidates-${now}`);
const candidates = new Map();
const pages = [];
for (const offset of [0, 100, 200]) {
  const url = `https://mainnet.zklighter.elliot.ai/api/v1/pnlLeaderboard?time_window=30d&sort_by=pnl&sort_dir=desc&limit=100&offset=${offset}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `Leaderboard HTTP ${response.status}`);
  const payload = await response.json();
  assert.equal(payload.code, 200, `Leaderboard code ${payload.code}`);
  assert.ok(Array.isArray(payload.entries));
  pages.push({ offset, receivedAt: Date.now(), updatedAt: payload.updated_at, total: payload.total, entries: payload.entries });
  for (const entry of payload.entries) {
    assert.ok(/^0x[\da-f]{40}$/i.test(entry.l1_address), "Invalid candidate address");
    assert.ok(Number.isFinite(entry.pnl), "Unknown candidate P&L");
    if (entry.pnl <= 0) continue;
    const address = entry.l1_address.toLowerCase();
    candidates.set(address, { platform: "lighter", address, rank: entry.rank, reportedPnl30d: entry.pnl,
      accountValue: entry.account_value, reportedVolume30d: entry.volume, fetchedAt: Date.now(),
      status: "candidate", qualifies: null, winRate: null, transactions60d: null, historyComplete: null,
      missingChecks: ["60-day activity and trade history", "More than five trades", "Win rate >=60% from verified closing outcomes", "Fees and P&L reconciliation", "Current positions and opening times", "Realtime and copy execution latency"] });
  }
  await new Promise(resolve => setTimeout(resolve, 1100));
}
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, "source.json"), JSON.stringify(pages, null, 2));
const rows = [...candidates.values()];
const report = { generatedAt: Date.now(), requested: 300, candidates: rows.length, qualified: 0,
  criteria: { activityDays: 60, minimumTransactions: 6, minimumWinRatePercent: 60, positivePnlDays: 30 },
  realtimeRequirementMs: 3000, rows };
writeFileSync(path.join(directory, "candidates.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: path.join(directory, "candidates.json"), candidates: rows.length,
  qualified: 0, minReportedPnl30d: rows.length ? Math.min(...rows.map(row => row.reportedPnl30d)) : null,
  maxReportedPnl30d: rows.length ? Math.max(...rows.map(row => row.reportedPnl30d)) : null,
  status: "Candidates only; no production wallet registry changes" }, null, 2));
