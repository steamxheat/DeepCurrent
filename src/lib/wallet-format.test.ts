import assert from "node:assert/strict";
import test from "node:test";
import { walletDuration, walletMoney, walletPrice, walletTime, fillSourceUrl } from "./wallet-format.ts";

test("wallet values preserve small amounts and never format missing money as zero", () => {
  assert.equal(walletMoney(null), "—"); assert.equal(walletMoney(NaN), "—");
  assert.equal(walletMoney(-0.01, true), "-$0.01"); assert.equal(walletMoney(0.000001, true), "$0.000001");
});

test("source links never invent a transaction for missing or placeholder hashes", () => {
  assert.equal(fillSourceUrl("h"), null); assert.equal(fillSourceUrl(`0x${"0".repeat(64)}`), null);
  assert.match(fillSourceUrl(`0x${"a".repeat(64)}`)!, /explorer\/tx\/0x/);
});
test("small prices and fees never become a false zero and price ticks are retained", () => {
  assert.equal(walletMoney(1e-9), "$0.000000001"); assert.equal(walletPrice(0.00000012345), "$0.00000012345");
  assert.equal(walletPrice(2.3456), "$2.3456"); assert.equal(walletPrice(83_120.23), "$83,120.23");
  assert.match(walletMoney(-1e-25), /^-<\$/); assert.equal(walletPrice(NaN), "—");
});
test("wallet times include MSK seconds and short durations are not rounded to zero minutes", () => {
  assert.equal(walletTime(Date.UTC(2026, 9, 13, 10, 11, 12)), "13.10.2026, 13:11:12");
  assert.equal(walletDuration(10_000), "10с"); assert.equal(walletDuration(65_000), "1м 5с");
});
