import test from "node:test";
import assert from "node:assert/strict";
import { binanceHistoryStats, cexRetryable, cexVisible, finiteCexNumber, stableTradeNotional30d } from "./cex-screening.ts";
const day = 86400000; const now = 100 * day;
const row = (id: string, extra: Record<string, unknown> = {}) => ({ positionId: id, index: "0", opened: now - day,
  closed: now - day + 100, symbol: "BTCUSDT", side: "Long", status: "All Closed", closingPnl: 1, ...extra });
test("CEX visibility respects inverted HTX flag; missing numbers stay unknown", () => {
  assert.equal(cexVisible("htx", 0), false); assert.equal(cexVisible("htx", 1), true);
  assert.equal(cexVisible("binance", false), false); assert.equal(cexVisible("binance", true), true);
  assert.throws(() => finiteCexNumber(null)); assert.throws(() => finiteCexNumber("")); assert.throws(() => finiteCexNumber(NaN));
});
test("Binance duplicate and overlapping partial position rows do not inflate wins", () => {
  const a = row("1"); const b = row("2", { closingPnl: -2 });
  const report = binanceHistoryStats([a, a, b], now);
  assert.equal(report.positionRecords, 2); assert.equal(report.observedClosedCycles60d, 1); assert.equal(report.reportedWinRate60d, 0);
  assert.throws(() => binanceHistoryStats([a, { ...a, closingPnl: 2 }], now), /conflicting/);
  const partial = binanceHistoryStats([a, row("2", { status: "Partially Closed", closed: null, closingPnl: 999 })], now);
  assert.equal(partial.observedClosedCycles60d, 1); assert.equal(partial.wins, 1);
  assert.throws(() => binanceHistoryStats([row("2", { status: "unknown" })], now), /unknown_position_status/);
  assert.throws(() => binanceHistoryStats([row("2", { closed: now + 1 })], now), /invalid_position_time/);
});
test("CEX throttling and busy codes inside HTTP 200 trigger backoff, auth failures do not retry", () => {
  assert.equal(cexRetryable(200, "90801003"), true); assert.equal(cexRetryable(200, 11012005), true);
  assert.equal(cexRetryable(429), true); assert.equal(cexRetryable(403), false);
  assert.equal(cexRetryable(200, "000000"), false); assert.equal(cexRetryable(200, 80002), false);
});
test("Only known quote notionals in the30d window contribute volume", () => {
  const report = stableTradeNotional30d([{ time: now, quantity: 9000000, quantityAsset: "USDT" },
    { time: now - 31 * day, quantity: 9000000, quantityAsset: "USDT" }, { time: now, quantity: 2, quantityAsset: "BTC" }], now);
  assert.equal(report.observedNotional30d, 9000000); assert.equal(report.averageObservedDailyNotional, 300000);
  assert.equal(report.unknownCurrency, 1);
});
