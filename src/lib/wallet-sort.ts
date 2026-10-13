import type { Position } from "./hyperliquid";
import type { ClosedTrade, Fill } from "./stats";

export type PositionSort = "time-desc" | "time-asc" | "notional-desc" | "notional-asc" | "pnl-desc" | "pnl-asc" | "entry-desc" | "entry-asc";
export type ClosedSort = "time-desc" | "time-asc" | "duration-desc" | "duration-asc" | "pnl-desc" | "pnl-asc" | "exit-desc" | "exit-asc";
export type FillSort = "time-desc" | "time-asc" | "notional-desc" | "notional-asc" | "price-desc" | "price-asc";

const nullableTime = (a: number | null, b: number | null, direction: 1 | -1) => {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return direction * (a - b);
};

export function sortPositions(rows: Position[], sort: PositionSort) {
  const [field, order] = sort.split("-") as ["time" | "notional" | "pnl" | "entry", "asc" | "desc"];
  const direction = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => field === "time" ? nullableTime(a.openedAt, b.openedAt, direction)
    : direction * ((field === "notional" ? Math.abs(a.positionValue) : field === "pnl" ? a.unrealizedPnl : a.entryPx) - (field === "notional" ? Math.abs(b.positionValue) : field === "pnl" ? b.unrealizedPnl : b.entryPx)));
}

export function sortClosedTrades(rows: ClosedTrade[], sort: ClosedSort) {
  const [field, order] = sort.split("-") as ["time" | "duration" | "pnl" | "exit", "asc" | "desc"];
  const direction = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => direction * ((field === "time" ? a.closedAt : field === "duration" ? (a.openedAt === null ? -1 : a.closedAt - a.openedAt) : field === "pnl" ? a.netPnl : a.exitPx) - (field === "time" ? b.closedAt : field === "duration" ? (b.openedAt === null ? -1 : b.closedAt - b.openedAt) : field === "pnl" ? b.netPnl : b.exitPx)));
}

export function sortFills(rows: Fill[], sort: FillSort) {
  const [field, order] = sort.split("-") as ["time" | "notional" | "price", "asc" | "desc"];
  const direction = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => direction * ((field === "time" ? a.time : field === "notional" ? Math.abs(Number(a.px) * Number(a.sz)) : Number(a.px)) - (field === "time" ? b.time : field === "notional" ? Math.abs(Number(b.px) * Number(b.sz)) : Number(b.px))));
}
