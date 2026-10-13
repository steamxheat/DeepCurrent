import assert from "node:assert/strict";
import test from "node:test";
import { eventSummary, groupFillMarkers, realizedSeries } from "./chart.ts";
import type { Fill } from "./stats.ts";

const fill = (overrides: Partial<Fill>): Fill => ({
  coin: "BTC", px: "100", sz: "1", side: "B", time: 100,
  dir: "Open Long", closedPnl: "0", fee: "1", hash: crypto.randomUUID(), ...overrides,
});

test("realized series is chronological and includes signed fees", () => {
  assert.deepEqual(realizedSeries([
    fill({ time: 300, dir: "Close Long", closedPnl: "-4" }),
    fill({ time: 200, dir: "Close Long", closedPnl: "11" }),
  ], 100, 400), [[100, 0], [200, 10], [300, 5], [400, 5]]);
});

test("events are summarized and grouped inside the selected range", () => {
  const fills = [
    fill({ time: 110 }),
    fill({ time: 120, dir: "Close Long", closedPnl: "5", fee: "-1" }),
    fill({ time: 180, dir: "Close Short", closedPnl: "-2", fee: "0" }),
    fill({ time: 500 }),
  ];
  assert.deepEqual(eventSummary(fills, 100, 200), { total: 3, opens: 1, closes: 2, wins: 1, losses: 1 });
  assert.deepEqual(groupFillMarkers(fills, 100, 200, 2).map(({ count }) => count), [2, 1]);
});

test("realized net PnL charges opening fees and a zero-gross close fee", () => {
  assert.deepEqual(realizedSeries([fill({ time: 110, startPosition: "0" }), fill({ time: 120, side: "A", startPosition: "1", closedPnl: "0" })], 100, 200), [[100, 0], [110, -1], [120, -2], [200, -2]]);
});
