import "server-only";
import { closedTrades, mergeFills, positionOpenedAt, type ClosedTrade, type Fill } from "./stats";
import { normalizePerpPortfolio, type PortfolioRange, type PortfolioSeries, type RawPortfolioEntry } from "./portfolio";
import { getAdminConfig, type AdminConfig } from "./admin-store";
import { walletQuality } from "./wallet-quality";
import { displayCoin, spotCoinNames, type SpotMeta } from "./live";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
let leaderboardCache: { expires: number; rows: WalletRow[]; sourceCount: number } | undefined;
type WalletFillCache = { fills: Fill[]; recentStart: number; backfillStart: number; complete: boolean; usedAt: number };
const walletFillCache = new Map<string, WalletFillCache>();
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
type RawSpotState = { balances?: { coin: string; token: number; total: string; hold: string; entryNtl?: string }[] };
type RawMeta = { universe?: { name?: string }[] };
type RawAssetContext = { dayNtlVlm?: string };
type RawPerpDex = { name?: string } | null;

export type WalletRow = {
  rank: number; address: string; name: string; accountValue: number; dayPnl: number;
  dayRoi: number; dayVolume: number; weekPnl: number; monthPnl: number; monthRoi: number;
};
export type PulseFill = Fill & { wallet: string; walletName: string; source?: "user" | "market" };
export type CoinFlow = { coin: string; buys: number; sells: number; realizedPnl: number; trades: number; wallets: number };
export type MarketMover = { symbol: string; exchange: "Binance" | "Bybit"; price: number; change: number; volume: number };
export type DashboardData = {
  wallets: WalletRow[]; prices: Record<string, number>; fills: PulseFill[];
  tracked: { address: string; name: string }[]; liveCoins: string[]; sourceCount: number;
  coinNames: Record<string, string>; tradeCoverage: number;
  coinFlow: CoinFlow[]; marketMovers: { gainers: MarketMover[]; losers: MarketMover[] };
  config: AdminConfig; updatedAt: number; warnings: string[];
};
export type Position = {
  coin: string; size: number; entryPx: number; positionValue: number;
  unrealizedPnl: number; leverage: number; liquidationPx: number | null; openedAt: number | null;
};
export type { PortfolioRange, PortfolioSeries } from "./portfolio";
export type WalletDetail = {
  address: string; accountValue: number; totalMarginUsed: number; withdrawable: number;
  positions: Position[]; spotBalances: { coin: string; total: number; hold: number }[]; fills: Fill[]; closedTrades: ClosedTrade[];
  positionHistoryStart: number | null; portfolio: Record<PortfolioRange, PortfolioSeries>; updatedAt: number;
};

async function info<T>(body: Record<string, unknown>, revalidate: number): Promise<T> {
  const response = await fetch(INFO_URL, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    ...(revalidate <= 2 ? { cache: "no-store" as const } : { cache: "force-cache" as const, next: { revalidate } }),
  });
  if (!response.ok) throw new Error(`Hyperliquid API: ${response.status}`);
  return response.json() as Promise<T>;
}

async function getWalletFills(address: string) {
  const key = address.toLowerCase();
  const cached = walletFillCache.get(key);
  if (!cached) {
    const fills = await info<Fill[]>({ type: "userFills", user: address, aggregateByTime: true }, 2);
    const recentStart = fills.length ? Math.min(...fills.map((fill) => fill.time)) : 0;
    const entry = { fills, recentStart, backfillStart: 0, complete: fills.length < 2_000, usedAt: Date.now() };
    walletFillCache.set(key, entry);
    return { fills, analysisFills: fills };
  }

  const latestTime = cached.fills[0]?.time ?? 0;
  const latestPromise = info<Fill[]>({ type: "userFillsByTime", user: address, startTime: latestTime, aggregateByTime: true }, 2);
  const backfillPromise = cached.complete
    ? Promise.resolve<Fill[]>([])
    : info<Fill[]>({ type: "userFillsByTime", user: address, startTime: cached.backfillStart, aggregateByTime: true }, 2);
  const [latest, backfill] = await Promise.all([latestPromise, backfillPromise]);
  const fills = mergeFills(cached.fills, latest, backfill);
  const nextStart = backfill.length ? Math.max(...backfill.map((fill) => fill.time)) : cached.backfillStart;
  const complete = cached.complete || backfill.length < 2_000 || nextStart >= cached.recentStart;
  const entry = { ...cached, fills, backfillStart: nextStart, complete, usedAt: Date.now() };
  walletFillCache.set(key, entry);
  if (walletFillCache.size > 100) {
    const oldest = [...walletFillCache].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]?.[0];
    if (oldest) walletFillCache.delete(oldest);
  }
  return { fills, analysisFills: complete ? fills : fills.filter((fill) => fill.time >= cached.recentStart) };
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

async function getMarketCatalog(limit: number) {
  const [dexesResult, spotResult] = await Promise.allSettled([
    info<RawPerpDex[]>({ type: "perpDexs" }, 3_600),
    info<[SpotMeta, RawAssetContext[]]>({ type: "spotMetaAndAssetCtxs" }, 300),
  ]);
  const dexes = ["", ...(dexesResult.status === "fulfilled" ? dexesResult.value.flatMap((dex) => dex?.name ? [dex.name] : []) : [])];
  const perpResults = await Promise.allSettled(dexes.map((dex) => info<[RawMeta, RawAssetContext[]]>({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) }, 300)));
  const markets = perpResults.flatMap((result) => result.status === "fulfilled"
    ? (result.value[0].universe ?? []).map((asset, index) => ({ name: asset.name ?? "", volume: Number(result.value[1][index]?.dayNtlVlm ?? 0) }))
    : []);
  const [spotMeta, spotContexts] = spotResult.status === "fulfilled" ? spotResult.value : [{ universe: [], tokens: [] }, []];
  markets.push(...(spotMeta.universe ?? []).map((asset, index) => ({ name: asset.name ?? `@${asset.index}`, volume: Number(spotContexts[index]?.dayNtlVlm ?? 0) })));
  const ranked = [...new Map(markets.filter((market) => market.name).map((market) => [market.name, market])).values()]
    .sort((a, b) => b.volume - a.volume).slice(0, limit).map((market) => market.name);
  return { markets: ranked, coinNames: spotCoinNames(spotMeta), partial: dexesResult.status === "rejected" || spotResult.status === "rejected" || perpResults.some((result) => result.status === "rejected") };
}

async function getRecentFills(wallets: WalletRow[], coinNames: Record<string, string>) {
  const tracked = [...wallets].sort((a, b) => b.dayVolume - a.dayVolume).slice(0, 10);
  const startTime = Date.now() - 30 * 60 * 1000;
  const responses = await Promise.allSettled(tracked.map(async (wallet) => {
    const fills = await info<Fill[]>({ type: "userFillsByTime", user: wallet.address, startTime, aggregateByTime: true }, 25);
    return fills.slice(0, 80).map((fill) => ({ ...fill, coin: displayCoin(fill.coin, coinNames), wallet: wallet.address, walletName: wallet.name, source: "user" as const }));
  }));
  return {
    tracked: tracked.map(({ address, name }) => ({ address, name })),
    fills: responses.flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .sort((a, b) => b.time - a.time).slice(0, 120),
  };
}

async function getCoinFlow(wallets: WalletRow[], coinNames: Record<string, string>) {
  const tracked = wallets.slice(0, 5);
  const startTime = Date.now() - 24 * 60 * 60 * 1_000;
  const responses = await Promise.allSettled(tracked.map(async (wallet) => ({
    wallet: wallet.address,
    fills: await info<Fill[]>({ type: "userFillsByTime", user: wallet.address, startTime, aggregateByTime: true }, 120),
  })));
  const rows = new Map<string, { coin: string; buys: number; sells: number; realizedPnl: number; trades: number; wallets: Set<string> }>();
  for (const result of responses) {
    if (result.status !== "fulfilled") continue;
    for (const fill of result.value.fills) {
      const coin = displayCoin(fill.coin, coinNames); const notional = Math.abs(Number(fill.px) * Number(fill.sz));
      const row = rows.get(coin) ?? { coin, buys: 0, sells: 0, realizedPnl: 0, trades: 0, wallets: new Set<string>() };
      if (fill.side === "B") row.buys += notional; else row.sells += notional;
      row.realizedPnl += Number(fill.closedPnl || 0) + Number(fill.fee || 0); row.trades += 1; row.wallets.add(result.value.wallet);
      rows.set(coin, row);
    }
  }
  return [...rows.values()].map((row): CoinFlow => ({ ...row, wallets: row.wallets.size }))
    .sort((a, b) => b.buys + b.sells - a.buys - a.sells).slice(0, 20);
}

const ignoredBases = new Set(["USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDE", "USDD", "PYUSD", "RLUSD", "USD1", "USDH", "USDF", "BUSD", "EUR", "TRY"]);
const validMover = (symbol: string, volume: number) => symbol.endsWith("USDT") && volume >= 1_000_000 && !ignoredBases.has(symbol.slice(0, -4)) && !/(UP|DOWN|BULL|BEAR)$/.test(symbol.slice(0, -4));

async function getMarketMovers() {
  const [binance, bybit] = await Promise.allSettled([
    fetch("https://api.binance.com/api/v3/ticker/24hr", { cache: "force-cache", next: { revalidate: 45 } }).then(async (response) => {
      if (!response.ok) throw new Error(`Binance: ${response.status}`);
      return response.json() as Promise<{ symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[]>;
    }),
    fetch("https://api.bybit.com/v5/market/tickers?category=spot", { cache: "force-cache", next: { revalidate: 45 } }).then(async (response) => {
      if (!response.ok) throw new Error(`Bybit: ${response.status}`);
      return response.json() as Promise<{ result?: { list?: { symbol: string; lastPrice: string; price24hPcnt: string; turnover24h: string }[] } }>;
    }),
  ]);
  const rows: MarketMover[] = [];
  if (binance.status === "fulfilled") rows.push(...binance.value.filter((item) => validMover(item.symbol, Number(item.quoteVolume))).map((item) => ({ symbol: item.symbol.slice(0, -4), exchange: "Binance" as const, price: Number(item.lastPrice), change: Number(item.priceChangePercent), volume: Number(item.quoteVolume) })));
  if (bybit.status === "fulfilled") rows.push(...(bybit.value.result?.list ?? []).filter((item) => validMover(item.symbol, Number(item.turnover24h))).map((item) => ({ symbol: item.symbol.slice(0, -4), exchange: "Bybit" as const, price: Number(item.lastPrice), change: Number(item.price24hPcnt) * 100, volume: Number(item.turnover24h) })));
  const deduped = [...rows.reduce((map, row) => {
    const current = map.get(row.symbol); if (!current || row.volume > current.volume) map.set(row.symbol, row); return map;
  }, new Map<string, MarketMover>()).values()];
  return {
    gainers: deduped.filter((row) => row.change > 0).sort((a, b) => b.change - a.change).slice(0, 20),
    losers: deduped.filter((row) => row.change < 0).sort((a, b) => a.change - b.change).slice(0, 20),
    partial: binance.status === "rejected" || bybit.status === "rejected",
  };
}

export async function getDashboardData(): Promise<DashboardData> {
  const warnings: string[] = [];
  const config = await getAdminConfig();
  const [walletsResult, midsResult, marketsResult] = await Promise.allSettled([
    getLeaderboard(config.trackedWallets), info<Record<string, string>>({ type: "allMids" }, 15),
    getMarketCatalog(config.liveMarkets),
  ]);
  const wallets = walletsResult.status === "fulfilled" ? walletsResult.value.rows : [];
  const mids = midsResult.status === "fulfilled" ? midsResult.value : {};
  if (walletsResult.status === "rejected") warnings.push("Рейтинг временно недоступен");
  if (midsResult.status === "rejected") warnings.push("Котировки временно недоступны");
  const catalog = marketsResult.status === "fulfilled" ? marketsResult.value : { markets: [], coinNames: {}, partial: true };
  if (marketsResult.status === "rejected" || catalog.partial) warnings.push("Часть live-рынков временно недоступна");
  const [pulse, flow, movers] = await Promise.all([
    wallets.length ? getRecentFills(wallets, catalog.coinNames) : Promise.resolve({ tracked: [], fills: [] }),
    wallets.length ? getCoinFlow(wallets, catalog.coinNames) : Promise.resolve([]),
    getMarketMovers().catch(() => ({ gainers: [], losers: [], partial: true })),
  ]);
  if (movers.partial) warnings.push("Часть данных Binance и Bybit временно недоступна");
  return {
    wallets, fills: pulse.fills, tracked: pulse.tracked,
    prices: Object.fromEntries(["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"].map((coin) => [coin, Number(mids[coin] ?? 0)])),
    liveCoins: catalog.markets, coinNames: catalog.coinNames, tradeCoverage: wallets.length,
    coinFlow: flow, marketMovers: { gainers: movers.gainers, losers: movers.losers },
    sourceCount: walletsResult.status === "fulfilled" ? walletsResult.value.sourceCount : 0, config,
    updatedAt: Date.now(), warnings,
  };
}

export async function getWalletDetail(address: string): Promise<WalletDetail> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Некорректный адрес кошелька");
  const [history, portfolio, spotMeta, spotState] = await Promise.all([
    getWalletFills(address),
    info<RawPortfolioEntry[]>({ type: "portfolio", user: address }, 30),
    info<SpotMeta>({ type: "spotMeta" }, 3_600).catch(() => ({ universe: [], tokens: [] })),
    info<RawSpotState>({ type: "spotClearinghouseState", user: address }, 2).catch(() => ({ balances: [] })),
  ]);
  const { fills, analysisFills } = history;
  // shortcut: query only DEXes present in recent fills; all-DEX live updates come from the wallet WebSocket.
  const dexNames = ["", ...new Set(fills.flatMap((fill) => fill.coin.includes(":") ? [fill.coin.split(":", 1)[0]] : []))];
  const stateResults = await Promise.allSettled(dexNames.map((dex) => info<RawState>({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) }, 2)));
  const states = stateResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const coinNames = spotCoinNames(spotMeta);
  const normalizedPortfolio = normalizePerpPortfolio(portfolio);
  const normalizeFill = (fill: Fill): Fill => ({
    coin: displayCoin(fill.coin, coinNames), px: fill.px, sz: fill.sz, side: fill.side, time: fill.time,
    dir: fill.dir, closedPnl: fill.closedPnl, fee: fill.fee, hash: fill.hash, tid: fill.tid, startPosition: fill.startPosition,
  });
  const normalizedFills = fills.map(normalizeFill);
  const normalizedAnalysisFills = analysisFills.map(normalizeFill);
  const positions = states.flatMap((state) => state.assetPositions ?? []).map(({ position }) => ({
    coin: displayCoin(position.coin, coinNames), size: Number(position.szi), entryPx: Number(position.entryPx), openedAt: positionOpenedAt(Number(position.szi), position.coin, analysisFills),
    positionValue: Number(position.positionValue), unrealizedPnl: Number(position.unrealizedPnl),
    leverage: Number(position.leverage?.value ?? 1), liquidationPx: position.liquidationPx ? Number(position.liquidationPx) : null,
  })).filter((position) => position.size).sort((a, b) => Math.abs(b.positionValue) - Math.abs(a.positionValue));
  return {
    address, accountValue: states.reduce((sum, state) => sum + Number(state.marginSummary?.accountValue ?? 0), 0),
    totalMarginUsed: states.reduce((sum, state) => sum + Number(state.marginSummary?.totalMarginUsed ?? 0), 0), withdrawable: states.reduce((sum, state) => sum + Number(state.withdrawable ?? 0), 0),
    positions,
    spotBalances: (spotState.balances ?? []).map((balance) => ({ coin: balance.coin, total: Number(balance.total), hold: Number(balance.hold) })).filter((balance) => balance.total || balance.hold).sort((a, b) => b.total - a.total),
    fills: normalizedFills.slice(0, 1_000), closedTrades: closedTrades(normalizedAnalysisFills).slice(0, 50),
    positionHistoryStart: analysisFills.length ? Math.min(...analysisFills.map((fill) => fill.time)) : null,
    portfolio: normalizedPortfolio, updatedAt: Date.now(),
  };
}
