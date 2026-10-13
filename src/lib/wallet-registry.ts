import bundledRows from "./wallet-registry.json" with { type: "json" };
import { walletScreenings } from "./event-store.ts";
import { mergeWalletScreenings, screeningWindowDays, type WalletScreening } from "./wallet-screening.ts";

type BundledRow = [string, number, number, number, number, number, number, number, number];

const bundled = (bundledRows as BundledRow[]).map(([address, trades, wins, winRate, netPnl, volume, lastActive, score, screenedAt]): WalletScreening => ({
  address, platform: "hyperliquid", windowDays: screeningWindowDays, trades, wins, winRate, netPnl, volume,
  lastActive, score, historyComplete: true, qualifies: true, reason: "qualified", screenedAt,
}));

export function availableWalletScreenings(limit = 5_000, now = Date.now()) {
  return mergeWalletScreenings(bundled, walletScreenings(false, 50_000), now).slice(0, limit);
}
