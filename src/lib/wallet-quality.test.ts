import assert from "node:assert/strict";
import test from "node:test";
import { hasPositiveMonthPnl, walletQuality } from "./wallet-quality.ts";

test("positive 30D PnL excludes zero, losses and invalid values", () => {
  assert.equal(hasPositiveMonthPnl(1), true);
  assert.equal(hasPositiveMonthPnl(0), false);
  assert.equal(hasPositiveMonthPnl(-1), false);
  assert.equal(hasPositiveMonthPnl(Number.NaN), false);
});

test("wallet quality rejects weak histories and rewards durable profit", () => {
  assert.equal(walletQuality({ accountValue: 99_999, monthPnl: 20_000, monthVolume: 2_000_000, weekPnl: 1, monthRoi: 20, dayPnl: 1 }), null);
  assert.equal(walletQuality({ accountValue: 200_000, monthPnl: 20_000, monthVolume: 2_000_000, weekPnl: -1, monthRoi: 20, dayPnl: 1 }), null);
  assert.equal(walletQuality({ accountValue: 200_000, monthPnl: 20_000, monthVolume: 999_999, weekPnl: 1, monthRoi: 20, dayPnl: 1 }), null);
  const steady = walletQuality({ accountValue: 1_000_000, monthPnl: 100_000, monthVolume: 2_000_000, weekPnl: 10_000, monthRoi: 20, dayPnl: 2_000 });
  const stronger = walletQuality({ accountValue: 2_000_000, monthPnl: 200_000, monthVolume: 4_000_000, weekPnl: 20_000, monthRoi: 35, dayPnl: 4_000 });
  assert.ok(steady !== null && stronger !== null && stronger > steady);
});
