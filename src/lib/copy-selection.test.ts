import test from "node:test";
import assert from "node:assert/strict";
import { copyQualityDecision, copySelectionCriteria, lifetimeLighterAccount, lifetimeWalletDecision } from "./copy-selection.ts";
const now = 100 * 86400000;
const fill = (id: string, time: number, side: "open" | "close", pnl = "0") => ({ trade_id_str: id, timestamp: time,
  tx_hash: id, ask_account_id: side === "close" ? 4 : 8, bid_account_id: side === "close" ? 8 : 4,
  is_maker_ask: side === "open", market_kind: "perps", type: "trade", market_id: 1,
  size: "1", price: "100000", usd_amount: "100000", taker_position_size_before: side === "open" ? "0" : "1", ask_account_pnl: pnl });
test("Lifetime winrate includes old losing cycles, not just recent winners", () => {
  const trades = [fill("old1", 1, "open"), fill("old2", 2, "close", "-10"),
    fill("new1", now - 5, "open"), fill("new2", now - 4, "close", "10")];
  const a = lifetimeLighterAccount(trades, 4, [], true, now);
  assert.equal(a.closedPositionsLifetime, 2); assert.equal(a.winRateLifetime, 50);
  assert.equal(lifetimeWalletDecision([a], 100, 500000).status, "rejected");
});
test("Five actions and300k monthly volume apply without an invented20-closure threshold", () => {
  const trades = Array.from({ length: 3 }, (_, i) => [fill(`o${i}`, now - 10 + 2 * i, "open"), fill(`c${i}`, now - 9 + 2 * i, "close", "5")]).flat();
  const a = lifetimeLighterAccount(trades, 4, [], true, now); const r = lifetimeWalletDecision([a], 15, 600000);
  assert.equal(r.status, "needs_review"); assert.equal(r.fullyAccepted, false);
  assert.equal(a.closedPositionsLifetime, 3); assert.equal(r.tradeActions60d, 6);
  assert.equal(lifetimeWalletDecision([a], -1, 600000).status, "rejected");
  assert.equal(lifetimeWalletDecision([a], 15, NaN).status, "needs_review");
  assert.equal(lifetimeWalletDecision([{ ...a, apiEndReached: false }], 15, 600000).status, "needs_review");
  const quality = { officialNetPnl30dUsd: "50000", maximumDrawdownPct: 20, drawdownVerified: true, nonScalpingVerified: true };
  assert.equal(lifetimeWalletDecision([a], 50000, 600000, quality).status, "historical_candidate_pending_live");
  assert.equal(lifetimeWalletDecision([a], 50000, 600000, { ...quality, maximumDrawdownPct: 21 }).status, "rejected");
});
test("Quality requires50k official30d profit, verified20pct maximum drawdown and non-scalping", () => {
  const evidence = { officialNetPnl30dUsd: "50000", maximumDrawdownPct: 20, drawdownVerified: true, nonScalpingVerified: true };
  assert.equal(copySelectionCriteria.target, 20);
  assert.equal(copyQualityDecision(evidence).status, "quality_passed_pending_history_live");
  assert.deepEqual(copyQualityDecision({ ...evidence, officialNetPnl30dUsd: "49999.999999999999" }), { status: "rejected", reasons: ["net_pnl30d_below_50000"] });
  assert.equal(copyQualityDecision({ ...evidence, maximumDrawdownPct: 20.0001 }).status, "rejected");
  assert.equal(copyQualityDecision({ ...evidence, nonScalpingVerified: false }).status, "rejected");
  assert.equal(copyQualityDecision().status, "needs_review");
  for (const maximumDrawdownPct of [null, NaN, Infinity, -1]) assert.equal(copyQualityDecision({ ...evidence, maximumDrawdownPct }).status, "needs_review");
  assert.equal(copyQualityDecision({ ...evidence, drawdownVerified: false }).status, "needs_review");
  for (const officialNetPnl30dUsd of [null, "NaN", "Infinity", "1e999"]) assert.equal(copyQualityDecision({ ...evidence, officialNetPnl30dUsd }).status, "needs_review");
  assert.equal(copyQualityDecision({ ...evidence, nonScalpingVerified: null }).status, "needs_review");
});
test("Missing first position, future executions and conflicting IDs never pass", () => {
  const row = fill("c", now - 1, "close", "5");
  const a = lifetimeLighterAccount([row], 4, [], true, now); assert.equal(a.continuousFromFlat, false);
  assert.throws(() => lifetimeLighterAccount([fill("f", now + 1, "open")], 4, [], true, now), /invalid_trade_time/);
  assert.throws(() => lifetimeLighterAccount([row, { ...row, ask_account_pnl: "6" }], 4, [], true, now), /conflicting_trade/);
});
