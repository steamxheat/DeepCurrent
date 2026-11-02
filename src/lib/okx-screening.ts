import assert from "node:assert/strict";
import { decimalAdd, decimalNegate, decimalSign, validDecimal } from "./position-reducer.ts";

type Row = Record<string, unknown>;
const DAY = 86400000;
function number(value: unknown): number {
  assert.ok(typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)), "missing_or_invalid_number");
  return Number(value);
}
function timestamp(value: unknown) {
  const time = number(value); assert.ok(Number.isSafeInteger(time) && time > 0, "invalid_timestamp"); return time;
}
export function visibleOkxPosition(row: Row) {
  return typeof row.instId === "string" && row.instId !== "" && ["long", "short", "net"].includes(String(row.posSide))
    && Number(row.openTime) > 0 && Number(row.openAvgPx) > 0 && Math.abs(Number(row.subPos)) > 0;
}
export function okxNotional(row: Row, priceField: string, instruments: Map<string, Row>) {
  const instrument = instruments.get(String(row.instId)); assert.ok(instrument, "unknown_contract_multiplier");
  const quantity = Math.abs(number(row.subPos)); const multiplier = number(instrument.ctVal);
  const price = number(row[priceField]); assert.ok(quantity > 0 && multiplier > 0 && price > 0, "invalid_notional");
  const stable = ["USD", "USDT", "USDC"];
  assert.ok(/-(USD|USDT|USDC)-SWAP$/.test(String(row.instId)), "unsupported_quote_currency");
  return quantity * multiplier * (stable.includes(String(instrument.ctValCcy)) ? 1 : price);
}
export function okxPnl30d(points: Row[], asOf: number) {
  const sorted = points.map(row => ({ time: timestamp(row.beginTs), pnl: row.pnl })).sort((a, b) => b.time - a.time);
  assert.equal(new Set(sorted.map(row => row.time)).size, sorted.length, "duplicate_pnl_day");
  const end = sorted[0]; assert.ok(end && end.time <= asOf && asOf - end.time <= 26 * 3600000, "stale_pnl_series");
  const start = sorted.find(row => row.time === end.time - 30 * DAY);
  assert.ok(start && validDecimal(start.pnl) && validDecimal(end.pnl), "missing_30d_pnl_boundary");
  return { pnl: decimalAdd(end.pnl, decimalNegate(start.pnl)), periodStart: start.time, periodEnd: end.time,
    basis: "Difference of official accumulated daily PnL at 30-day boundaries; not live rolling PnL" };
}
export function screenOkxLead(history: Row[], current: Row[], pnl: Row[], instruments: Map<string, Row>, asOf: number) {
  assert.ok(current.every(visibleOkxPosition), "hidden_current_positions");
  const unique = new Map<string, Row>();
  for (const row of history) {
    assert.ok(typeof row.subPosId === "string" && /^\d+$/.test(row.subPosId), "missing_position_id");
    const existing = unique.get(row.subPosId);
    if (existing) assert.deepEqual(existing, row, "conflicting_position_history");
    unique.set(row.subPosId, row);
  }
  const currentIds = new Set<string>();
  type Interval = { open: number; close: number; pnl: string; key: string };
  const intervals: Interval[] = []; let volumeLowerBound30d = 0;
  for (const row of unique.values()) {
    const open = timestamp(row.openTime); const close = timestamp(row.closeTime);
    assert.ok(open <= close && close <= asOf && visibleOkxPosition(row) && validDecimal(row.pnl), "invalid_closed_position");
    assert.equal(row.ccy, "USDT", "non_usdt_pnl_not_converted");
    intervals.push({ open, close, pnl: row.pnl, key: `${row.instId}:${row.posSide}` });
    if (open >= asOf - 30 * DAY) volumeLowerBound30d += okxNotional(row, "openAvgPx", instruments);
    if (close >= asOf - 30 * DAY) volumeLowerBound30d += okxNotional(row, "closeAvgPx", instruments);
  }
  for (const row of current) {
    const id = String(row.subPosId); assert.ok(/^\d+$/.test(id) && !currentIds.has(id) && !unique.has(id), "conflicting_current_position");
    currentIds.add(id); const open = timestamp(row.openTime); assert.ok(open <= asOf, "future_current_position");
    intervals.push({ open, close: Infinity, pnl: "0", key: `${row.instId}:${row.posSide}` });
    if (open >= asOf - 30 * DAY) volumeLowerBound30d += okxNotional(row, "openAvgPx", instruments);
  }
  // Overlapping lead orders can belong to one continuous position; merge conservatively.
  intervals.sort((a, b) => a.key.localeCompare(b.key) || a.open - b.open);
  const cycles: Interval[] = [];
  for (const row of intervals) {
    const last = cycles.at(-1);
    if (last && last.key === row.key && row.open <= last.close) {
      last.close = Math.max(last.close, row.close); last.pnl = decimalAdd(last.pnl, row.pnl);
    } else cycles.push({ ...row });
  }
  const closed = cycles.filter(row => row.open >= asOf - 60 * DAY && Number.isFinite(row.close));
  const wins = closed.filter(row => decimalSign(row.pnl) > 0).length;
  const reportedWinRate = closed.length ? 100 * wins / closed.length : null;
  const month = okxPnl30d(pnl, asOf);
  const failures = [closed.length < 20 && "insufficient_completed_positions", reportedWinRate !== null && reportedWinRate < 60 && "reported_winrate_below_60",
    decimalSign(month.pnl) <= 0 && "nonpositive_30d_pnl", volumeLowerBound30d < 9000000 && "observed_volume_below_9m"].filter(Boolean);
  return { status: "needs_review", reportedCriteriaPass: failures.length === 0, failures,
    closedPositions60d: closed.length, wins, reportedWinRate, netWinRate: null, officialPnl30d: month,
    observedVolumeLowerBound30d: volumeLowerBound30d, averageObservedDailyVolume: volumeLowerBound30d / 30,
    currentPositions: current.length, historyRecords: unique.size, checkedAt: asOf,
    unverified: ["Public lead strategy only; other accounts/subaccounts unavailable", "Per-position fee and funding basis not established",
      "Unique fill/transaction IDs not exposed", "Individual live latency and <=3s execution not tested"] };
}
