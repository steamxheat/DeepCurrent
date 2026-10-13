import assert from "node:assert/strict";
import test from "node:test";
import { coinFlowChange } from "./coin-intelligence.ts";
import type { JournalEvent } from "./event-store.ts";

const event = (overrides: Partial<JournalEvent>): JournalEvent => ({ eventKey: Math.random().toString(), wallet: "0x1", coin: "BTC", action: "OPEN", direction: "LONG", time: 900, price: 100, notional: 100, source: "test", precision: "exact", ...overrides });

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
