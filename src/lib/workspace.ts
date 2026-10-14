import type { PulseFill, WalletRow } from "./hyperliquid";
import { activityKind } from "./live.ts";
import { marketNumber } from "./data-freshness.ts";

export type WalletSort = "rank" | "accountValue" | "dayPnl" | "monthPnl" | "monthRoi" | "dayVolume";
export type WalletFilters = {
  query: string;
  performance: "all" | "winners" | "losers";
  minAccount: number;
  minMonthPnl: number;
  minRoi: number;
  minVolume: number;
  namedOnly: boolean;
  favoritesOnly: boolean;
  riskFreeOnly: boolean;
};
export type ActivityFilters = {
  query: string;
  coin: string;
  action: "all" | "long" | "short" | "reduced" | "OPEN" | "ADD" | "REDUCE" | "CLOSE" | "FLIP";
  source: "all" | "exact" | "market";
  favoritesOnly: boolean;
  minNotional: number;
  sort: "newest" | "oldest" | "largest" | "price" | "price-asc";
};

export const defaultWalletFilters: WalletFilters = { query: "", performance: "all", minAccount: 0, minMonthPnl: 0, minRoi: 0, minVolume: 0, namedOnly: false, favoritesOnly: false, riskFreeOnly: false };
export const defaultActivityFilters: ActivityFilters = { query: "", coin: "all", action: "all", source: "all", favoritesOnly: false, minNotional: 0, sort: "newest" };

export function walletRiskFlags(wallet: WalletRow) {
  const flags: string[] = [];
  if (wallet.dayPnl < 0) flags.push("Минус за 24H");
  if (wallet.monthRoi > 1_000) flags.push("Аномальный ROI");
  if (wallet.dayVolume === 0) flags.push("Нет объёма за 24H");
  if (wallet.accountValue < 250_000) flags.push("Небольшой капитал");
  return flags;
}

export function qualityBand(wallet: WalletRow) {
  if (wallet.rank <= 10) return "Elite";
  if (wallet.rank <= 50) return "Strong";
  if (wallet.rank <= 100) return "Solid";
  return "Watch";
}

export function filterWallets(wallets: WalletRow[], filters: WalletFilters, favorites: Set<string>, sort: WalletSort, direction: "asc" | "desc") {
  const query = filters.query.trim().toLowerCase();
  const rows = wallets.filter((wallet) => {
    if (query && !`${wallet.name} ${wallet.address}`.toLowerCase().includes(query)) return false;
    if (filters.performance === "winners" && !(wallet.dayPnl > 0)) return false;
    if (filters.performance === "losers" && !(wallet.dayPnl < 0)) return false;
    if (![wallet.accountValue, wallet.monthPnl, wallet.monthRoi, wallet.dayVolume].every(Number.isFinite) || !(wallet.accountValue >= filters.minAccount) || !(wallet.monthPnl >= filters.minMonthPnl) || !(wallet.monthRoi >= filters.minRoi) || !(wallet.dayVolume >= filters.minVolume)) return false;
    if (filters.namedOnly && wallet.name.startsWith("Wallet ")) return false;
    if (filters.favoritesOnly && !favorites.has(wallet.address)) return false;
    if (filters.riskFreeOnly && walletRiskFlags(wallet).length) return false;
    return true;
  });
  const sign = direction === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    if (!Number.isFinite(a[sort])) return !Number.isFinite(b[sort]) ? 0 : 1;
    if (!Number.isFinite(b[sort])) return -1;
    return sign * (a[sort] - b[sort]);
  });
}

export function walletInsights(wallets: WalletRow[]) {
  const orderedRoi = wallets.map((wallet) => wallet.monthRoi).sort((a, b) => a - b);
  const middle = Math.floor(orderedRoi.length / 2);
  const medianRoi = orderedRoi.length ? orderedRoi.length % 2 ? orderedRoi[middle] : (orderedRoi[middle - 1] + orderedRoi[middle]) / 2 : 0;
  return {
    accountValue: wallets.reduce((sum, wallet) => sum + wallet.accountValue, 0),
    monthPnl: wallets.reduce((sum, wallet) => sum + wallet.monthPnl, 0),
    dayPnl: wallets.reduce((sum, wallet) => sum + wallet.dayPnl, 0),
    medianRoi,
    positiveToday: wallets.filter((wallet) => wallet.dayPnl > 0).length,
    activeToday: wallets.filter((wallet) => wallet.dayVolume > 0).length,
    riskFlags: wallets.filter((wallet) => walletRiskFlags(wallet).length > 0).length,
  };
}

export function filterActivity(fills: PulseFill[], filters: ActivityFilters, favorites: Set<string>) {
  const query = filters.query.trim().toLowerCase();
  return fills.filter((fill) => {
    const activity = activityKind(fill);
    const notional = marketNumber(fill.px) * marketNumber(fill.sz);
    if (query && !`${fill.coin} ${fill.walletName} ${fill.wallet}`.toLowerCase().includes(query)) return false;
    if (filters.coin !== "all" && fill.coin !== filters.coin) return false;
    if (filters.action === "long" && activity.direction !== "LONG") return false;
    if (filters.action === "short" && activity.direction !== "SHORT") return false;
    if (filters.action === "reduced" && !["REDUCE", "CLOSE"].includes(activity.label)) return false;
    if (/^[A-Z]+$/.test(filters.action) && filters.action !== activity.label) return false;
    if (filters.source === "exact" && (!activity.exact || fill.precision !== undefined && fill.precision !== "exact")) return false;
    if (filters.source === "market" && fill.source !== "market") return false;
    if (filters.favoritesOnly && !favorites.has(fill.wallet)) return false;
    return notional >= filters.minNotional;
  }).sort((a, b) => filters.sort === "largest" ? Number(b.px) * Number(b.sz) - Number(a.px) * Number(a.sz) : filters.sort === "oldest" ? a.time - b.time : filters.sort === "price" ? Number(b.px) - Number(a.px) : filters.sort === "price-asc" ? Number(a.px) - Number(b.px) : b.time - a.time);
}

const csvCell = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
export function walletsCsv(wallets: WalletRow[]) {
  return [["rank", "name", "address", "account_value", "24h_pnl", "7d_pnl", "30d_pnl", "30d_roi", "24h_volume", "60d_win_rate", "60d_closed_trades", "60d_net_pnl", "vetted_at"], ...wallets.map((wallet) => [wallet.rank, wallet.name, wallet.address, wallet.accountValue, wallet.dayPnl, wallet.weekPnl, wallet.monthPnl, wallet.monthRoi, wallet.dayVolume, wallet.winRate60d ?? "", wallet.trades60d ?? "", wallet.netPnl60d ?? "", wallet.vettedAt ? new Date(wallet.vettedAt).toISOString() : ""])].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function fillsCsv(fills: PulseFill[]) {
  return [["time", "wallet", "name", "coin", "direction", "source", "price", "size", "notional_usd", "closed_pnl", "fee", "hash"], ...fills.map((fill) => [new Date(fill.time).toISOString(), fill.wallet, fill.walletName, fill.coin, fill.dir, fill.source === "market" ? "public_execution" : "exact_position", fill.px, fill.sz, Number(fill.px) * Number(fill.sz), fill.closedPnl, fill.fee, fill.hash])].map((row) => row.map(csvCell).join(",")).join("\n");
}
