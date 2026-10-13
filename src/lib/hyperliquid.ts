import "server-only";
import { closedTrades, mergeFillHistoryPage, mergeFills, positionOpenedAt, type ClosedTrade, type Fill } from "./stats";
import { normalizePerpPortfolio, type PortfolioRange, type PortfolioSeries, type RawPortfolioEntry } from "./portfolio";
import { getAdminConfig, type AdminConfig } from "./admin-store";
import { hasPositiveMonthPnl, walletQuality } from "./wallet-quality";
import { displayCoin, mergePulseFills, spotCoinNames, type SpotMeta } from "./live";
import { copyabilityScore, type CopyabilityAnalysis } from "./copyability";
import { baseMarketSymbol, coinFlowChange, coinParticipants, type CoinParticipant } from "./coin-intelligence";
import { fetchWithRetry } from "./fetch-retry";
import {
  coinJournal, copySamplesForWallet, currentPositionCoverage, latestCoinSnapshots, recentJournal, recordCompletedTrades, recordFundingEvents, recordOrderEvents,
  recordPositionSnapshots, recordWalletEvent, walletCompletedTrades, walletFunding, walletJournal, walletOrders,
  type FundingEvent, type JournalEvent, type OrderEvent,
} from "./event-store";
import { availableWalletScreenings } from "./wallet-registry";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
let leaderboardCache: { expires: number; rows: WalletRow[]; sourceCount: number } | undefined;
let marketMoversCache: { expires: number; value: { gainers: MarketMover[]; losers: MarketMover[]; partial: boolean; positionCoverage: number } } | undefined;
type WalletFillCache = { fills: Fill[]; complete: boolean; usedAt: number };
const walletFillCache = new Map<string, WalletFillCache>();
const infoFallbackCache = new Map<string, { value: unknown; storedAt: number }>();
let infoFallbackHits = 0;
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
type RawAssetContext = { dayNtlVlm?: string; markPx?: string; oraclePx?: string; openInterest?: string; funding?: string; prevDayPx?: string };
type RawPerpDex = { name?: string } | null;
type RawOrder = { order?: { coin?: string; side?: string; limitPx?: string; sz?: string; oid?: number; timestamp?: number; origSz?: string; orderType?: unknown; reduceOnly?: boolean }; status?: string; statusTimestamp?: number };
type RawFunding = { time?: number; hash?: string; delta?: { coin?: string; usdc?: string; szi?: string; fundingRate?: string } };
type RawLedger = { time?: number; hash?: string; delta?: { type?: string; token?: string; amount?: string; usdcValue?: string } };
type RawCandle = { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number };

export type WalletRow = {
  rank: number; address: string; name: string; accountValue: number; dayPnl: number;
  dayRoi: number; dayVolume: number; weekPnl: number; monthPnl: number; monthRoi: number; qualityScore?: number;
  winRate60d?: number; trades60d?: number; netPnl60d?: number; vettedAt?: number;
};
export type PulseFill = Fill & { wallet: string; walletName: string; source?: "user" | "market" };
export type CoinFlow = { coin: string; buys: number; sells: number; realizedPnl: number; trades: number; wallets: number };
export type MarketMover = {
  symbol: string; exchange: "Binance" | "Bybit"; price: number; change: number; volume: number;
  wallets: number; longWallets: number; shortWallets: number; longNotional: number; shortNotional: number; positionUpdatedAt: number;
};
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
  openedAtPrecision?: "reconstructed" | "unknown";
};
export type WalletDataQuality = { updatedAt: number; source: string; historyComplete: boolean; oldestFill: number | null; journalEvents: number; exactFills: number; ordersCaptured: number; fundingCaptured: number };
export type { PortfolioRange, PortfolioSeries } from "./portfolio";
export type WalletDetail = {
  address: string; accountValue: number; totalMarginUsed: number; withdrawable: number;
  positions: Position[]; spotBalances: { coin: string; total: number; hold: number }[]; fills: Fill[]; closedTrades: ClosedTrade[];
  positionHistoryStart: number | null; positionHistoryComplete: boolean; portfolio: Record<PortfolioRange, PortfolioSeries>; updatedAt: number;
  copyability: CopyabilityAnalysis; journal: JournalEvent[]; orders: OrderEvent[]; funding: FundingEvent[]; dataQuality: WalletDataQuality;
};
export type CoinDetail = {
  coin: string; markPx: number; oraclePx: number; change24h: number; volume24h: number; openInterest: number; funding: number;
  candles: Array<{ time: number; open: number; close: number; high: number; low: number; volume: number }>;
  events: JournalEvent[]; snapshots: ReturnType<typeof latestCoinSnapshots>;
  participants: CoinParticipant[]; hasPerpMarket: boolean;
  changes: Record<"5m" | "1h" | "4h" | "24h", { long: number; short: number; net: number; wallets: number }>;
  updatedAt: number; source: string;
};

async function info<T>(body: Record<string, unknown>, revalidate: number): Promise<T> {
  const serialized = JSON.stringify(body); const key = `${revalidate}:${serialized}`;
  try {
    const response = await fetchWithRetry(() => fetch(INFO_URL, {
      method: "POST", headers: { "content-type": "application/json" }, body: serialized,
      ...(revalidate <= 2 ? { cache: "no-store" as const } : { cache: "force-cache" as const, next: { revalidate } }),
    }));
    if (!response.ok) throw new Error(`Hyperliquid API: ${response.status}`);
    const value = await response.json() as T;
    if (!["userFills", "userFillsByTime", "historicalOrders", "userFunding", "userNonFundingLedgerUpdates"].includes(String(body.type))) {
      infoFallbackCache.set(key, { value, storedAt: Date.now() });
      if (infoFallbackCache.size > 200) infoFallbackCache.delete(infoFallbackCache.keys().next().value!);
    }
    return value;
  } catch (error) {
    const fallback = infoFallbackCache.get(key);
    if (fallback && Date.now() - fallback.storedAt <= 300_000) { infoFallbackHits += 1; return fallback.value as T; }
    throw error;
  }
}

async function getWalletFills(address: string) {
  const key = address.toLowerCase();
  const cached = walletFillCache.get(key);
  if (!cached) {
    let fills = await info<Fill[]>({ type: "userFills", user: address, aggregateByTime: true }, 2);
    let complete = fills.length < 2_000;
    for (let page = 1; page < 5 && !complete && fills.length < 10_000; page++) {
      const oldest = Math.min(...fills.map((fill) => fill.time));
      const older = await info<Fill[]>({ type: "userFillsByTime", user: address, startTime: 0, endTime: oldest - 1, aggregateByTime: true }, 2).catch(() => null);
      if (!older) break;
      const progress = mergeFillHistoryPage(fills, older); fills = progress.fills; complete = progress.complete;
      if (!progress.progressed) break;
    }
    const entry = { fills, complete, usedAt: Date.now() };
    walletFillCache.set(key, entry);
    return { fills, analysisFills: fills, complete: entry.complete };
  }

  const latestTime = cached.fills[0]?.time ?? 0;
  const latest = await info<Fill[]>({ type: "userFillsByTime", user: address, startTime: latestTime, aggregateByTime: true }, 2).catch(() => []);
  const fills = mergeFills(cached.fills, latest);
  const entry = { ...cached, fills, usedAt: Date.now() };
  walletFillCache.set(key, entry);
  if (walletFillCache.size > 100) {
    const oldest = [...walletFillCache].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]?.[0];
    if (oldest) walletFillCache.delete(oldest);
  }
  return { fills, analysisFills: fills, complete: entry.complete };
}

function performance(row: RawLeaderboardRow, name: WindowName) {
  const value = row.windowPerformances.find(([window]) => window === name)?.[1];
  return { pnl: Number(value?.pnl ?? 0), roi: Number(value?.roi ?? 0) * 100, vlm: Number(value?.vlm ?? 0) };
}

async function getLeaderboard(limit: number) {
  if (leaderboardCache && leaderboardCache.expires > Date.now()) return { rows: leaderboardCache.rows.slice(0, limit), sourceCount: leaderboardCache.sourceCount };
  const response = await fetch(LEADERBOARD_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Leaderboard: ${response.status}`);
  const payload = await response.json() as { leaderboardRows: RawLeaderboardRow[] };
  const candidates = payload.leaderboardRows.map((row) => {
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
  });
  const verified = availableWalletScreenings(); const verifiedByAddress = new Map(verified.map((row) => [row.address, row]));
  const candidateByAddress = new Map(candidates.map((row) => [row.address.toLowerCase(), row]));
  const selected = verified.flatMap((screening) => {
    const row = candidateByAddress.get(screening.address); return row && hasPositiveMonthPnl(row.monthPnl) ? [{ ...row, score: row.score ?? screening.score }] : [];
  }).slice(0, 1_000);
  const rows = selected.map((row, index, all) => {
      const low = all.at(-1)?.score ?? row.score; const high = all[0]?.score ?? row.score;
      const qualityScore = high === low ? 50 : Math.round(40 + (row.score - low) / (high - low) * 60);
      const screening = verifiedByAddress.get(row.address.toLowerCase());
      return { rank: index + 1, address: row.address, name: row.name, accountValue: row.accountValue, dayPnl: row.dayPnl, dayRoi: row.dayRoi, dayVolume: row.dayVolume, weekPnl: row.weekPnl, monthPnl: row.monthPnl, monthRoi: row.monthRoi, qualityScore,
        ...(screening ? { winRate60d: screening.winRate, trades60d: screening.trades, netPnl60d: screening.netPnl, vettedAt: screening.screenedAt } : {}) };
    });
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
  const startTime = Date.now() - 24 * 60 * 60 * 1_000;
  const responses = await Promise.allSettled(tracked.map(async (wallet) => {
    const fills = await info<Fill[]>({ type: "userFillsByTime", user: wallet.address, startTime, aggregateByTime: true }, 25);
    return fills.slice(0, 120).map((fill) => ({ ...fill, coin: displayCoin(fill.coin, coinNames), wallet: wallet.address, walletName: wallet.name, source: "user" as const }));
  }));
  const names = new Map(wallets.map((wallet) => [wallet.address.toLowerCase(), wallet.name]));
  const journalFills = recentJournal(startTime, 10_000).flatMap((event): PulseFill[] => {
    const wallet = event.wallet.toLowerCase(); const walletName = names.get(wallet);
    if (!walletName || !event.price || !event.size) return [];
    const reducing = ["REDUCE", "CLOSE"].includes(event.action);
    const side: "A" | "B" = event.action === "BUY" ? "B" : event.action === "SELL" ? "A"
      : event.direction === "LONG" ? (reducing ? "A" : "B") : (reducing ? "B" : "A");
    return [{ coin: event.coin, px: String(event.price), sz: String(event.size), side, time: event.time,
      dir: `${event.action} ${event.direction ?? ""}`.trim(), closedPnl: String(event.realizedPnl ?? 0), fee: String(event.fee ?? 0),
      hash: event.hash ?? event.eventKey, tid: event.tid, startPosition: event.beforeSize === undefined ? undefined : String(event.beforeSize),
      wallet, walletName, source: event.precision === "observed" ? "market" : "user" }];
  });
  const apiFills = responses.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  return {
    tracked: tracked.map(({ address, name }) => ({ address, name })),
    fills: mergePulseFills(apiFills, journalFills),
  };
}

async function getCoinFlow(wallets: WalletRow[], coinNames: Record<string, string>) {
  const startTime = Date.now() - 24 * 60 * 60 * 1_000;
  const tracked = new Set(wallets.map((wallet) => wallet.address.toLowerCase()));
  const events = recentJournal(startTime, 100_000).filter((event) => tracked.has(event.wallet));
  const rows = new Map<string, { coin: string; buys: number; sells: number; realizedPnl: number; trades: number; wallets: Set<string> }>();
  for (const event of events) {
    const coin = displayCoin(event.coin, coinNames); const notional = Math.abs(event.notional ?? Number(event.price ?? 0) * Number(event.size ?? 0));
    const row = rows.get(coin) ?? { coin, buys: 0, sells: 0, realizedPnl: 0, trades: 0, wallets: new Set<string>() };
    const reducing = ["REDUCE", "CLOSE"].includes(event.action);
    const buy = event.action === "BUY" || (event.action !== "SELL" && (event.direction === "LONG") !== reducing);
    if (buy) row.buys += notional; else row.sells += notional;
    row.realizedPnl += Number(event.realizedPnl ?? 0) + Number(event.fee ?? 0); row.trades += 1; row.wallets.add(event.wallet);
    rows.set(coin, row);
  }
  return [...rows.values()].map((row): CoinFlow => ({ ...row, wallets: row.wallets.size }))
    .sort((a, b) => b.buys + b.sells - a.buys - a.sells).slice(0, 20);
}

const ignoredBases = new Set(["USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDE", "USDD", "PYUSD", "RLUSD", "USD1", "USDH", "USDF", "BUSD", "EUR", "TRY"]);
const validMover = (symbol: string, volume: number) => symbol.endsWith("USDT") && volume >= 1_000_000 && !ignoredBases.has(symbol.slice(0, -4)) && !/(UP|DOWN|BULL|BEAR)$/.test(symbol.slice(0, -4));

async function getMarketMovers() {
  if (marketMoversCache && marketMoversCache.expires > Date.now()) return marketMoversCache.value;
  const [binance, bybit] = await Promise.allSettled([
    fetch("https://api.binance.com/api/v3/ticker/24hr", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Binance: ${response.status}`);
      return response.json() as Promise<{ symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[]>;
    }),
    fetch("https://api.bybit.com/v5/market/tickers?category=spot", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Bybit: ${response.status}`);
      return response.json() as Promise<{ result?: { list?: { symbol: string; lastPrice: string; price24hPcnt: string; turnover24h: string }[] } }>;
    }),
  ]);
  const coverage = new Map<string, Omit<MarketMover, "symbol" | "exchange" | "price" | "change" | "volume">>();
  for (const row of currentPositionCoverage()) {
    const symbol = baseMarketSymbol(row.coin); const previous = coverage.get(symbol);
    coverage.set(symbol, previous ? { wallets: previous.wallets + row.wallets, longWallets: previous.longWallets + row.longWallets,
      shortWallets: previous.shortWallets + row.shortWallets, longNotional: previous.longNotional + row.longNotional,
      shortNotional: previous.shortNotional + row.shortNotional, positionUpdatedAt: Math.max(previous.positionUpdatedAt, row.updatedAt) }
      : { wallets: row.wallets, longWallets: row.longWallets, shortWallets: row.shortWallets, longNotional: row.longNotional,
        shortNotional: row.shortNotional, positionUpdatedAt: row.updatedAt });
  }
  const rows: MarketMover[] = [];
  const mover = (symbol: string, exchange: "Binance" | "Bybit", price: number, change: number, volume: number) => {
    const positions = coverage.get(symbol) ?? { wallets: 0, longWallets: 0, shortWallets: 0, longNotional: 0, shortNotional: 0, positionUpdatedAt: 0 };
    return { symbol, exchange, price, change, volume, ...positions };
  };
  if (binance.status === "fulfilled") rows.push(...binance.value.filter((item) => validMover(item.symbol, Number(item.quoteVolume))).map((item) =>
    mover(item.symbol.slice(0, -4), "Binance", Number(item.lastPrice), Number(item.priceChangePercent), Number(item.quoteVolume))));
  if (bybit.status === "fulfilled") rows.push(...(bybit.value.result?.list ?? []).filter((item) => validMover(item.symbol, Number(item.turnover24h))).map((item) =>
    mover(item.symbol.slice(0, -4), "Bybit", Number(item.lastPrice), Number(item.price24hPcnt) * 100, Number(item.turnover24h))));
  const deduped = [...rows.reduce((map, row) => {
    const current = map.get(row.symbol); if (!current || row.volume > current.volume) map.set(row.symbol, row); return map;
  }, new Map<string, MarketMover>()).values()];
  const value = {
    gainers: deduped.filter((row) => row.change > 0).sort((a, b) => b.change - a.change).slice(0, 20),
    losers: deduped.filter((row) => row.change < 0).sort((a, b) => a.change - b.change).slice(0, 20),
    partial: binance.status === "rejected" || bybit.status === "rejected",
    positionCoverage: coverage.size,
  };
  marketMoversCache = { expires: Date.now() + 45_000, value }; return value;
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
    getMarketMovers().catch(() => ({ gainers: [], losers: [], partial: true, positionCoverage: 0 })),
  ]);
  if (movers.partial) warnings.push("Часть данных Binance и Bybit временно недоступна");
  if (!movers.positionCoverage) warnings.push("Нет свежих снимков позиций для сопоставления с движением рынка");
  return {
    wallets, fills: pulse.fills, tracked: pulse.tracked,
    prices: Object.fromEntries(["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"].map((coin) => [coin, Number(mids[coin] ?? 0)])),
    liveCoins: catalog.markets, coinNames: catalog.coinNames, tradeCoverage: wallets.length,
    coinFlow: flow, marketMovers: { gainers: movers.gainers, losers: movers.losers },
    sourceCount: walletsResult.status === "fulfilled" ? walletsResult.value.sourceCount : 0, config,
    updatedAt: Date.now(), warnings,
  };
}

function fillLifecycle(fill: Fill) {
  const before = Number(fill.startPosition); const delta = Number(fill.sz) * (fill.side === "B" ? 1 : -1);
  if (!Number.isFinite(before)) return { action: fill.side === "B" ? "BUY" : "SELL", direction: fill.side === "B" ? "LONG" : "SHORT", after: undefined, precision: "observed" as const };
  const after = Math.abs(before + delta) < 1e-9 ? 0 : before + delta;
  const action = before === 0 ? "OPEN" : after === 0 ? "CLOSE" : Math.sign(before) !== Math.sign(after) ? "FLIP" : Math.abs(after) > Math.abs(before) ? "ADD" : "REDUCE";
  return { action, direction: (after || before) > 0 ? "LONG" : "SHORT", after, precision: "exact" as const };
}

const eventKey = (wallet: string, fill: Fill) => `${wallet.toLowerCase()}:${fill.hash}:${fill.tid ?? `${fill.coin}:${fill.time}:${fill.side}:${fill.sz}`}`;

export async function getWalletDetail(address: string): Promise<WalletDetail> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Некорректный адрес кошелька");
  const now = Date.now(); const fallbackStart = infoFallbackHits;
  const [history, portfolio, spotMeta, spotState, rawOrders, rawFunding, rawLedger, perpDexes] = await Promise.all([
    getWalletFills(address),
    info<RawPortfolioEntry[]>({ type: "portfolio", user: address }, 30).catch(() => []),
    info<SpotMeta>({ type: "spotMeta" }, 3_600).catch(() => ({ universe: [], tokens: [] })),
    info<RawSpotState>({ type: "spotClearinghouseState", user: address }, 2).catch(() => ({ balances: [] })),
    info<RawOrder[]>({ type: "historicalOrders", user: address }, 30).catch(() => []),
    info<RawFunding[]>({ type: "userFunding", user: address, startTime: now - 30 * 86_400_000 }, 30).catch(() => []),
    info<RawLedger[]>({ type: "userNonFundingLedgerUpdates", user: address, startTime: now - 30 * 86_400_000 }, 30).catch(() => []),
    info<RawPerpDex[]>({ type: "perpDexs" }, 300).catch(() => []),
  ]);
  const { fills, analysisFills } = history;
  const dexNames = ["", ...perpDexes.flatMap((dex) => dex?.name ? [dex.name] : [])];
  const [stateResults, contextResults] = await Promise.all([
    Promise.allSettled(dexNames.map((dex) => info<RawState>({ type: "clearinghouseState", user: address, ...(dex ? { dex } : {}) }, 2))),
    Promise.allSettled(dexNames.map((dex) => info<[RawMeta, RawAssetContext[]]>({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) }, 15))),
  ]);
  const states = stateResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const coinNames = spotCoinNames(spotMeta);
  const normalizedPortfolio = normalizePerpPortfolio(portfolio);
  const normalizeFill = (fill: Fill): Fill => ({
    coin: displayCoin(fill.coin, coinNames), px: fill.px, sz: fill.sz, side: fill.side, time: fill.time,
    dir: fill.dir, closedPnl: fill.closedPnl, fee: fill.fee, hash: fill.hash, tid: fill.tid, startPosition: fill.startPosition,
    crossed: fill.crossed, feeToken: fill.feeToken, source: "user",
  });
  const normalizedFills = fills.map(normalizeFill);
  const normalizedAnalysisFills = analysisFills.map(normalizeFill);
  const positions = states.flatMap((state) => state.assetPositions ?? []).map(({ position }) => {
    const openedAt = positionOpenedAt(Number(position.szi), position.coin, analysisFills);
    return {
    coin: displayCoin(position.coin, coinNames), size: Number(position.szi), entryPx: Number(position.entryPx), openedAt, openedAtPrecision: openedAt ? "reconstructed" as const : "unknown" as const,
    positionValue: Number(position.positionValue), unrealizedPnl: Number(position.unrealizedPnl),
    leverage: Number(position.leverage?.value ?? 1), liquidationPx: position.liquidationPx ? Number(position.liquidationPx) : null,
  }; }).filter((position) => position.size).sort((a, b) => Math.abs(b.positionValue) - Math.abs(a.positionValue));
  const marketVolumes = Object.fromEntries(contextResults.flatMap((result) => result.status === "fulfilled"
    ? (result.value[0].universe ?? []).map((asset, index) => [displayCoin(asset.name ?? "", coinNames), Number(result.value[1][index]?.dayNtlVlm ?? 0)]) : []));
  for (const fill of normalizedFills) {
    const lifecycle = fillLifecycle(fill);
    recordWalletEvent({ eventKey: eventKey(address, fill), wallet: address, coin: fill.coin, action: lifecycle.action, direction: lifecycle.direction,
      time: fill.time, price: Number(fill.px), size: Number(fill.sz), notional: Math.abs(Number(fill.px) * Number(fill.sz)),
      beforeSize: Number.isFinite(Number(fill.startPosition)) ? Number(fill.startPosition) : undefined, afterSize: lifecycle.after,
      fee: Number(fill.fee || 0), realizedPnl: Number(fill.closedPnl || 0), source: "Hyperliquid userFills", precision: lifecycle.precision,
      hash: fill.hash, tid: fill.tid });
  }
  recordPositionSnapshots(positions.map((position) => ({ wallet: address, coin: position.coin, capturedAt: now, size: position.size, entryPx: position.entryPx,
    positionValue: position.positionValue, unrealizedPnl: position.unrealizedPnl, leverage: position.leverage, liquidationPx: position.liquidationPx,
    marginUsed: Math.abs(position.positionValue) / Math.max(1, position.leverage), source: "Hyperliquid clearinghouseState" })));
  const orders: OrderEvent[] = rawOrders.slice(0, 500).flatMap((row) => row.order?.coin ? [{
    eventKey: `${address.toLowerCase()}:order:${row.order.oid ?? "unknown"}:${row.status ?? "unknown"}:${row.statusTimestamp ?? row.order.timestamp ?? 0}`,
    wallet: address, coin: displayCoin(row.order.coin, coinNames), side: row.order.side ?? "—", status: row.status ?? "unknown",
    kind: typeof row.order.orderType === "string" ? row.order.orderType : row.order.reduceOnly ? "reduce-only" : "limit",
    limitPx: Number(row.order.limitPx ?? 0), size: Number(row.order.origSz ?? row.order.sz ?? 0),
    time: Number(row.statusTimestamp ?? row.order.timestamp ?? 0), source: "Hyperliquid historicalOrders",
  }] : []);
  const funding: FundingEvent[] = rawFunding.slice(0, 1_000).flatMap((row) => row.delta?.coin && row.time ? [{
    eventKey: `${address.toLowerCase()}:funding:${row.hash ?? `${row.delta.coin}:${row.time}`}`, wallet: address,
    coin: displayCoin(row.delta.coin, coinNames), time: row.time, amount: Number(row.delta.usdc ?? 0), rate: Number(row.delta.fundingRate ?? 0),
    size: Number(row.delta.szi ?? 0), source: "Hyperliquid userFunding",
  }] : []);
  recordOrderEvents(orders); recordFundingEvents(funding);
  for (const row of rawLedger) if (row.time && row.delta?.type) recordWalletEvent({
    eventKey: `${address.toLowerCase()}:ledger:${row.hash ?? `${row.delta.type}:${row.time}`}`, wallet: address,
    coin: displayCoin(row.delta.token ?? "USDC", coinNames), action: `LEDGER ${row.delta.type.replaceAll(/([a-z])([A-Z])/g, "$1 $2").toUpperCase()}`,
    time: row.time, size: Number(row.delta.amount ?? 0), notional: Math.abs(Number(row.delta.usdcValue ?? row.delta.amount ?? 0)),
    source: "Hyperliquid userNonFundingLedgerUpdates", precision: "exact", hash: row.hash,
  });
  const storedOrders = walletOrders(address, 500); const storedFunding = walletFunding(address, 1_000);
  const journal = [...new Map([
    ...walletJournal(address, 1_000),
    ...storedOrders.slice(0, 100).map((order): JournalEvent => ({ eventKey: order.eventKey, wallet: address, coin: order.coin, action: `ORDER ${order.status.toUpperCase()}`, direction: order.side, time: order.time, price: order.limitPx, size: order.size, notional: order.limitPx * order.size, source: order.source, precision: "exact" })),
    ...storedFunding.slice(0, 100).map((row): JournalEvent => ({ eventKey: row.eventKey, wallet: address, coin: row.coin, action: "FUNDING", time: row.time, realizedPnl: row.amount, source: row.source, precision: "exact" })),
  ].map((event) => [event.eventKey, event] as const)).values()].sort((left, right) => right.time - left.time).slice(0, 1_000);
  const calculatedTrades = closedTrades(normalizedAnalysisFills).slice(0, 500); recordCompletedTrades(address, calculatedTrades);
  const completedTrades = [...new Map([...calculatedTrades, ...walletCompletedTrades(address)].map((trade) => [`${trade.coin}:${trade.direction}:${trade.closedAt}`, trade])).values()]
    .sort((left, right) => right.closedAt - left.closedAt).slice(0, 500);
  const copyability = copyabilityScore({ fills: normalizedFills, closedTrades: completedTrades, accountValue: normalizedPortfolio.month.accountValue, marketVolumes, samples: copySamplesForWallet(address) });
  const updatedAt = Date.now();
  return {
    address, accountValue: states.reduce((sum, state) => sum + Number(state.marginSummary?.accountValue ?? 0), 0),
    totalMarginUsed: states.reduce((sum, state) => sum + Number(state.marginSummary?.totalMarginUsed ?? 0), 0), withdrawable: states.reduce((sum, state) => sum + Number(state.withdrawable ?? 0), 0),
    positions,
    spotBalances: (spotState.balances ?? []).map((balance) => ({ coin: balance.coin, total: Number(balance.total), hold: Number(balance.hold) })).filter((balance) => balance.total || balance.hold).sort((a, b) => b.total - a.total),
    fills: normalizedFills.slice(0, 1_000), closedTrades: completedTrades.slice(0, 50),
    positionHistoryStart: analysisFills.length ? Math.min(...analysisFills.map((fill) => fill.time)) : null,
    positionHistoryComplete: history.complete,
    portfolio: normalizedPortfolio, updatedAt, copyability, journal, orders: storedOrders, funding: storedFunding,
    dataQuality: { updatedAt, source: infoFallbackHits > fallbackStart ? "Hyperliquid API · резерв из кеша до 5 минут" : "Hyperliquid public API", historyComplete: history.complete,
      oldestFill: analysisFills.length ? Math.min(...analysisFills.map((fill) => fill.time)) : null,
      journalEvents: journal.length, exactFills: normalizedFills.filter((fill) => Number.isFinite(Number(fill.startPosition))).length,
      ordersCaptured: storedOrders.length, fundingCaptured: storedFunding.length },
  };
}

export async function getCoinDetail(coin: string): Promise<CoinDetail> {
  const safeCoin = decodeURIComponent(coin); const rawCoin = safeCoin.includes(":") ? safeCoin.slice(safeCoin.indexOf(":") + 1) : safeCoin;
  const endTime = Date.now(); const startTime = endTime - 7 * 86_400_000;
  const dexes = await info<RawPerpDex[]>({ type: "perpDexs" }, 300).catch(() => []);
  const names = ["", ...dexes.flatMap((row) => row?.name ? [row.name] : [])];
  const contexts = await Promise.allSettled(names.map((dex) => info<[RawMeta, RawAssetContext[]]>({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) }, 15)));
  const found = contexts.flatMap((result, dexIndex) => result.status === "fulfilled" ? (result.value[0].universe ?? []).flatMap((asset, index) => {
    const name = asset.name ?? ""; return name === safeCoin || name === rawCoin || name.split(":").at(-1) === rawCoin ? [{ name, dex: names[dexIndex], market: result.value[1][index] ?? {} }] : [];
  }) : [])[0];
  const movers = found ? null : await getMarketMovers().catch(() => null);
  const spot = [...(movers?.gainers ?? []), ...(movers?.losers ?? [])].find((row) => row.symbol === rawCoin);
  const resolvedCoin = found?.name ?? safeCoin;
  const candles = found ? await info<RawCandle[]>({ type: "candleSnapshot", req: { coin: resolvedCoin, interval: "15m", startTime, endTime } }, 15).catch(() => []) : [];
  const market = found?.market ?? {}; const markPx = Number(market.markPx ?? spot?.price ?? 0); const previous = Number(market.prevDayPx ?? (spot?.change ? markPx / (1 + spot.change / 100) : markPx));
  const aliases = [...new Set([safeCoin, rawCoin, resolvedCoin])];
  const events = [...new Map(aliases.flatMap((name) => coinJournal(name, endTime - 86_400_000)).map((event) => [event.eventKey, event])).values()].sort((left, right) => right.time - left.time);
  const snapshots = aliases.flatMap((name) => latestCoinSnapshots(name));
  const participants = coinParticipants(events, snapshots, endTime);
  const windows = { "5m": 300_000, "1h": 3_600_000, "4h": 14_400_000, "24h": 86_400_000 } as const;
  const changes = Object.fromEntries(Object.entries(windows).map(([label, duration]) => [label, coinFlowChange(events, endTime, duration)])) as CoinDetail["changes"];
  return { coin: rawCoin, markPx, oraclePx: Number(market.oraclePx ?? 0), change24h: spot?.change ?? (previous ? (markPx - previous) / previous * 100 : 0),
    volume24h: Number(market.dayNtlVlm ?? spot?.volume ?? 0), openInterest: Number(market.openInterest ?? 0), funding: Number(market.funding ?? 0),
    candles: candles.map((row) => ({ time: row.t, open: Number(row.o), close: Number(row.c), high: Number(row.h), low: Number(row.l), volume: Number(row.v) })),
    events, snapshots, participants, hasPerpMarket: Boolean(found), changes, updatedAt: endTime,
    source: found ? `Hyperliquid ${found.dex || "main"} + Deep Current journal` : `${spot?.exchange ?? "Spot"} market + Deep Current journal` };
}
