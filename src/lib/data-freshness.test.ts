import assert from "node:assert/strict";
import test from "node:test";
import { dataFresh, marketNumber, midsSnapshot } from "./data-freshness.ts";
import { coinMarketNumbers } from "./coin-market.ts";

test("freshness expires at the boundary and rejects missing, future and invalid clocks", () => {
  assert.equal(dataFresh(100, 100, 30_000), true);
  assert.equal(dataFresh(100, 30_099, 30_000), true);
  for (const at of [undefined, null, 0, NaN, Infinity, "100", 100.5, 30_101]) assert.equal(dataFresh(at, 30_100, 30_000), false);
  assert.equal(dataFresh(100, NaN, 30_000), false);
});

test("missing numbers are not zero; actual zero funding and volume remain zero", () => {
  for (const value of [undefined, null, "", " ", "bad", true, [], {}, NaN, Infinity]) assert.ok(Number.isNaN(marketNumber(value)));
  assert.equal(marketNumber("0"), 0); assert.equal(marketNumber(-0.001), -0.001);
  const missing = coinMarketNumbers({});
  assert.ok(Object.values(missing).every(Number.isNaN));
  const actual = coinMarketNumbers({ markPx: "100", prevDayPx: "80", openInterest: "0", funding: "0", dayNtlVlm: "0" });
  assert.equal(actual.change24h, 25); assert.equal(actual.openInterest, 0); assert.equal(actual.funding, 0); assert.equal(actual.volume24h, 0);
  const spot = coinMarketNumbers({}, { price: 100, change: 0, volume: 10 });
  assert.equal(spot.change24h, 0); assert.ok(Number.isNaN(spot.funding));
});

test("quotes cannot inherit previous prices or turn serialized null into zero", () => {
  const quotes = { prices: { BTC: "100", ETH: null, SOL: "0", HYPE: "bad" }, receivedAt: 100 };
  assert.equal(midsSnapshot(quotes, 200).prices.BTC, 100);
  assert.ok(Number.isNaN(midsSnapshot(quotes, 200).prices.ETH));
  assert.ok(Number.isNaN(midsSnapshot(quotes, 200).prices.SOL));
  assert.ok(Object.values(midsSnapshot(quotes, 30_100).prices).every(Number.isNaN));
  assert.ok(Object.values(midsSnapshot(undefined, 100).prices).every(Number.isNaN));
  const wire = JSON.parse(JSON.stringify(midsSnapshot(quotes, 30_100)));
  assert.ok(Object.values(midsSnapshot(wire, 30_100).prices).every(Number.isNaN));
});
