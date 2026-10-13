import { mergeFills } from "../src/lib/stats.ts";
import { recordWalletScreening, screenedWalletAddresses, walletScreenings } from "../src/lib/event-store.ts";
import { screenWallet, screeningWindowMs } from "../src/lib/wallet-screening.ts";
import { hasPositiveMonthPnl } from "../src/lib/wallet-quality.ts";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const requestedTarget = Number(process.argv.find((value) => value.startsWith("--target="))?.split("=")[1] ?? 1_000);
const target = Math.max(1, Math.min(50_000, requestedTarget));
const requestedWorkers = Number(process.argv.find((value) => value.startsWith("--workers="))?.split("=")[1] ?? 4);
const workers = Math.max(1, Math.min(4, requestedWorkers));
const refresh = process.argv.includes("--refresh");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const performance = (row, window) => row.windowPerformances.find(([name]) => name === window)?.[1] ?? {};

async function post(body) {
  const response = await fetch(INFO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 429) { await sleep(65_000); return post(body); }
  if (!response.ok) throw new Error(`Hyperliquid API: ${response.status}`);
  const value = await response.json();
  const weight = 20 + Math.ceil((Array.isArray(value) ? value.length : 0) / 20);
  await sleep(Math.ceil(weight * workers / 1_200 * 60_000) + 150);
  return value;
}

async function recentFills(address, now) {
  const startTime = now - screeningWindowMs;
  let endTime = now; let fills = []; let historyComplete = false;
  for (let page = 0; page < 5; page++) {
    const batch = await post({ type: "userFillsByTime", user: address, startTime, endTime, aggregateByTime: true });
    fills = mergeFills(fills, batch);
    if (batch.length < 2_000) { historyComplete = true; break; }
    const oldest = Math.min(...batch.map((fill) => fill.time));
    if (oldest <= startTime) { historyComplete = true; break; }
    endTime = oldest - 1;
  }
  return { fills, historyComplete };
}

const leaderboardResponse = await fetch(LEADERBOARD_URL);
if (!leaderboardResponse.ok) throw new Error(`Leaderboard: ${leaderboardResponse.status}`);
const payload = await leaderboardResponse.json();
const candidates = payload.leaderboardRows.map((row) => {
  const week = performance(row, "week"); const month = performance(row, "month"); const monthPnl = Number(month.pnl ?? 0); const monthVolume = Number(month.vlm ?? 0);
  const priority = (monthVolume >= 1_000_000 ? 4 : monthVolume > 0 ? 1 : 0) + (Number(week.pnl ?? 0) > 0 ? 2 : 0) + (Number(month.roi ?? 0) >= .1 ? 1 : 0);
  return { address: row.ethAddress.toLowerCase(), score: hasPositiveMonthPnl(monthPnl) ? monthPnl : null, priority, monthVolume };
}).filter((row) => row.score !== null)
  .sort((left, right) => right.priority - left.priority || left.monthVolume - right.monthVolume || right.score - left.score).slice(0, target);

const screened = refresh ? new Set() : screenedWalletAddresses();
let qualified = refresh ? 0 : walletScreenings(true, target).length;
const pending = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => !screened.has(candidate.address));
let cursor = 0; let failures = 0;
console.log(`Deep Current 60D screening: ${qualified} qualified, ${candidates.filter(({ address }) => screened.has(address)).length}/${candidates.length} already checked, ${workers} workers.`);
async function work() {
  while (cursor < pending.length) {
    const { candidate, index } = pending[cursor++];
    try {
      const now = Date.now(); const { fills, historyComplete } = await recentFills(candidate.address, now);
      const result = screenWallet(candidate.address, fills, historyComplete, now);
      recordWalletScreening(result); screened.add(candidate.address);
      if (result.qualifies) qualified += 1;
      console.log(`${index + 1}/${candidates.length} ${candidate.address} ${result.qualifies ? "QUALIFIED" : result.reason} · ${result.trades} closed trades · ${result.winRate.toFixed(2)}% · total ${qualified}`);
    } catch (error) {
      failures += 1;
      console.error(`${candidate.address}: ${error instanceof Error ? error.message : error}`);
      await sleep(5_000);
    }
  }
}
await Promise.all(Array.from({ length: workers }, () => work()));
console.log(`Screening finished: ${candidates.filter(({ address }) => screened.has(address)).length}/${candidates.length} available wallets checked, ${qualified} qualified, ${failures} failed requests.`);
