import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CopyDelay, CopySample } from "./copyability.ts";
import type { ClosedTrade } from "./stats.ts";
import type { WalletScreening } from "./wallet-screening.ts";

export type EventPrecision = "exact" | "reconstructed" | "observed";
export type JournalEvent = {
  eventKey: string; wallet: string; walletName?: string; coin: string; action: string; direction?: string;
  time: number; price?: number; size?: number; notional?: number; beforeSize?: number; afterSize?: number;
  fee?: number; realizedPnl?: number; source: string; precision: EventPrecision; hash?: string; tid?: number;
};
export type PositionSnapshot = {
  wallet: string; coin: string; capturedAt: number; size: number; entryPx: number; positionValue: number;
  unrealizedPnl: number; leverage: number; liquidationPx: number | null; marginUsed: number; source: string;
};
export type CoinPositionCoverage = {
  coin: string; wallets: number; longWallets: number; shortWallets: number;
  longNotional: number; shortNotional: number; updatedAt: number;
};
export type OrderEvent = { eventKey: string; wallet: string; coin: string; side: string; status: string; kind: string; limitPx: number; size: number; time: number; source: string };
export type FundingEvent = { eventKey: string; wallet: string; coin: string; time: number; amount: number; rate: number; size: number; source: string };
export type StoredClosedTrade = ClosedTrade & { wallet: string };

type JournalRow = { event_key: string; wallet: string; wallet_name: string | null; coin: string; action: string; direction: string | null; occurred_at: number; price: number | null; size: number | null; notional: number | null; before_size: number | null; after_size: number | null; fee: number | null; realized_pnl: number | null; source: string; precision: EventPrecision; hash: string | null; tid: number | null };
type CopyRow = { delay_seconds: CopyDelay; adverse_bps: number };
type OrderRow = { event_key: string; wallet: string; coin: string; side: string; status: string; kind: string; limit_px: number; size: number; occurred_at: number; source: string };
type FundingRow = { event_key: string; wallet: string; coin: string; occurred_at: number; amount: number; rate: number; size: number; source: string };
type ClosedTradeRow = { wallet: string; coin: string; direction: "LONG" | "SHORT"; opened_at: number | null; closed_at: number; entry_px: number | null; exit_px: number; size: number; net_pnl: number };
type ScreeningRow = { address: string; platform: "hyperliquid"; window_days: 60; trades: number; wins: number; win_rate: number; net_pnl: number; volume: number; last_active: number; score: number; history_complete: number; qualifies: number; reason: string; screened_at: number };

const databasePath = process.env.DEEPCURRENT_DB_PATH || path.join(process.cwd(), ".data", "deep-current.sqlite");
mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS wallet_events (
    event_key TEXT PRIMARY KEY, wallet TEXT NOT NULL, wallet_name TEXT, coin TEXT NOT NULL,
    action TEXT NOT NULL, direction TEXT, occurred_at INTEGER NOT NULL, price REAL, size REAL,
    notional REAL, before_size REAL, after_size REAL, fee REAL, realized_pnl REAL,
    source TEXT NOT NULL, precision TEXT NOT NULL, hash TEXT, tid INTEGER, recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wallet_events_wallet_time ON wallet_events(wallet, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS wallet_events_coin_time ON wallet_events(coin, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS wallet_events_time ON wallet_events(occurred_at DESC);
  CREATE TABLE IF NOT EXISTS position_snapshots (
    wallet TEXT NOT NULL, coin TEXT NOT NULL, captured_at INTEGER NOT NULL, size REAL NOT NULL,
    entry_px REAL NOT NULL, position_value REAL NOT NULL, unrealized_pnl REAL NOT NULL,
    leverage REAL NOT NULL, liquidation_px REAL, margin_used REAL NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY (wallet, coin, captured_at)
  );
  CREATE INDEX IF NOT EXISTS position_snapshots_coin_time ON position_snapshots(coin, captured_at DESC);
  CREATE TABLE IF NOT EXISTS order_events (
    event_key TEXT PRIMARY KEY, wallet TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL,
    status TEXT NOT NULL, kind TEXT NOT NULL, limit_px REAL NOT NULL, size REAL NOT NULL,
    occurred_at INTEGER NOT NULL, source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS order_events_wallet_time ON order_events(wallet, occurred_at DESC);
  CREATE TABLE IF NOT EXISTS funding_events (
    event_key TEXT PRIMARY KEY, wallet TEXT NOT NULL, coin TEXT NOT NULL, occurred_at INTEGER NOT NULL,
    amount REAL NOT NULL, rate REAL NOT NULL, size REAL NOT NULL, source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS funding_events_wallet_time ON funding_events(wallet, occurred_at DESC);
  CREATE TABLE IF NOT EXISTS copy_samples (
    event_key TEXT NOT NULL, wallet TEXT NOT NULL, coin TEXT NOT NULL, delay_seconds INTEGER NOT NULL,
    adverse_bps REAL NOT NULL, measured_at INTEGER NOT NULL, PRIMARY KEY (event_key, delay_seconds)
  );
  CREATE TABLE IF NOT EXISTS completed_trades (
    event_key TEXT PRIMARY KEY, wallet TEXT NOT NULL, coin TEXT NOT NULL, direction TEXT NOT NULL,
    opened_at INTEGER, closed_at INTEGER NOT NULL, entry_px REAL, exit_px REAL NOT NULL,
    size REAL NOT NULL, net_pnl REAL NOT NULL, recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS completed_trades_wallet_time ON completed_trades(wallet, closed_at DESC);
  CREATE TABLE IF NOT EXISTS wallet_screenings (
    address TEXT PRIMARY KEY, platform TEXT NOT NULL, window_days INTEGER NOT NULL,
    trades INTEGER NOT NULL, wins INTEGER NOT NULL, win_rate REAL NOT NULL,
    net_pnl REAL NOT NULL, volume REAL NOT NULL, last_active INTEGER NOT NULL,
    score REAL NOT NULL, history_complete INTEGER NOT NULL, qualifies INTEGER NOT NULL,
    reason TEXT NOT NULL, screened_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wallet_screenings_qualified ON wallet_screenings(qualifies, score DESC);
`);

const mapJournal = (row: JournalRow): JournalEvent => ({
  eventKey: row.event_key, wallet: row.wallet, walletName: row.wallet_name ?? undefined, coin: row.coin,
  action: row.action, direction: row.direction ?? undefined, time: row.occurred_at, price: row.price ?? undefined,
  size: row.size ?? undefined, notional: row.notional ?? undefined, beforeSize: row.before_size ?? undefined,
  afterSize: row.after_size ?? undefined, fee: row.fee ?? undefined, realizedPnl: row.realized_pnl ?? undefined,
  source: row.source, precision: row.precision, hash: row.hash ?? undefined, tid: row.tid ?? undefined,
});

export function recordWalletEvent(event: JournalEvent) {
  return db.prepare(`INSERT OR IGNORE INTO wallet_events
    (event_key, wallet, wallet_name, coin, action, direction, occurred_at, price, size, notional, before_size, after_size, fee, realized_pnl, source, precision, hash, tid, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.eventKey, event.wallet.toLowerCase(), event.walletName ?? null, event.coin, event.action, event.direction ?? null,
      event.time, event.price ?? null, event.size ?? null, event.notional ?? null, event.beforeSize ?? null,
      event.afterSize ?? null, event.fee ?? null, event.realizedPnl ?? null, event.source, event.precision,
      event.hash ?? null, event.tid ?? null, Date.now()).changes === 1;
}

export function recordPositionSnapshots(snapshots: PositionSnapshot[]) {
  const insert = db.prepare(`INSERT OR REPLACE INTO position_snapshots
    (wallet, coin, captured_at, size, entry_px, position_value, unrealized_pnl, leverage, liquidation_px, margin_used, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const previous = db.prepare("SELECT leverage FROM position_snapshots WHERE wallet = ? AND coin = ? ORDER BY captured_at DESC LIMIT 1");
  const leverageChanges = snapshots.flatMap((row) => {
    const last = previous.get(row.wallet.toLowerCase(), row.coin) as { leverage: number } | undefined;
    return last && last.leverage !== row.leverage ? [{ eventKey: `${row.wallet.toLowerCase()}:${row.coin}:leverage:${row.capturedAt}`, wallet: row.wallet, coin: row.coin, action: "LEVERAGE", time: row.capturedAt, beforeSize: last.leverage, afterSize: row.leverage, source: row.source, precision: "observed" as const }] : [];
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of snapshots) insert.run(row.wallet.toLowerCase(), row.coin, row.capturedAt, row.size, row.entryPx, row.positionValue, row.unrealizedPnl, row.leverage, row.liquidationPx, row.marginUsed, row.source);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  for (const event of leverageChanges) recordWalletEvent(event);
}

export function recordOrderEvents(events: OrderEvent[]) {
  const insert = db.prepare("INSERT OR IGNORE INTO order_events (event_key, wallet, coin, side, status, kind, limit_px, size, occurred_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const event of events) insert.run(event.eventKey, event.wallet.toLowerCase(), event.coin, event.side, event.status, event.kind, event.limitPx, event.size, event.time, event.source);
}

export function recordFundingEvents(events: FundingEvent[]) {
  const insert = db.prepare("INSERT OR IGNORE INTO funding_events (event_key, wallet, coin, occurred_at, amount, rate, size, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const event of events) insert.run(event.eventKey, event.wallet.toLowerCase(), event.coin, event.time, event.amount, event.rate, event.size, event.source);
}

export function recordCompletedTrades(wallet: string, trades: ClosedTrade[]) {
  const normalized = wallet.toLowerCase();
  const insert = db.prepare("INSERT OR REPLACE INTO completed_trades (event_key, wallet, coin, direction, opened_at, closed_at, entry_px, exit_px, size, net_pnl, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const trade of trades) insert.run(`${normalized}:${trade.coin}:${trade.direction}:${trade.closedAt}`, normalized, trade.coin, trade.direction, trade.openedAt, trade.closedAt, trade.entryPx, trade.exitPx, trade.size, trade.netPnl, Date.now());
}

export function recordCopySample(eventKey: string, wallet: string, coin: string, delay: CopyDelay, adverseBps: number, measuredAt = Date.now()) {
  db.prepare("INSERT OR REPLACE INTO copy_samples (event_key, wallet, coin, delay_seconds, adverse_bps, measured_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(eventKey, wallet.toLowerCase(), coin, delay, adverseBps, measuredAt);
}

export function walletJournal(wallet: string, limit = 500) {
  return (db.prepare("SELECT * FROM wallet_events WHERE wallet = ? ORDER BY occurred_at DESC LIMIT ?").all(wallet.toLowerCase(), limit) as JournalRow[]).map(mapJournal);
}

export function coinJournal(coin: string, since = Date.now() - 86_400_000, limit = 2_000) {
  return (db.prepare("SELECT * FROM wallet_events WHERE coin = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?").all(coin, since, limit) as JournalRow[]).map(mapJournal);
}

export function recentJournal(since = Date.now() - 86_400_000, limit = 5_000) {
  return (db.prepare("SELECT * FROM wallet_events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?").all(since, limit) as JournalRow[]).map(mapJournal);
}

export function walletOrders(wallet: string, limit = 500): OrderEvent[] {
  return (db.prepare("SELECT * FROM order_events WHERE wallet = ? ORDER BY occurred_at DESC LIMIT ?").all(wallet.toLowerCase(), limit) as OrderRow[])
    .map((row) => ({ eventKey: row.event_key, wallet: row.wallet, coin: row.coin, side: row.side, status: row.status, kind: row.kind, limitPx: row.limit_px, size: row.size, time: row.occurred_at, source: row.source }));
}

export function walletFunding(wallet: string, limit = 1_000): FundingEvent[] {
  return (db.prepare("SELECT * FROM funding_events WHERE wallet = ? ORDER BY occurred_at DESC LIMIT ?").all(wallet.toLowerCase(), limit) as FundingRow[])
    .map((row) => ({ eventKey: row.event_key, wallet: row.wallet, coin: row.coin, time: row.occurred_at, amount: row.amount, rate: row.rate, size: row.size, source: row.source }));
}

export function walletCompletedTrades(wallet: string, limit = 500): StoredClosedTrade[] {
  return (db.prepare("SELECT wallet, coin, direction, opened_at, closed_at, entry_px, exit_px, size, net_pnl FROM completed_trades WHERE wallet = ? ORDER BY closed_at DESC LIMIT ?").all(wallet.toLowerCase(), limit) as ClosedTradeRow[])
    .map((row) => ({ wallet: row.wallet, coin: row.coin, direction: row.direction, openedAt: row.opened_at, closedAt: row.closed_at, entryPx: row.entry_px, exitPx: row.exit_px, size: row.size, netPnl: row.net_pnl }));
}

export function copySamplesForWallet(wallet: string): CopySample[] {
  return (db.prepare("SELECT delay_seconds, adverse_bps FROM copy_samples WHERE wallet = ? ORDER BY measured_at DESC LIMIT 2000").all(wallet.toLowerCase()) as CopyRow[])
    .map((row) => ({ delay: row.delay_seconds, adverseBps: row.adverse_bps }));
}

export function latestCoinSnapshots(coin: string, limit = 500, since = Date.now() - 15 * 60_000): PositionSnapshot[] {
  return db.prepare(`SELECT p.wallet, p.coin, p.captured_at AS capturedAt, p.size, p.entry_px AS entryPx,
    p.position_value AS positionValue, p.unrealized_pnl AS unrealizedPnl, p.leverage, p.liquidation_px AS liquidationPx,
    p.margin_used AS marginUsed, p.source FROM position_snapshots p JOIN (
      SELECT wallet, coin, MAX(captured_at) AS captured_at FROM position_snapshots WHERE coin = ? GROUP BY wallet, coin
    ) latest ON latest.wallet = p.wallet AND latest.coin = p.coin AND latest.captured_at = p.captured_at
    WHERE p.captured_at >= ? LIMIT ?`).all(coin, since, limit) as unknown as PositionSnapshot[];
}

export function currentPositionCoverage(since = Date.now() - 15 * 60_000): CoinPositionCoverage[] {
  const rows = db.prepare(`SELECT p.coin, COUNT(DISTINCT p.wallet) AS wallets,
    COUNT(DISTINCT CASE WHEN p.size > 0 THEN p.wallet END) AS longWallets,
    COUNT(DISTINCT CASE WHEN p.size < 0 THEN p.wallet END) AS shortWallets,
    COALESCE(SUM(CASE WHEN p.size > 0 THEN ABS(p.position_value) ELSE 0 END), 0) AS longNotional,
    COALESCE(SUM(CASE WHEN p.size < 0 THEN ABS(p.position_value) ELSE 0 END), 0) AS shortNotional,
    MAX(p.captured_at) AS updatedAt
    FROM position_snapshots p JOIN (
      SELECT wallet, coin, MAX(captured_at) AS captured_at FROM position_snapshots GROUP BY wallet, coin
    ) latest ON latest.wallet = p.wallet AND latest.coin = p.coin AND latest.captured_at = p.captured_at
    WHERE p.captured_at >= ? AND p.size != 0 GROUP BY p.coin`).all(since) as unknown as CoinPositionCoverage[];
  return rows.map((row) => ({ ...row }));
}

const mapScreening = (row: ScreeningRow): WalletScreening => ({
  address: row.address, platform: row.platform, windowDays: row.window_days, trades: row.trades, wins: row.wins,
  winRate: row.win_rate, netPnl: row.net_pnl, volume: row.volume, lastActive: row.last_active, score: row.score,
  historyComplete: Boolean(row.history_complete), qualifies: Boolean(row.qualifies), reason: row.reason, screenedAt: row.screened_at,
});

export function recordWalletScreening(result: WalletScreening) {
  db.prepare(`INSERT OR REPLACE INTO wallet_screenings
    (address, platform, window_days, trades, wins, win_rate, net_pnl, volume, last_active, score, history_complete, qualifies, reason, screened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      result.address.toLowerCase(), result.platform, result.windowDays, result.trades, result.wins, result.winRate,
      result.netPnl, result.volume, result.lastActive, result.score, Number(result.historyComplete), Number(result.qualifies), result.reason, result.screenedAt,
    );
}

export function walletScreenings(qualifiedOnly = false, limit = 1_000, since = Date.now() - 24 * 60 * 60 * 1_000): WalletScreening[] {
  const sql = qualifiedOnly
    ? "SELECT * FROM wallet_screenings WHERE window_days = 60 AND qualifies = 1 AND screened_at >= ? ORDER BY score DESC, net_pnl DESC LIMIT ?"
    : "SELECT * FROM wallet_screenings WHERE window_days = 60 AND screened_at >= ? ORDER BY screened_at DESC LIMIT ?";
  const rows = db.prepare(sql).all(since, limit);
  return (rows as ScreeningRow[]).map(mapScreening);
}

export function screenedWalletAddresses(since = Date.now() - 6 * 60 * 60 * 1_000) {
  return new Set((db.prepare("SELECT address FROM wallet_screenings WHERE window_days = 60 AND screened_at >= ?").all(since) as { address: string }[]).map((row) => row.address));
}
