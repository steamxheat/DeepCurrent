import type { Fill } from "./stats.ts";

export const screeningWindowDays = 60 as const;
export const screeningWindowMs = screeningWindowDays * 24 * 60 * 60 * 1_000;
export const minimumScreeningTrades = 6;

export type WalletScreening = {
  address: string;
  platform: "hyperliquid";
  windowDays: typeof screeningWindowDays;
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  volume: number;
  lastActive: number;
  score: number;
  historyComplete: boolean;
  qualifies: boolean;
  reason: string;
  screenedAt: number;
};

export function mergeWalletScreenings(bundled: WalletScreening[], current: WalletScreening[], now = Date.now()) {
  const rows = new Map(bundled.map((row) => [row.address, row]));
  for (const row of current) rows.set(row.address, row);
  return [...rows.values()]
    .filter((row) => row.qualifies && row.historyComplete && row.trades >= minimumScreeningTrades && row.winRate >= 60 && row.lastActive >= now - screeningWindowMs)
    .sort((left, right) => right.score - left.score || right.netPnl - left.netPnl);
}

export function screenWallet(address: string, fills: Fill[], historyComplete: boolean, now = Date.now()): WalletScreening {
  const recent = fills.filter((fill) => fill.time >= now - screeningWindowMs && fill.time <= now);
  const outcomes = new Map<string, number>();
  for (const fill of recent) {
    if (Number(fill.closedPnl) === 0 && !/(close|reduce|>)/i.test(fill.dir)) continue;
    const usableHash = fill.hash && !/^0x0+$/.test(fill.hash);
    const key = usableHash ? `${fill.coin}:${fill.hash}` : `${fill.coin}:${fill.side}:${Math.floor(fill.time / 1_000)}`;
    outcomes.set(key, (outcomes.get(key) ?? 0) + Number(fill.closedPnl || 0) + Number(fill.fee || 0));
  }
  const trades = [...outcomes.values()];
  const wins = trades.filter((netPnl) => netPnl > 0).length;
  const winRate = trades.length ? wins / trades.length * 100 : 0;
  const netPnl = trades.reduce((sum, value) => sum + value, 0);
  const volume = recent.reduce((sum, fill) => sum + Math.abs(Number(fill.px) * Number(fill.sz)), 0);
  const lastActive = recent.reduce((latest, fill) => Math.max(latest, fill.time), 0);
  const reason = !historyComplete ? "history_limit" : !lastActive ? "inactive" : trades.length < minimumScreeningTrades ? "too_few_trades" : winRate < 60 ? "win_rate" : "qualified";
  const score = Math.round((winRate + (winRate >= 80 && winRate <= 90 ? 10 : 0) + Math.log10(trades.length + 1) * 8 + Math.log10(Math.max(1, netPnl)) * 3) * 10) / 10;
  return {
    address: address.toLowerCase(), platform: "hyperliquid", windowDays: screeningWindowDays, trades: trades.length, wins, winRate,
    netPnl, volume, lastActive, score, historyComplete, qualifies: reason === "qualified", reason, screenedAt: now,
  };
}
