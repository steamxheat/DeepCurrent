import assert from "node:assert/strict";
import test from "node:test";
import { computeFillStats, findConfluences, type Fill } from "./stats.ts";

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
