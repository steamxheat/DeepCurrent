import assert from "node:assert/strict";
import test from "node:test";
import { filterPositions, sortClosedTrades, sortFills, sortPositions } from "./wallet-sort.ts";
import type { Position } from "./hyperliquid";

test("position time sorting keeps unknown opening times last", () => {
  const rows = [
    { coin: "OLD", size: 1, entryPx: 1, positionValue: 1, unrealizedPnl: 0, leverage: 1, liquidationPx: null, openedAt: 100 },
    { coin: "UNKNOWN", size: 1, entryPx: 1, positionValue: 1, unrealizedPnl: 0, leverage: 1, liquidationPx: null, openedAt: null },
    { coin: "NEW", size: 1, entryPx: 1, positionValue: 1, unrealizedPnl: 0, leverage: 1, liquidationPx: null, openedAt: 200 },
  ];
  assert.deepEqual(sortPositions(rows, "time-desc").map((row) => row.coin), ["NEW", "OLD", "UNKNOWN"]);
  assert.deepEqual(sortPositions(rows, "time-asc").map((row) => row.coin), ["OLD", "NEW", "UNKNOWN"]);
});

test("position duration and ROI keep unknowns last; compound filters do not fabricate evidence", () => {
  const base = { size: 1, entryPx: 1, positionValue: 1, unrealizedPnl: 10, leverage: 1, liquidationPx: null, source: "journal" };
  const rows = [{ ...base, coin: "BTC", openedAt: 10, marginUsed: 100, lastAction: "ADD" }, { ...base, coin: "ETH", openedAt: 20, marginUsed: 10 }, { ...base, coin: "UNKNOWN", openedAt: null }];
  assert.deepEqual(sortPositions(rows, "duration-desc").map((p) => p.coin), ["BTC", "ETH", "UNKNOWN"]);
  assert.deepEqual(sortPositions(rows, "duration-asc").map((p) => p.coin), ["ETH", "BTC", "UNKNOWN"]);
  assert.equal(sortPositions(rows, "roi-desc")[0].coin, "ETH");
  assert.deepEqual(filterPositions(rows, { coin: "bt", side: "LONG", exactOnly: true, source: "journal", action: "ADD" }).map((p) => p.coin), ["BTC"]);
});

test("wallet rows sort by financial values and durations", () => {
  const fills = [
    { coin: "BTC", px: "10", sz: "2", side: "B" as const, time: 1, dir: "Open Long", closedPnl: "0", fee: "0", hash: "a" },
    { coin: "ETH", px: "5", sz: "10", side: "B" as const, time: 2, dir: "Open Long", closedPnl: "0", fee: "0", hash: "b" },
  ];
  assert.equal(sortFills(fills, "notional-desc")[0].coin, "ETH");
  const trades = [
    { coin: "BTC", direction: "LONG" as const, openedAt: 0, closedAt: 100, entryPx: 1, exitPx: 2, size: 1, netPnl: 1 },
    { coin: "ETH", direction: "LONG" as const, openedAt: 50, closedAt: 250, entryPx: 1, exitPx: 2, size: 1, netPnl: 2 },
  ];
  assert.equal(sortClosedTrades(trades, "duration-desc")[0].coin, "ETH");
});

test("unknown completed duration is last in both sort directions", () => {
  const rows = [{ coin: "BTC", direction: "LONG" as const, openedAt: 1, closedAt: 100, entryPx: 1, exitPx: 1, size: 1, netPnl: 0 }, { coin: "ETH", direction: "LONG" as const, openedAt: null, closedAt: 100, entryPx: null, exitPx: 1, size: 1, netPnl: 0 }];
  assert.equal(sortClosedTrades(rows, "duration-asc")[1].coin, "ETH"); assert.equal(sortClosedTrades(rows, "duration-desc")[1].coin, "ETH");
});

test("unknown financial values stay last before and after JSON serialization in every direction", () => {
  const base: Position = { coin: "A", size: 1, entryPx: 2, positionValue: 2, unrealizedPnl: -2, marginUsed: 10, leverage: 1, liquidationPx: null, openedAt: 100 };
  const rows = [{ ...base, coin: "UNKNOWN", entryPx: NaN, positionValue: NaN, unrealizedPnl: NaN, openedAt: NaN }, base, { ...base, coin: "B", entryPx: 3, positionValue: 3, unrealizedPnl: 2 }];
  for (const dataset of [rows, JSON.parse(JSON.stringify(rows))]) for (const field of ["time", "duration", "entry", "notional", "pnl", "roi"] as const) for (const order of ["asc", "desc"] as const) {
    assert.equal(sortPositions(dataset, `${field}-${order}`).at(-1)?.coin, "UNKNOWN", `${field}-${order}`);
    assert.equal(filterPositions(dataset, { coin: "", side: "all", exactOnly: true }).length, 2);
  }
});

test("explicit unknown precision cannot pass the proven-opening filter", () => {
  const row: Position = { coin: "BTC", size: -1, entryPx: 1, positionValue: 1, unrealizedPnl: 0, leverage: 1, liquidationPx: null, openedAt: 100, openedAtPrecision: "unknown" };
  assert.deepEqual(filterPositions([row], { coin: " btc ", side: "SHORT", exactOnly: true }), []);
  assert.equal(filterPositions([row], { coin: " btc ", side: "SHORT", exactOnly: false }).length, 1);
});
