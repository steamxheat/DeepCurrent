import test from "node:test";
import assert from "node:assert/strict";
import { replayDydxRawFills } from "./dydx-raw-audit.ts";

const asOf = Date.parse("2026-10-15T00:00:00Z");
const fill = (id: string, height: number, side: string, size: string, price: string, fee = "0") => ({ id, createdAtHeight: String(height), createdAt: new Date(asOf - 86400000 + height * 1000).toISOString(), side, size, price, fee, market: "BTC-USD", marketType: "PERPETUAL" });
test("raw dYdX independently calculates a full cycle, not partial-fill winrate", () => {
  const fills = [fill("a", 1, "BUY", "2", "100", "1"), fill("b", 2, "SELL", "1", "110", "1"), fill("c", 3, "SELL", "1", "90", "1")];
  const positions = [{ market: "BTC-USD", status: "CLOSED", createdAt: fills[0].createdAt, closedAt: fills[2].createdAt, netFunding: "-2" }];
  const result = replayDydxRawFills(fills, positions, [], 3, asOf, true);
  assert.equal(result.closedPositionsLifetime, 1); assert.equal(result.winsLifetime, 0); assert.equal(result.cycles[0].netPnl, -5);
  assert.equal(result.volume30dUsd, "400"); assert.equal(result.independentFillAudit, true); assert.equal(result.fullyAccepted, false);
});
test("raw dYdX preserves canonical tied order and allocates flip fees", () => {
  const first = fill("a", 1, "BUY", "1", "100", "1"), flip = fill("b", 2, "SELL", "2", "110", "2");
  const position = { market: "BTC-USD", status: "CLOSED", createdAt: first.createdAt, closedAt: flip.createdAt, netFunding: "0" };
  const result = replayDydxRawFills([first, flip], [position], [{ market: "BTC-USD", size: "-1", entryPrice: "110", createdAt: flip.createdAt }], 2, asOf, true);
  assert.equal(result.cycles[0].netPnl, 8); assert.equal(result.openings[0].fees, 1); assert.equal(result.openings[0].size, "-1");
});
test("raw dYdX rejects missing pages, reordered heights, extra costs and gaps", () => {
  const a = fill("a", 1, "BUY", "1", "100");
  assert.throws(() => replayDydxRawFills([a], [], [], 1, asOf, false), /incomplete/);
  assert.throws(() => replayDydxRawFills([fill("b", 2, "BUY", "1", "100"), a], [], [], 2, asOf, true), /canonical/);
  assert.throws(() => replayDydxRawFills([{ ...a, builderFee: "1" }], [], [], 1, asOf, true), /additional_fee/);
  assert.throws(() => replayDydxRawFills([{ ...a, positionSizeBefore: "2", positionSideBefore: "LONG" }], [], [], 1, asOf, true), /continuity/);
});
test("raw dYdX rebate and exact notional do not become zero or float thresholds", () => {
  const a = fill("a", 1, "BUY", "3", "0.1", "-1"), b = fill("b", 2, "SELL", "3", "0.1");
  const result = replayDydxRawFills([a, b], [{ market: "BTC-USD", status: "CLOSED", createdAt: a.createdAt, closedAt: b.createdAt, netFunding: "0" }], [], 2, asOf, true);
  assert.equal(result.volume30dUsd, "0.6"); assert.equal(result.cycles[0].netPnl, 1);
});
test("raw dYdX distinguishes API all-open entry from remaining-inventory PnL basis", () => {
  const a = fill("a", 1, "BUY", "2", "100"), b = fill("b", 2, "SELL", "1", "120"), c = fill("c", 3, "BUY", "1", "80");
  const d = { ...fill("d", 4, "SELL", "2", "90"), positionSizeBefore: "2", positionSideBefore: "LONG", entryPriceBefore: "93.33333333333333333333" };
  const result = replayDydxRawFills([a, b, c, d], [{ market: "BTC-USD", status: "CLOSED", createdAt: a.createdAt, closedAt: d.createdAt, netFunding: "0" }], [], 4, asOf, true);
  assert.equal(result.cycles[0].netPnl, 20);
  const open = replayDydxRawFills([a, b, c], [], [{ market: "BTC-USD", size: "2", entryPrice: d.entryPriceBefore, createdAt: a.createdAt }], 3, asOf, true);
  assert.equal(open.openings[0].average, 90); assert.ok(Math.abs(open.openings[0].displayAverage - 93.33333333333333) < 1e-8);
});
