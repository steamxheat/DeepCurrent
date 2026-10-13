import assert from "node:assert/strict";
import test from "node:test";
import { copyabilityScore, maximumDrawdown } from "./copyability.ts";
import type { ClosedTrade, Fill } from "./stats.ts";

const fill = (time: number, overrides: Partial<Fill> = {}): Fill => ({ coin: "BTC", px: "100", sz: "10", side: "B", time, dir: "Open Long", closedPnl: "100", fee: "-1", hash: String(time), crossed: false, ...overrides });
const trade = (openedAt: number, closedAt: number): ClosedTrade => ({ coin: "BTC", direction: "LONG", openedAt, closedAt, entryPx: 100, exitPx: 110, size: 10, netPnl: 99 });

test("copyability rewards slow liquid strategies and reports modeled delays", () => {
  const fills = Array.from({ length: 12 }, (_, index) => fill(index * 86_400_000));
  const closedTrades = Array.from({ length: 12 }, (_, index) => trade(index * 86_400_000, index * 86_400_000 + 14_400_000));
  const result = copyabilityScore({ fills, closedTrades, accountValue: [[0, 100_000], [1, 110_000], [2, 108_000]], marketVolumes: { BTC: 1_000_000_000 } });
  assert.ok(result.score >= 45);
  assert.equal(result.medianHoldMs, 14_400_000);
  assert.equal(result.makerShare, 100);
  assert.equal(result.delayResults.length, 4);
  assert.equal(result.delayResults.every((row) => !row.measured), true);
});

test("copyability refuses a losing or tiny history", () => {
  const result = copyabilityScore({ fills: [fill(1, { closedPnl: "-100" })], closedTrades: [trade(0, 1)], accountValue: [[0, 100], [1, 40]] });
  assert.equal(result.verdict, "avoid");
  assert.ok(result.score < 45);
  assert.equal(result.confidence, "low");
});

test("maximum drawdown uses the prior equity peak", () => {
  assert.equal(maximumDrawdown([[0, 100], [1, 120], [2, 90], [3, 110]]), 25);
});

test("maximum drawdown ignores unavailable zero-value portfolio points", () => {
  assert.equal(maximumDrawdown([[0, 0], [1, 100], [2, 80]]), 20);
  assert.equal(maximumDrawdown([[0, 0], [1, 0]]), null);
});
