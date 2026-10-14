import assert from "node:assert/strict";
import test from "node:test";
import { baseMarketSymbol, coinFlowChange, coinParticipants } from "./coin-intelligence.ts";
import type { JournalEvent, PositionSnapshot } from "./event-store.ts";

const event = (overrides: Partial<JournalEvent>): JournalEvent => ({ eventKey: Math.random().toString(), wallet: "0x1", coin: "BTC", action: "OPEN", direction: "LONG", time: 900, price: 100, notional: 100, source: "test", precision: "exact", ...overrides });

test("market symbols match perp, HIP-3, and HyperCore spot names", () => {
  assert.equal(baseMarketSymbol("BTC"), "BTC");
  assert.equal(baseMarketSymbol("xyz:GOOGL"), "GOOGL");
  assert.equal(baseMarketSymbol("UBTC/USDC"), "BTC");
  assert.equal(baseMarketSymbol("UNI/USDC"), "UNI");
});

test("coin flow measures exposure changes rather than counting closes as new positions", () => {
  const result = coinFlowChange([
    event({ beforeSize: 0, afterSize: 2, notional: 200 }),
    event({ action: "REDUCE", beforeSize: 2, afterSize: 1, notional: 100 }),
    event({ wallet: "0x2", direction: "SHORT", beforeSize: 0, afterSize: -3, notional: 300 }),
  ], 1_000, 500);
  assert.deepEqual(result, { long: 100, short: 300, net: -200, wallets: 2 });
});

test("coin flow excludes stale and non-position journal entries", () => {
  const result = coinFlowChange([event({ time: 100 }), event({ action: "FUNDING", direction: undefined })], 1_000, 500);
  assert.deepEqual(result, { long: 0, short: 0, net: 0, wallets: 0 });
});

test("coin participants prefer a current position and keep observed activity separate", () => {
  const snapshot: PositionSnapshot = { wallet: "0x1", coin: "BTC", capturedAt: 990, size: 2, entryPx: 90, positionValue: 180, unrealizedPnl: 20, leverage: 5, liquidationPx: null, marginUsed: 36, source: "state" };
  const result = coinParticipants([
    event({ wallet: "0x1", walletName: "Alpha", direction: "SHORT", action: "OPEN", notional: 500 }),
    event({ wallet: "0x2", walletName: "Beta", direction: "SHORT", action: "OPEN", notional: 300 }),
    event({ wallet: "0x2", direction: "SHORT", action: "ADD", notional: 200, time: 950 }),
    event({ wallet: "0x2", direction: "LONG", action: "OPEN", notional: 1_000, time: 800 }),
    event({ wallet: "0x3", direction: "LONG", action: "CLOSE", notional: 900 }),
    event({ wallet: "0x4", direction: "LONG", action: "BUY", notional: 900 }),
  ], [snapshot], 1_000, 500);
  assert.deepEqual(result, [
    { wallet: "0x1", walletName: "Alpha", direction: "LONG", notional: 180, lastTime: 990, events: 0, kind: "position", unrealizedPnl: 20 },
    { wallet: "0x2", walletName: "Beta", direction: "SHORT", notional: 500, lastTime: 950, events: 2, kind: "activity" },
  ]);
});

test("stale and future coin snapshots cannot become current participants", () => {
  const snapshot: PositionSnapshot = { wallet: "0x1", coin: "BTC", capturedAt: 100, size: 2, entryPx: 90, positionValue: 180, unrealizedPnl: 20, leverage: 5, liquidationPx: null, marginUsed: 36, source: "state" };
  assert.deepEqual(coinParticipants([], [snapshot], 30_100), []);
  assert.deepEqual(coinParticipants([], [snapshot], 99), []);
});
