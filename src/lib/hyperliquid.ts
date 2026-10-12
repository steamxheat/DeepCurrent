import "server-only";
import type { Fill } from "./stats";
import { normalizePerpPortfolio, type PortfolioRange, type PortfolioSeries, type RawPortfolioEntry } from "./portfolio";
import { getAdminConfig, type AdminConfig } from "./admin-store";
import { walletQuality } from "./wallet-quality";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
let leaderboardCache: { expires: number; rows: WalletRow[]; sourceCount: number } | undefined;
type WindowName = "day" | "week" | "month" | "allTime";
type WindowPerformance = [WindowName, { pnl: string; roi: string; vlm: string }];
type RawLeaderboardRow = { ethAddress: string; accountValue: string; windowPerformances: WindowPerformance[]; displayName?: string | null };
type RawPosition = {
  coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string;
  leverage?: { value?: number }; liquidationPx?: string | null;
};
type RawState = {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  withdrawable?: string;
  assetPositions?: { position: RawPosition }[];
};
type RawMeta = { universe?: { name?: string }[] };
type RawAssetContext = { dayNtlVlm?: string };

export type WalletRow = {
  rank: number; address: string; name: string; accountValue: number; dayPnl: number;
  dayRoi: number; dayVolume: number; weekPnl: number; monthPnl: number; monthRoi: number;
};
export type PulseFill = Fill & { wallet: string; walletName: string };
export type DashboardData = {
  wallets: WalletRow[]; prices: Record<string, number>; fills: PulseFill[];
  tracked: { address: string; name: string }[]; liveCoins: string[]; sourceCount: number;
  config: AdminConfig; updatedAt: number; warnings: string[];
};
export type Position = {
  coin: string; size: number; entryPx: number; positionValue: number;
  unrealizedPnl: number; leverage: number; liquidationPx: number | null;
};
export type { PortfolioRange, PortfolioSeries } from "./portfolio";
export type WalletDetail = {
  address: string; accountValue: number; totalMarginUsed: number; withdrawable: number;
  positions: Position[]; fills: Fill[]; portfolio: Record<PortfolioRange, PortfolioSeries>;
};

async function info<T>(body: Record<string, unknown>, revalidate: number): Promise<T> {
  const response = await fetch(INFO_URL, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    cache: "force-cache", next: { revalidate },
  });
  if (!response.ok) throw new Error(`Hyperliquid API: ${response.status}`);
  return response.json() as Promise<T>;
}

function performance(row: RawLeaderboardRow, name: WindowName) {
  const value = row.windowPerformances.find(([window]) => window === name)?.[1];
  return { pnl: Number(value?.pnl ?? 0), roi: Number(value?.roi ?? 0) * 100, vlm: Number(value?.vlm ?? 0) };
}

async function getLeaderboard(limit: number) {
  // shortcut: this public leaderboard feed is undocumented, replace it with a persisted vetted registry before production.
  if (leaderboardCache && leaderboardCache.expires > Date.now()) return { rows: leaderboardCache.rows.slice(0, limit), sourceCount: leaderboardCache.sourceCount };
  const response = await fetch(LEADERBOARD_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Leaderboard: ${response.status}`);
  const payload = await response.json() as { leaderboardRows: RawLeaderboardRow[] };
  const rows = payload.leaderboardRows.map((row) => {
    const day = performance(row, "day");
    const week = performance(row, "week");
    const month = performance(row, "month");
    return {
      rank: 0, address: row.ethAddress,
      name: row.displayName?.trim() || `Wallet ${row.ethAddress.slice(2, 6).toUpperCase()}`,
      accountValue: Number(row.accountValue), dayPnl: day.pnl, dayRoi: day.roi,
      dayVolume: day.vlm, weekPnl: week.pnl, monthPnl: month.pnl, monthRoi: month.roi,
      score: walletQuality({ accountValue: Number(row.accountValue), monthPnl: month.pnl, monthVolume: month.vlm, weekPnl: week.pnl, monthRoi: month.roi, dayPnl: day.pnl }),
    };
  }).filter((row): row is typeof row & { score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score).slice(0, 500)
    .map((row, index) => ({ rank: index + 1, address: row.address, name: row.name, accountValue: row.accountValue, dayPnl: row.dayPnl, dayRoi: row.dayRoi, dayVolume: row.dayVolume, weekPnl: row.weekPnl, monthPnl: row.monthPnl, monthRoi: row.monthRoi }));
  leaderboardCache = { expires: Date.now() + 180_000, rows, sourceCount: payload.leaderboardRows.length };
  return { rows: rows.slice(0, limit), sourceCount: payload.leaderboardRows.length };
}

async function getRecentFills(wallets: WalletRow[]) {
  const tracked = [...wallets].sort((a, b) => b.dayVolume - a.dayVolume).slice(0, 10);
  const startTime = Date.now() - 6 * 60 * 60 * 1000;
  const responses = await Promise.allSettled(tracked.map(async (wallet) => {
    const fills = await info<Fill[]>({ type: "userFillsByTime", user: wallet.address, startTime, aggregateByTime: true }, 25);
    return fills.slice(-80).map((fill) => ({ ...fill, wallet: wallet.address, walletName: wallet.name }));
  }));
  return {
    tracked: tracked.map(({ address, name }) => ({ address, name })),
    fills: responses.flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .sort((a, b) => b.time - a.time).slice(0, 120),
  };
}

export async function getDashboardData(): Promise<DashboardData> {
  const warnings: string[] = [];
  const config = await getAdminConfig();
  const [walletsResult, midsResult, metaResult] = await Promise.allSettled([
    getLeaderboard(config.trackedWallets), info<Record<string, string>>({ type: "allMids" }, 15),
    info<[RawMeta, RawAssetContext[]]>({ type: "metaAndAssetCtxs" }, 60),
  ]);
  const wallets = walletsResult.status === "fulfilled" ? walletsResult.value.rows : [];
  const mids = midsResult.status === "fulfilled" ? midsResult.value : {};
  if (walletsResult.status === "rejected") warnings.push("Рейтинг временно недоступен");
  if (midsResult.status === "rejected") warnings.push("Котировки временно недоступны");
  if (metaResult.status === "rejected") warnings.push("Live-охват рынков временно ограничен");
  const pulse = wallets.length ? await getRecentFills(wallets) : { tracked: [], fills: [] };
  const [meta, contexts] = metaResult.status === "fulfilled" ? metaResult.value : [{ universe: [] }, []];
  const liveCoins = (meta.universe ?? []).map((asset, index) => ({ name: asset.name ?? "", volume: Number(contexts[index]?.dayNtlVlm ?? 0) }))
    .filter((asset) => asset.name && !asset.name.includes(":") && !asset.name.startsWith("@") && asset.volume > 0)
    .sort((a, b) => b.volume - a.volume).slice(0, config.liveMarkets).map((asset) => asset.name);
  return {
    wallets, fills: pulse.fills, tracked: pulse.tracked,
    prices: Object.fromEntries(["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"].map((coin) => [coin, Number(mids[coin] ?? 0)])),
    liveCoins, sourceCount: walletsResult.status === "fulfilled" ? walletsResult.value.sourceCount : 0, config,
    updatedAt: Date.now(), warnings,
  };
}

export async function getWalletDetail(address: string): Promise<WalletDetail> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Некорректный адрес кошелька");
  const [state, fills, portfolio] = await Promise.all([
    info<RawState>({ type: "clearinghouseState", user: address }, 20),
    info<Fill[]>({ type: "userFills", user: address, aggregateByTime: true }, 30),
    info<RawPortfolioEntry[]>({ type: "portfolio", user: address }, 60),
  ]);
  const normalizedPortfolio = normalizePerpPortfolio(portfolio);
  const normalizedFills = fills.slice(0, 1_000).map((fill) => ({
    coin: fill.coin, px: fill.px, sz: fill.sz, side: fill.side, time: fill.time,
    dir: fill.dir, closedPnl: fill.closedPnl, fee: fill.fee, hash: fill.hash,
  }));
  return {
    address, accountValue: Number(state.marginSummary?.accountValue ?? 0),
    totalMarginUsed: Number(state.marginSummary?.totalMarginUsed ?? 0), withdrawable: Number(state.withdrawable ?? 0),
    positions: (state.assetPositions ?? []).map(({ position }) => ({
      coin: position.coin, size: Number(position.szi), entryPx: Number(position.entryPx),
      positionValue: Number(position.positionValue), unrealizedPnl: Number(position.unrealizedPnl),
      leverage: Number(position.leverage?.value ?? 1), liquidationPx: position.liquidationPx ? Number(position.liquidationPx) : null,
    })),
    fills: normalizedFills,
    portfolio: normalizedPortfolio,
  };
}
