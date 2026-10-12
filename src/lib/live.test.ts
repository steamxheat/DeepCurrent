import test from "node:test";
import assert from "node:assert/strict";
import { activityKind, spotCoinNames, tradeFills } from "./live.ts";

test("spot markets and public trades become readable wallet activity", () => {
  const names = spotCoinNames({
    tokens: [{ index: 0, name: "USDC" }, { index: 150, name: "HYPE" }],
    universe: [{ index: 107, name: "@107", tokens: [150, 0] }],
  });
  assert.equal(names["@107"], "HYPE/USDC");

  const fills = tradeFills([{ coin: "@107", px: "40", sz: "2", time: 1, hash: "0x1", users: ["0xABC", "0xDEF"] }], new Map([["0xabc", "Trader"]]), names);
  assert.equal(fills.length, 1);
  assert.deepEqual({ coin: fills[0].coin, wallet: fills[0].wallet, dir: fills[0].dir, side: fills[0].side }, { coin: "HYPE/USDC", wallet: "0xabc", dir: "Buy", side: "B" });
  assert.deepEqual(activityKind(fills[0]), { label: "BUY", kind: "gain" });
});
