import assert from "node:assert/strict";

type Row = Record<string, unknown>;
const DAY = 86400000;
export function finiteCexNumber(value: unknown) {
  assert.ok((typeof value === "string" && value.trim() !== "") || typeof value === "number", "missing_number");
  const result = Number(value); assert.ok(Number.isFinite(result), "invalid_number"); return result;
}
export function cexVisible(exchange: "binance" | "htx", value: unknown) {
  // HTX's published client treats isHide=0 as hidden, despite the field's name.
  return exchange === "binance" ? value === true : value === 1;
}
export function cexRetryable(status: number, code?: unknown) {
  return status === 429 || ["90801003", "11012005"].includes(String(code));
}
export function binanceHistoryStats(rows: Row[], asOf: number) {
  const positions = new Map<string, Row>();
  for (const row of rows) {
    assert.ok(typeof row.positionId === "string" && row.positionId !== "", "missing_position_id");
    const key = `${row.positionId}:${row.index}`;
    const previous = positions.get(key);
    if (previous) assert.deepEqual(previous, row, "conflicting_position");
    positions.set(key, row);
  }
  const intervals = [...positions.values()].filter(row => {
    assert.ok(["All Closed", "Partially Closed"].includes(String(row.status)), "unknown_position_status");
    return row.status === "All Closed";
  }).map(row => {
    const open = finiteCexNumber(row.opened); const close = finiteCexNumber(row.closed);
    assert.ok(Number.isSafeInteger(open) && Number.isSafeInteger(close) && open > 0 && close >= open && close <= asOf, "invalid_position_time");
    assert.ok(typeof row.symbol === "string" && row.symbol !== "" && ["Long", "Short"].includes(String(row.side)), "invalid_position_market");
    assert.equal(row.status, "All Closed", "partial_position");
    return { key: `${row.symbol}:${row.side}`, open, close, pnl: finiteCexNumber(row.closingPnl) };
  }).sort((a, b) => a.key.localeCompare(b.key) || a.open - b.open);
  const cycles: typeof intervals = [];
  for (const row of intervals) {
    const last = cycles.at(-1);
    if (last && last.key === row.key && row.open <= last.close) { last.close = Math.max(last.close, row.close); last.pnl += row.pnl; }
    else cycles.push({ ...row });
  }
  const closed = cycles.filter(row => row.open >= asOf - 60 * DAY);
  const wins = closed.filter(row => row.pnl > 0).length;
  return { observedClosedCycles60d: closed.length, wins, reportedWinRate60d: closed.length ? wins * 100 / closed.length : null,
    positionRecords: positions.size, netWinRate: null, completeHistoryVerified: false };
}
export function stableTradeNotional30d(rows: Row[], asOf: number) {
  let notional = 0; let unknownCurrency = 0;
  for (const row of rows) {
    const time = finiteCexNumber(row.time);
    assert.ok(Number.isSafeInteger(time) && time > 0 && time <= asOf, "invalid_trade_time");
    if (time < asOf - 30 * DAY) continue;
    if (!["USDT", "USDC", "USD"].includes(String(row.quantityAsset))) { unknownCurrency++; continue; }
    const value = finiteCexNumber(row.quantity); assert.ok(value > 0, "invalid_notional"); notional += value;
  }
  return { observedNotional30d: notional, averageObservedDailyNotional: notional / 30, unknownCurrency,
    basis: "Public executions quote notional in USD/USDT/USDC; stablecoin parity assumed" };
}
