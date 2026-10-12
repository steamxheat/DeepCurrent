import assert from "node:assert/strict";
import test from "node:test";
import { closedTrades, computeFillStats, findConfluences, mergeFills, positionOpenedAt, type Fill } from "./stats.ts";

const fill = (overrides: Partial<Fill>): Fill => ({
  coin: "BTC", px: "100", sz: "1", side: "B", time: 1_000, dir: "Open Long",
  closedPnl: "0", fee: "-1", hash: Math.random().toString(), wallet: "0x1", ...overrides,
});

test("fill stats use only closed trades and include signed fees", () => {
  const result = computeFillStats([
    fill({ closedPnl: "11", fee: "-1" }),
    fill({ closedPnl: "-4", fee: "-1" }),
    fill({ closedPnl: "0", fee: "-1" }),
  ]);
  assert.deepEqual(result, { closed: 2, wins: 1, winRate: 50, profitFactor: 2, netPnl: 5 });
});

test("confluence requires two unique wallets in the same market and direction", () => {
  const result = findConfluences([
    fill({ wallet: "0x1" }), fill({ wallet: "0x2", time: 900 }),
    fill({ wallet: "0x1", time: 800 }), fill({ wallet: "0x3", dir: "Open Short" }),
  ], 1_000, 500);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].wallets.sort(), ["0x1", "0x2"]);
});

test("position opening time survives later additions and reductions", () => {
  const fills = [
    fill({ time: 100, sz: "4", side: "B" }),
    fill({ time: 200, sz: "3", side: "B" }),
    fill({ time: 300, sz: "2", side: "A", dir: "Close Long" }),
  ];
  assert.equal(positionOpenedAt(5, "BTC", fills), 100);
});

test("position opening time is the fill that flipped its direction", () => {
  const fills = [fill({ time: 100, sz: "10", side: "B", dir: "Open Long" })];
  assert.equal(positionOpenedAt(5, "BTC", fills), 100);
});

test("fill history pagination stays newest-first and removes inclusive-page duplicates", () => {
  const oldest = fill({ time: 100, tid: 1, hash: "0xa" });
  const newest = fill({ time: 300, tid: 3, hash: "0xc" });
  assert.deepEqual(mergeFills([oldest, fill({ time: 200, tid: 2, hash: "0xb" })], [newest, oldest]), [newest, fill({ time: 200, tid: 2, hash: "0xb" }), oldest]);
});

test("closed trades combine partial reductions and preserve duration", () => {
  const result = closedTrades([
    fill({ time: 100, sz: "4", side: "B", startPosition: "0", px: "100", fee: "-1" }),
    fill({ time: 200, sz: "1", side: "A", startPosition: "4", px: "110", dir: "Close Long", closedPnl: "10", fee: "-1" }),
    fill({ time: 300, sz: "3", side: "A", startPosition: "3", px: "120", dir: "Close Long", closedPnl: "60", fee: "-1" }),
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { coin: "BTC", direction: "LONG", openedAt: 100, closedAt: 300, entryPx: 100, exitPx: 117.5, size: 4, netPnl: 67 });
});

test("closed trades mark an opening before available history as unknown", () => {
  const [trade] = closedTrades([fill({ time: 300, sz: "2", side: "B", startPosition: "-2", dir: "Close Short", closedPnl: "5" })]);
  assert.equal(trade.openedAt, null);
  assert.equal(trade.direction, "SHORT");
});
