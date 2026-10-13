import assert from "node:assert/strict";
import test from "node:test";
import { encodeLiveFills, decodeLiveFills } from "./live-wire.ts";

test("compact live messages retain IDs, decimal amounts, precision and millisecond time", () => {
  const fill = { wallet: `0x${"a".repeat(40)}`, coin: "xyz:GOLD", time: 123456789, tid: 0, px: "0.0000001", sz: "10000000", side: "B" as const,
    hash: "h", dir: "Open Long", fee: "-0.01", feeToken: "HYPE", closedPnl: "0", startPosition: "0", source: "user" as const };
  const [decoded] = decodeLiveFills(JSON.parse(JSON.stringify(encodeLiveFills([fill]))));
  assert.deepEqual(decoded, { ...fill, walletName: fill.wallet });
  assert.equal(decodeLiveFills(encodeLiveFills([{ ...fill, source: "market" }]))[0].startPosition, undefined);
});

test("live wire carries lifecycle status and preserves a close after later enrichment", () => {
  const fill = { wallet: `0x${"a".repeat(40)}`, coin: "BTC", time: 100, px: "100", sz: "1", side: "B", hash: "h", dir: "Open Long", source: "user", startPosition: "0", positionStatus: "closed" as const, openedAt: 100, closedAt: 200, netPnl: 10, receivedAt: 110, action: "OPEN", direction: "LONG" };
  const [decoded] = decodeLiveFills(JSON.parse(JSON.stringify(encodeLiveFills([fill]))));
  assert.equal(decoded.closedAt, 200); assert.equal(decoded.positionStatus, "closed"); assert.equal(decoded.receivedAt, 110); assert.equal(decoded.action, "OPEN");
});
