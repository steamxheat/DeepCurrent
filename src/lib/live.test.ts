import test from "node:test";
import assert from "node:assert/strict";
import { activityKind, marketIdentity, mergePulseFills, spotCoinNames, tradeFills } from "./live.ts";

test("spot markets and public trades become readable wallet activity", () => {
  const names = spotCoinNames({
    tokens: [{ index: 0, name: "USDC" }, { index: 150, name: "HYPE" }],
    universe: [{ index: 107, name: "@107", tokens: [150, 0] }],
  });
  assert.equal(names["@107"], "HYPE/USDC");

  const fills = tradeFills([{ coin: "@107", px: "40", sz: "2", time: 1, hash: "0x1", users: ["0xABC", "0xDEF"] }], new Map([["0xabc", "Trader"]]), names);
  assert.equal(fills.length, 1);
  assert.deepEqual({ coin: fills[0].coin, wallet: fills[0].wallet, dir: fills[0].dir, side: fills[0].side }, { coin: "HYPE/USDC", wallet: "0xabc", dir: "Buy", side: "B" });
  assert.deepEqual(activityKind(fills[0]), { label: "BUY", direction: "BUY", exact: false, kind: "gain" });
  assert.deepEqual(marketIdentity("xyz:CBRS"), { symbol: "CBRS", venue: "XYZ perpetual", type: "PERP" });
});

test("exact fills distinguish an open from a reduction", () => {
  assert.equal(activityKind({ dir: "Open Long", side: "B", source: "user", startPosition: "0", sz: "2" }).label, "OPEN");
  assert.equal(activityKind({ dir: "Close Long", side: "A", source: "user", startPosition: "2", sz: "1" }).label, "REDUCE");
  assert.equal(activityKind({ dir: "Close Long", side: "A", source: "user", startPosition: "2", sz: "2" }).label, "CLOSE");
});

test("live buffer preserves exact wallet history when public trades arrive", () => {
  const exact = Array.from({ length: 130 }, (_, index) => ({ coin: "BTC", px: "100", sz: "1", side: "B" as const, time: index, dir: "Open Long", closedPnl: "0", fee: "0", hash: `exact-${index}`, wallet: "0xbusy", walletName: "Busy", source: "user" as const }));
  exact.push({ ...exact[0], time: 200, hash: "quiet", wallet: "0xquiet", walletName: "Quiet" });
  const market = Array.from({ length: 1_000 }, (_, index) => ({ ...exact[0], time: index + 100, hash: `market-${index}`, source: "market" as const }));
  const merged = mergePulseFills(exact, market);
  assert.equal(merged.filter((fill) => fill.source !== "market" && fill.wallet === "0xbusy").length, 120);
  assert.equal(merged.filter((fill) => fill.source !== "market" && fill.wallet === "0xquiet").length, 1);
  assert.equal(merged.filter((fill) => fill.source === "market").length, 800);
});
