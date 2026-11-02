import test from "node:test";
import assert from "node:assert/strict";
import { publicSourceData, publicTiming, publicTraderPage } from "./public-exchange-screening.ts";
test("Public source errors cannot become empty successful rankings", () => {
  assert.throws(() => publicSourceData("bingx", { code: 100004, msg: "Illegal Request" }), /API_100004/);
  assert.throws(() => publicSourceData("gate", { code: 0, data: null }), /missing_public_data/);
  assert.deepEqual(publicSourceData("bitget", { code: "200", data: { rows: [] } }), { rows: [] });
});
test("Public pagination validates identity, completion and missing lists", () => {
  assert.equal(publicTraderPage("gate", { list: [{ leader_id: 25353 }], pagecount: 2 }, 1).more, true);
  assert.equal(publicTraderPage("bitget", { rows: [{ traderUid: "abc" }], nextFlag: false }, 1).more, false);
  assert.throws(() => publicTraderPage("bitget", { rows: [], nextFlag: true }, 1), /empty_unfinished/);
  assert.throws(() => publicTraderPage("gate", { list: [{ leader_id: 1 }, { leader_id: 1 }], pagecount: 1 }, 1), /duplicate/);
  assert.throws(() => publicTraderPage("bingx", { total: 0 }, 1), /missing_trader_list/);
});
test("Request duration and server response timestamp never prove event latency", () => {
  const timing = publicTiming({ timestamp: 1500 }, 1000, 2000);
  assert.equal(timing.requestDurationMs, 1000); assert.equal(timing.sourceResponseAt, 1500);
  assert.equal(timing.endToEndDelayMs, null); assert.equal(timing.liveProven, false);
  assert.equal(publicTiming({ timestamp: 3000 }, 1000, 2000).sourceResponseAt, null);
  assert.equal(publicTiming({}, 1000, 2000).exchangeEventAt, null);
});
