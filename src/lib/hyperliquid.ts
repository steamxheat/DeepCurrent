import "server-only";
import { feeInUsd, type ClosedTrade, type Fill } from "./stats";
import { getFillJournal } from "./fill-journal";
import { readWalletSnapshot } from "./wallet-snapshot";
import { normalizePerpPortfolio, type PortfolioRange, type PortfolioSeries, type RawPortfolioEntry } from "./portfolio";
import { getAdminConfig, type AdminConfig } from "./admin-store";
import { hasPositiveMonthPnl, walletQuality } from "./wallet-quality";
import { displayCoin } from "./live";
import { copyabilityScore, type CopyabilityAnalysis } from "./copyability";
import { baseMarketSymbol, coinFlowChange, coinParticipants, type CoinParticipant } from "./coin-intelligence";
import { fetchWithRetry } from "./fetch-retry";
import { coinCandleRequest, findCoinMarket } from "./coin-market";
import {
  walletFunding, walletOrders,
  type FundingEvent, type JournalEvent, type OrderEvent,
} from "./event-store";
import { availableWalletScreenings } from "./wallet-registry";

const INFO_URL = "https://api.hyperliquid.xyz/info";
let leaderboardCache: { expires: number; rows: WalletRow[]; sourceCount: number } | undefined;
let marketMoversCache: { expires: number; value: { gainers: MarketMover[]; losers: MarketMover[]; partial: boolean; positionCoverage: number } } | undefined;
let dashboardCache: { expires: number; value: DashboardData } | undefined;
let dashboardPending: Promise<DashboardData> | undefined;
const detailCache = new Map<string, { expires: number; value: WalletDetail }>();
const infoFallbackCache = new Map<string, { value: unknown; storedAt: number }>();
type WindowName = "day" | "week" | "month" | "allTime";
type WindowPerformance = [WindowName, { pnl: string; roi: string; vlm: string }];
type RawLeaderboardRow = { ethAddress: string; accountValue: string; windowPerformances: WindowPerformance[]; displayName?: string | null };
type RawSpotState = { balances?: { coin: string; token: number; total: string; hold: string; entryNtl?: string }[] };
type RawCandle = { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number };

export type WalletRow = {
  rank: number; address: string; name: string; accountValue: number; dayPnl: number;
  dayRoi: number; dayVolume: number; weekPnl: number; monthPnl: number; monthRoi: number; qualityScore?: number;
  winRate60d?: number; trades60d?: number; netPnl60d?: number; vettedAt?: number;
};
export type FillEvidence = { action?: string; direction?: string; receivedAt?: number; positionStatus?: "open" | "closed" | "absent" | "unknown"; openedAt?: number | null; closedAt?: number; netPnl?: number | null; leverage?: number; checkedAt?: number; reason?: string };
export type PulseFill = Fill & FillEvidence & { wallet: string; walletName: string; source?: "user" | "market" };
export type CoinFlow = { coin: string; buys: number; sells: number; realizedPnl: number | null; trades: number; wallets: number };
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
  marginUsed?: number;
  initialSize?: number | null; lastChangedAt?: number | null; updatedAt?: number; source?: string; reason?: string;
  lastAction?: string;
};
export type WalletDataQuality = { updatedAt: number; source: string; historyComplete: boolean; oldestFill: number | null; journalEvents: number; exactFills: number; ordersCaptured: number; fundingCaptured: number; unavailableScopes?: string[]; pending?: boolean };
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
  events: JournalEvent[]; snapshots: ReturnType<ReturnType<typeof getFillJournal>["currentSnapshots"]>;
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
    if (fallback && Date.now() - fallback.storedAt <= 300_000) return fallback.value as T;
    throw error;
  }
}


function performance(row: RawLeaderboardRow, name: WindowName) {
  const value = row.windowPerformances.find(([window]) => window === name)?.[1];
  return { pnl: Number(value?.pnl ?? 0), roi: Number(value?.roi ?? 0) * 100, vlm: Number(value?.vlm ?? 0) };
}

async function getLeaderboard(limit: number) {
  if (leaderboardCache && leaderboardCache.expires > Date.now()) return { rows: leaderboardCache.rows.slice(0, limit), sourceCount: leaderboardCache.sourceCount };
  const stored = getFillJournal().status("leaderboard");
  if (!stored) throw new Error("Collector leaderboard unavailable");
  const payload = stored.payload as { leaderboardRows: RawLeaderboardRow[] };
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
  const catalog = getFillJournal().status("catalog")?.payload as { markets?: string[]; excludedMarkets?: string[]; coinNames?: Record<string, string> } | undefined;
  return { markets: (catalog?.markets ?? []).slice(0, limit), coinNames: catalog?.coinNames ?? {}, partial: !catalog || Boolean(catalog.excludedMarkets?.length) };
}

async function getRecentFills(wallets: WalletRow[], coinNames: Record<string, string>) {
  const names = new Map(wallets.map((row) => [row.address.toLowerCase(), row.name]));
  const store = getFillJournal();
  // Initial paint needs a small preview; the complete filterable journal is paginated by /api/events.
  const fills: PulseFill[] = store.evidence(store.queryEvents({ from: Date.now() - 86_400_000, wallets: [...names.keys()], limit: 100 }).events).map((event) => ({
    ...event, coin: displayCoin(event.coin, coinNames), walletName: names.get(event.wallet)!,
    closedPnl: event.closedPnl ?? "0", fee: event.fee ?? "0",
    startPosition: event.precision === "exact" ? event.startPosition : undefined,
    source: event.precision === "exact" ? "user" as const : "market" as const,
  }));
  const exactWallets = (store.status("collector")?.payload?.exactWallets ?? []) as string[];
  return { fills, tracked: exactWallets.map((address) => ({ address, name: names.get(address) ?? address })) };
}

function canonicalEvents(since: number, limit = 10_000): JournalEvent[] {
  return getFillJournal().events(since, limit).map((event) => ({
    eventKey: event.id, wallet: event.wallet, coin: event.coin, action: event.action, direction: event.direction,
    time: event.time, price: Number(event.px), size: Number(event.sz), notional: Number(event.px) * Number(event.sz),
    beforeSize: event.beforeSize, afterSize: event.afterSize, fee: event.fee === undefined || !Number.isFinite(feeInUsd(event)) ? undefined : feeInUsd(event),
    realizedPnl: event.closedPnl === undefined ? undefined : Number(event.closedPnl), hash: event.hash, tid: event.tid,
    source: event.source === "user" ? "Hyperliquid userFills journal" : "Hyperliquid market journal",
    precision: event.precision === "exact" ? "exact" : "observed",
  }));
}

async function getCoinFlow(wallets: WalletRow[], coinNames: Record<string, string>) {
  const tracked = new Set(wallets.map((wallet) => wallet.address.toLowerCase()));
  const events = canonicalEvents(Date.now() - 86_400_000, 100_000).filter((event) => tracked.has(event.wallet));
  const rows = new Map<string, { coin: string; buys: number; sells: number; realizedPnl: number | null; trades: number; wallets: Set<string> }>();
  for (const event of events) {
    if (!["OPEN", "ADD", "REDUCE", "CLOSE", "FLIP", "BUY", "SELL"].includes(event.action)) continue;
    const coin = displayCoin(event.coin, coinNames); const notional = Math.abs(event.notional ?? 0);
    if (coin.startsWith("#") || coin.includes("/") && !coin.endsWith("/USDC")) continue;
    const row = rows.get(coin) ?? { coin, buys: 0, sells: 0, realizedPnl: 0, trades: 0, wallets: new Set<string>() };
    const reducing = ["REDUCE", "CLOSE"].includes(event.action);
    const buy = event.action === "BUY" || (event.action !== "SELL" && (event.direction === "LONG") !== reducing);
    if (buy) row.buys += notional; else row.sells += notional;
    row.realizedPnl = row.realizedPnl === null || event.realizedPnl === undefined || event.fee === undefined ? null : row.realizedPnl + event.realizedPnl - event.fee;
    row.trades++; row.wallets.add(event.wallet); rows.set(coin, row);
  }
  return [...rows.values()].map((row): CoinFlow => ({ ...row, wallets: row.wallets.size }))
    .sort((a, b) => b.buys + b.sells - a.buys - a.sells).slice(0, 20);
}

const ignoredBases = new Set(["USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDE", "USDD", "PYUSD", "RLUSD", "USD1", "USDH", "USDF", "BUSD", "EUR", "TRY"]);
const validMover = (symbol: string, volume: number) => symbol.endsWith("USDT") && volume >= 1_000_000 && !ignoredBases.has(symbol.slice(0, -4)) && !/(UP|DOWN|BULL|BEAR)$/.test(symbol.slice(0, -4));

async function getMarketMovers() {
  if (marketMoversCache && marketMoversCache.expires > Date.now()) return marketMoversCache.value;
  const savedBinance = getFillJournal().status("tickers:binance"); const savedBybit = getFillJournal().status("tickers:bybit");
  const binance = { status: savedBinance && Date.now() - savedBinance.updatedAt < 180_000 ? "fulfilled" : "rejected", value: savedBinance?.payload as { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[] | undefined };
  const bybit = { status: savedBybit && Date.now() - savedBybit.updatedAt < 180_000 ? "fulfilled" : "rejected", value: savedBybit?.payload as { result?: { list?: { symbol: string; lastPrice: string; price24hPcnt: string; turnover24h: string }[] } } | undefined };
  const coverage = new Map<string, Omit<MarketMover, "symbol" | "exchange" | "price" | "change" | "volume">>();
  const snapshots = getFillJournal().currentSnapshots(Date.now() - 30_000);
  const bySymbol = new Map<string, typeof snapshots>();
  for (const row of snapshots) { const symbol = baseMarketSymbol(row.coin); bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), row]); }
  for (const [symbol, rows] of bySymbol) coverage.set(symbol, {
    wallets: new Set(rows.map((row) => row.wallet)).size, longWallets: new Set(rows.filter((row) => row.size > 0).map((row) => row.wallet)).size,
    shortWallets: new Set(rows.filter((row) => row.size < 0).map((row) => row.wallet)).size,
    longNotional: rows.filter((row) => row.size > 0).reduce((sum, row) => sum + Math.abs(row.positionValue), 0),
    shortNotional: rows.filter((row) => row.size < 0).reduce((sum, row) => sum + Math.abs(row.positionValue), 0), positionUpdatedAt: Math.min(...rows.map((row) => row.capturedAt)),
  });
  const rows: MarketMover[] = [];
  const mover = (symbol: string, exchange: "Binance" | "Bybit", price: number, change: number, volume: number) => {
    const positions = coverage.get(symbol) ?? { wallets: 0, longWallets: 0, shortWallets: 0, longNotional: 0, shortNotional: 0, positionUpdatedAt: 0 };
    return { symbol, exchange, price, change, volume, ...positions };
  };
  if (binance.status === "fulfilled") rows.push(...(binance.value ?? []).filter((item) => validMover(item.symbol, Number(item.quoteVolume))).map((item) =>
    mover(item.symbol.slice(0, -4), "Binance", Number(item.lastPrice), Number(item.priceChangePercent), Number(item.quoteVolume))));
  if (bybit.status === "fulfilled") rows.push(...(bybit.value?.result?.list ?? []).filter((item) => validMover(item.symbol, Number(item.turnover24h))).map((item) =>
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
  if (dashboardCache && dashboardCache.expires > Date.now()) return dashboardCache.value;
  if (dashboardPending) return dashboardPending;
  dashboardPending = loadDashboardData().then((value) => { dashboardCache = { value, expires: Date.now() + 5000 }; return value; }).finally(() => { dashboardPending = undefined; });
  return dashboardPending;
}

async function loadDashboardData(): Promise<DashboardData> {
  const warnings: string[] = [];
  const config = await getAdminConfig();
  const [walletsResult, midsResult, marketsResult] = await Promise.allSettled([
    getLeaderboard(config.trackedWallets), Promise.resolve((getFillJournal().status("mids")?.payload?.prices ?? {}) as Record<string, string>),
    getMarketCatalog(config.liveMarkets),
  ]);
  const wallets = walletsResult.status === "fulfilled" ? walletsResult.value.rows : [];
  const mids = midsResult.status === "fulfilled" ? midsResult.value : {};
  if (walletsResult.status === "rejected") warnings.push("Рейтинг временно недоступен");
  if (midsResult.status === "rejected") warnings.push("Котировки временно недоступны");
  const collector = getFillJournal().status("collector");
  if (!collector || Date.now() - collector.updatedAt > 5000 || !collector.payload.connected) warnings.push("Сборщик данных не подключён · показаны сохранённые данные");
  const catalog = marketsResult.status === "fulfilled" ? marketsResult.value : { markets: [], coinNames: {}, partial: true };
  if (marketsResult.status === "rejected" || catalog.partial || collector?.payload.subscriptionLimited || collector?.payload.connected && collector.payload.acknowledgedMarkets < collector.payload.marketCount) warnings.push("Часть live-рынков временно недоступна");
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


export async function getWalletDetail(address: string): Promise<WalletDetail> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Некорректный адрес кошелька");
  const key = address.toLowerCase(); const cached = detailCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = readWalletDetail(key); detailCache.set(key, { value, expires: Date.now() + 3000 });
  if (detailCache.size > 25) detailCache.delete(detailCache.keys().next().value!);
  return value;
}

function readWalletDetail(address: string): WalletDetail {
  const journalStore = getFillJournal();
  const now = Date.now(); const scopes = journalStore.scopes(address);
  const catalog = journalStore.status("catalog")?.payload as { dexNames?: string[]; coinNames?: Record<string, string> } | undefined;
  const coinNames = catalog?.coinNames ?? {};
  const stateScopes = scopes.filter((scope) => scope.scope !== "spot" && scope.payload);
  const snapshot = readWalletSnapshot(address, journalStore, now);
  const unavailable = snapshot.unavailableScopes;
  const events = journalStore.events(0, 10_000, address);
  const byId = new Map(events.map((event) => [event.id, event]));
  const rawFills = journalStore.fills(address, 10_000).filter((fill) => fill.source === "user" && byId.get(fill.id)?.precision === "exact");
  const normalizedFills: Fill[] = rawFills.map((fill) => ({ coin: displayCoin(fill.coin, coinNames), px: fill.px, sz: fill.sz, side: fill.side,
    time: fill.time, dir: `${byId.get(fill.id)!.action} ${byId.get(fill.id)!.direction}`.trim(), closedPnl: fill.closedPnl, fee: fill.fee, feeToken: fill.feeToken, startPosition: fill.startPosition,
    hash: fill.hash, tid: fill.tid, oid: fill.oid, crossed: fill.crossed, source: "user" }));
  const positions = snapshot.positions;
  const portfolio = normalizePerpPortfolio((journalStore.resource(address, "portfolio")?.payload ?? []) as RawPortfolioEntry[]);
  const spot = scopes.find((scope) => scope.scope === "spot")?.payload as RawSpotState | undefined;
  const orders = walletOrders(address, 500); const funding = walletFunding(address, 1_000);
  const journal: JournalEvent[] = events.map((event) => ({ eventKey: event.id, wallet: address, coin: displayCoin(event.coin, coinNames),
    action: event.action, direction: event.direction, time: event.time, price: Number(event.px), size: Number(event.sz),
    notional: Number(event.px) * Number(event.sz), beforeSize: event.beforeSize, afterSize: event.afterSize,
    fee: event.fee === undefined ? undefined : Number(event.fee), realizedPnl: event.closedPnl === undefined ? undefined : Number(event.closedPnl),
    hash: event.hash, tid: event.tid, source: event.source === "user" ? "Hyperliquid userFills journal" : "Hyperliquid market journal", precision: event.precision === "exact" ? "exact" : "observed" }));
  const completedTrades = journalStore.completed(address).map((trade) => ({ ...trade, coin: displayCoin(trade.coin, coinNames) }));
  const updatedAt = stateScopes.length ? Math.min(...stateScopes.map((scope) => scope.receivedAt)) : 0;
  return {
    address, accountValue: snapshot.accountValue, totalMarginUsed: snapshot.totalMarginUsed,
    withdrawable: snapshot.withdrawable, positions,
    spotBalances: (spot?.balances ?? []).map((balance) => ({ coin: balance.coin, total: Number(balance.total), hold: Number(balance.hold) })).filter((balance) => balance.total || balance.hold),
    fills: normalizedFills, closedTrades: completedTrades,
    positionHistoryStart: snapshot.positionHistoryStart, positionHistoryComplete: false, portfolio, updatedAt,
    copyability: copyabilityScore({ fills: normalizedFills, closedTrades: completedTrades, accountValue: portfolio.month.accountValue }),
    journal, orders, funding,
    dataQuality: { updatedAt, source: unavailable.length ? "Сохранённые данные · часть рынков недоступна или устарела" : "Серверный журнал Hyperliquid",
      historyComplete: false, oldestFill: rawFills.at(-1)?.time ?? null, journalEvents: journal.length,
      exactFills: normalizedFills.length, ordersCaptured: orders.length, fundingCaptured: funding.length, unavailableScopes: unavailable, pending: stateScopes.length === 0 },
  };
}

export async function getCoinDetail(coin: string): Promise<CoinDetail> {
  const safeCoin = decodeURIComponent(coin); const rawCoin = safeCoin.includes(":") ? safeCoin.slice(safeCoin.indexOf(":") + 1) : safeCoin;
  const endTime = Date.now();
  const found = await findCoinMarket(safeCoin, info);
  const movers = found ? null : await getMarketMovers().catch(() => null);
  const spot = [...(movers?.gainers ?? []), ...(movers?.losers ?? [])].find((row) => row.symbol === rawCoin);
  const resolvedCoin = found?.name ?? safeCoin;
  const candles = found ? await info<RawCandle[]>(coinCandleRequest(resolvedCoin, endTime), 15).catch(() => []) : [];
  const market = found?.market ?? {}; const markPx = Number(market.markPx ?? spot?.price ?? 0); const previous = Number(market.prevDayPx ?? (spot?.change ? markPx / (1 + spot.change / 100) : markPx));
  const aliases = [...new Set([safeCoin, rawCoin, resolvedCoin])];
  const events = canonicalEvents(endTime - 86_400_000).filter((event) => aliases.includes(event.coin) || baseMarketSymbol(event.coin) === rawCoin.toUpperCase());
  const snapshots = getFillJournal().currentSnapshots(endTime - 30_000).filter((row) => aliases.includes(row.coin) || baseMarketSymbol(row.coin) === rawCoin.toUpperCase());
  const participants = coinParticipants(events, snapshots, endTime);
  const windows = { "5m": 300_000, "1h": 3_600_000, "4h": 14_400_000, "24h": 86_400_000 } as const;
  const changes = Object.fromEntries(Object.entries(windows).map(([label, duration]) => [label, coinFlowChange(events, endTime, duration)])) as CoinDetail["changes"];
  return { coin: rawCoin, markPx, oraclePx: Number(market.oraclePx ?? 0), change24h: spot?.change ?? (previous ? (markPx - previous) / previous * 100 : 0),
    volume24h: Number(market.dayNtlVlm ?? spot?.volume ?? 0), openInterest: Number(market.openInterest ?? 0), funding: Number(market.funding ?? 0),
    candles: candles.map((row) => ({ time: row.t, open: Number(row.o), close: Number(row.c), high: Number(row.h), low: Number(row.l), volume: Number(row.v) })),
    events, snapshots, participants, hasPerpMarket: Boolean(found), changes, updatedAt: endTime,
    source: found ? `Hyperliquid ${found.dex || "main"} + Deep Current journal` : `${spot?.exchange ?? "Spot"} market + Deep Current journal` };
}
