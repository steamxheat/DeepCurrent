import type { Position } from "./hyperliquid";
import type { ClosedTrade, Fill } from "./stats";

export type PositionSort = "time-desc" | "time-asc" | "duration-desc" | "duration-asc" | "notional-desc" | "notional-asc" | "pnl-desc" | "pnl-asc" | "roi-desc" | "roi-asc" | "entry-desc" | "entry-asc";
export type ClosedSort = "time-desc" | "time-asc" | "duration-desc" | "duration-asc" | "pnl-desc" | "pnl-asc" | "exit-desc" | "exit-asc";
export type FillSort = "time-desc" | "time-asc" | "notional-desc" | "notional-asc" | "price-desc" | "price-asc";

const nullableTime = (a: number | null, b: number | null, direction: 1 | -1) => {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return direction * (a - b);
};

export function sortPositions(rows: Position[], sort: PositionSort) {
  const [field, order] = sort.split("-") as ["time" | "duration" | "notional" | "pnl" | "roi" | "entry", "asc" | "desc"];
  const direction = order === "asc" ? 1 : -1;
  const roi = (row: Position) => row.marginUsed && row.marginUsed > 0 ? row.unrealizedPnl / row.marginUsed * 100 : null;
  return [...rows].sort((a, b) => field === "time" || field === "duration" ? nullableTime(a.openedAt, b.openedAt, field === "duration" ? -direction as 1 | -1 : direction)
    : field === "roi" ? nullableTime(roi(a), roi(b), direction)
    : direction * ((field === "notional" ? Math.abs(a.positionValue) : field === "pnl" ? a.unrealizedPnl : a.entryPx) - (field === "notional" ? Math.abs(b.positionValue) : field === "pnl" ? b.unrealizedPnl : b.entryPx)));
}

export function filterPositions(rows: Position[], filters: { coin: string; side: string; exactOnly: boolean; source?: string; action?: string }) {
  return rows.filter((row) => (!filters.coin || row.coin.toLowerCase().includes(filters.coin.trim().toLowerCase()))
    && (filters.side === "all" || (row.size > 0 ? "LONG" : "SHORT") === filters.side)
    && (!filters.exactOnly || row.openedAt !== null)
    && (!filters.source || filters.source === "all" || row.source === filters.source)
    && (!filters.action || filters.action === "all" || row.lastAction === filters.action));
}

export function sortClosedTrades(rows: ClosedTrade[], sort: ClosedSort) {
  const [field, order] = sort.split("-") as ["time" | "duration" | "pnl" | "exit", "asc" | "desc"];
  const direction = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => field === "duration" ? nullableTime(a.openedAt === null ? null : a.closedAt - a.openedAt, b.openedAt === null ? null : b.closedAt - b.openedAt, direction)
    : nullableTime(field === "time" ? a.closedAt : field === "pnl" ? Number.isFinite(a.netPnl) ? a.netPnl : null : a.exitPx, field === "time" ? b.closedAt : field === "pnl" ? Number.isFinite(b.netPnl) ? b.netPnl : null : b.exitPx, direction));
}

export function sortFills(rows: Fill[], sort: FillSort) {
  const [field, order] = sort.split("-") as ["time" | "notional" | "price", "asc" | "desc"];
  const direction = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => direction * ((field === "time" ? a.time : field === "notional" ? Math.abs(Number(a.px) * Number(a.sz)) : Number(a.px)) - (field === "time" ? b.time : field === "notional" ? Math.abs(Number(b.px) * Number(b.sz)) : Number(b.px))));
}
