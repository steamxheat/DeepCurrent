import assert from "node:assert/strict";
import test from "node:test";
import { coinCandleRequest, findCoinMarket } from "./coin-market.ts";

test("BTC resolves without waiting for unrelated DEX requests", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await findCoinMarket("BTC", async <T>(body: Record<string, unknown>) => {
    calls.push(body); assert.equal(body.dex, undefined); assert.equal(body.type, "metaAndAssetCtxs");
    return [{ universe: [{ name: "BTC" }] }, [{ markPx: "100" }]] as T;
  });
  assert.equal(calls.length, 1); assert.equal(result?.market.markPx, "100");
});
test("explicit DEX names cannot select another venue; unknown coins still search DEXes", async () => {
  const calls: Record<string, unknown>[] = [];
  const info = async <T>(body: Record<string, unknown>) => {
    calls.push(body);
    if (body.type === "perpDexs") return [null, { name: "xyz" }, { name: "offline" }] as T;
    if (body.dex === "offline") throw new Error("offline");
    return [{ universe: [{ name: body.dex ? "xyz:BTC" : "ETH" }] }, [{ markPx: "200" }]] as T;
  };
  assert.equal((await findCoinMarket("xyz:BTC", info))?.name, "xyz:BTC"); assert.equal(calls.length, 1);
  assert.equal((await findCoinMarket("BTC", info))?.dex, "xyz");
  assert.equal(await findCoinMarket("MISSING", info), null);
});
test("candle keys are stable inside their TTL and never include future data", () => {
  const first = coinCandleRequest("BTC", 150001);
  assert.deepEqual(first, coinCandleRequest("BTC", 164999));
  assert.notDeepEqual(first, coinCandleRequest("BTC", 165000));
  assert.notDeepEqual(first, coinCandleRequest("ETH", 150001));
  assert.ok(first.req.endTime <= 150001); assert.equal(first.req.endTime - first.req.startTime, 7 * 86400000);
});
