import test from "node:test";
import assert from "node:assert/strict";
import { lighterFill, screenLighterAccount, shouldExpandLighterCandidates, summarizeLighterWallet } from "./lighter-screening.ts";

test("Expensive histories do not block discovery, while pending candidates and page quota bound expansion", () => {
  assert.equal(shouldExpandLighterCandidates(0, 2483, 0, false), true);
  assert.equal(shouldExpandLighterCandidates(1, 2483, 0, false), false);
  assert.equal(shouldExpandLighterCandidates(0, 2483, 2583, false), false);
  assert.equal(shouldExpandLighterCandidates(0, 2583, 2583, false), true);
  assert.equal(shouldExpandLighterCandidates(0, 2583, 2583, true), false);
});

const account = 4;
const trade = (overrides: Record<string, unknown> = {}) => ({ ask_account_id: 8, bid_account_id: account, is_maker_ask: true,
  market_kind: "perps", type: "trade",
  market_id: 1, timestamp: 100, tx_hash: "open", size: "1", price: "100", usd_amount: "100",
  taker_position_size_before: "0", ...overrides });
test("Lighter fees use ppm, preserve side and reject missing closing PnL", () => {
  const fill = lighterFill(trade({ taker_fee: 50 }), account);
  assert.equal(fill.fee, "0.005000"); assert.equal(fill.dir, "OPEN");
  assert.equal(lighterFill(trade({ usd_amount: "0.000001", taker_fee: 1 }), account).fee, "0.000001");
  assert.throws(() => lighterFill(trade({ taker_position_size_before: "-1" }), account), /missing_realized_pnl/);
  assert.throws(() => lighterFill(trade({ bid_account_id: 8 }), account), /unrelated_trade/);
});
test("Zero-price deleverage recovers execution price from exchange notional", () => {
  const fill = lighterFill(trade({ type: "deleverage", price: "0.0000", size: "500", usd_amount: "35.610145", taker_position_size_before: "-500", bid_account_pnl: "7.153421" }), account);
  assert.equal(fill.dir, "CLOSE");
  assert.ok(Math.abs(Number(fill.px) - 0.07122029) < 1e-12);
  assert.throws(() => lighterFill(trade({ price: "0", usd_amount: "0" }), account), /invalid_trade_amount/);
});
test("Wallet screening requires 20 closed positions across subaccounts, complete evidence and positive month P&L", () => {
  const base = { historyComplete: true, transactions60d: 12, closedPositions60d: 20, wins: 16, winRate: 80, unknownOutcomes: 0,
    chainErrors: false, lastActive: 100, statisticalPass: true, positionsVerified: true, openings: [] };
  assert.equal(summarizeLighterWallet([base], 12, 100).status, "verified_wallet_data");
  assert.equal(summarizeLighterWallet([{ ...base, closedPositions60d: 19, wins: 19 }], 12, 100).status, "rejected");
  assert.equal(summarizeLighterWallet([{ ...base, closedPositions60d: 10, wins: 8 }, { ...base, closedPositions60d: 10, wins: 8 }], 12, 100).status, "verified_wallet_data");
  assert.equal(summarizeLighterWallet([base, { ...base, wins: 0 }], 12, 100).status, "rejected");
  assert.equal(summarizeLighterWallet([base, { error: "missing_history" }], 12, 100).status, "needs_review");
  assert.equal(summarizeLighterWallet([base], 5, 100).status, "rejected");
  assert.equal(summarizeLighterWallet([base], 12, 0).status, "rejected");
  assert.equal(summarizeLighterWallet([base], 12, NaN).status, "needs_review");
});
test("Six complete profitable lifecycles pass, partial closes are not separate wins", () => {
  const rows = Array.from({ length: 6 }, (_, index) => [
    trade({ timestamp: index * 10 + 1, tx_hash: `open${index}` }),
    trade({ timestamp: index * 10 + 2, tx_hash: `reduce${index}`, ask_account_id: account, bid_account_id: 8, is_maker_ask: false, size: "0.5", taker_position_size_before: "1", ask_account_pnl: "5" }),
    trade({ timestamp: index * 10 + 3, tx_hash: `close${index}`, ask_account_id: account, bid_account_id: 8, is_maker_ask: false, size: "0.5", taker_position_size_before: "0.5", ask_account_pnl: "5" })
  ]).flat();
  const result = screenLighterAccount(rows, account, [], true, 100);
  assert.equal(result.closedPositions60d, 6); assert.equal(result.winRate, 100); assert.equal(result.statisticalPass, true); assert.equal(result.positionsVerified, true);
  assert.equal(screenLighterAccount(rows, account, [], false, 100).statisticalPass, false);
  assert.equal(screenLighterAccount(rows.slice(1), account, [], true, 100).statisticalPass, false);
});
test("An unknown or mismatching current opening cannot pass position verification", () => {
  const rows = [trade({ taker_position_size_before: "2" })];
  const result = screenLighterAccount(rows, account, [{ market_id: 1, symbol: "BTC", sign: 1, position: "3", avg_entry_price: "100", unrealized_pnl: "0", realized_pnl: "0", liquidation_price: "10", allocated_margin: "10", initial_margin_fraction: "10" }], true, 100);
  assert.equal(result.positionsVerified, false); assert.equal(result.openings[0].openedAt, null);
  assert.equal(screenLighterAccount([trade()], account, [], true, 100).positionsVerified, false);
  assert.throws(() => screenLighterAccount([trade()], account, [{ market_id: 1, sign: 1, position: "1" }], true, 100), /incomplete_current_position/);
});
