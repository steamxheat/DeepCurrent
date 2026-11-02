import test from "node:test";
import assert from "node:assert/strict";
import { okxNotional, okxPnl30d, screenOkxLead, visibleOkxPosition } from "./okx-screening.ts";

const day = 86400000; const asOf = 100 * day;
const instruments = new Map([ ["BTC-USDT-SWAP", { ctVal: "0.01", ctValCcy: "BTC" }], ["BTC-USD-SWAP", { ctVal: "100", ctValCcy: "USD" }] ]);
const pnl = [{ beginTs: String(asOf), pnl: "100" }, { beginTs: String(asOf - 30 * day), pnl: "20" }];
const row = (id: number, overrides: Record<string, unknown> = {}) => ({ subPosId: String(id), instId: "BTC-USDT-SWAP", posSide: "long", ccy: "USDT",
  openTime: String(asOf - day + id * 1000), closeTime: String(asOf - day + id * 1000 + 100), openAvgPx: "100000", closeAvgPx: "100001", subPos: "1000", pnl: "1", ...overrides });

test("OKX contract counts use the multiplier and inverse USD value, not raw coin amounts", () => {
  assert.equal(okxNotional(row(1), "openAvgPx", instruments), 1000000);
  assert.equal(okxNotional(row(1, { instId: "BTC-USD-SWAP" }), "openAvgPx", instruments), 100000);
  assert.throws(() => okxNotional(row(1, { subPos: "" }), "openAvgPx", instruments), /missing_or_invalid/);
  assert.equal(visibleOkxPosition(row(1, { instId: "" })), false);
});
test("OKX official accumulated PnL needs both exact boundaries and fresh data", () => {
  assert.equal(okxPnl30d(pnl, asOf).pnl, "80");
  assert.throws(() => okxPnl30d(pnl.slice(0, 1), asOf), /missing_30d/);
  assert.throws(() => okxPnl30d(pnl, asOf + 2 * day), /stale/);
});
test("Duplicate orders are deduplicated, overlapping adds count once, and open cycles remain open", () => {
  const a = row(1); const b = row(2, { openTime: a.openTime, closeTime: String(Number(a.closeTime) + 2000) });
  const report = screenOkxLead([a, a, b], [], pnl, instruments, asOf);
  assert.equal(report.historyRecords, 2); assert.equal(report.closedPositions60d, 1);
  const current = row(3, { openTime: a.openTime });
  assert.equal(screenOkxLead([a, b], [current], pnl, instruments, asOf).closedPositions60d, 0);
  assert.throws(() => screenOkxLead([a, { ...a, pnl: "2" }], [], pnl, instruments, asOf), /conflicting/);
});
test("Even high public statistics do not establish net winrate, all accounts or live latency", () => {
  const report = screenOkxLead(Array.from({ length: 20 }, (_, i) => row(i + 1)), [], pnl, instruments, asOf);
  assert.equal(report.reportedCriteriaPass, true); assert.equal(report.reportedWinRate, 100);
  assert.equal(report.netWinRate, null); assert.equal(report.status, "needs_review");
  assert.throws(() => screenOkxLead([], [row(1, { openTime: "" })], pnl, instruments, asOf), /hidden_current/);
});

test("A zero or unknown winrate and nonpositive month cannot pass the public prefilter", () => {
  const empty = screenOkxLead([], [], pnl, instruments, asOf);
  assert.equal(empty.reportedWinRate, null); assert.equal(empty.reportedCriteriaPass, false);
  const loss = screenOkxLead(Array.from({ length: 20 }, (_, i) => row(i + 1, { pnl: "-1" })), [], pnl, instruments, asOf);
  assert.equal(loss.reportedWinRate, 0); assert.ok(loss.failures.includes("reported_winrate_below_60"));
  const flat = screenOkxLead(Array.from({ length: 20 }, (_, i) => row(i + 1)), [], pnl.map(p => ({ ...p, pnl: "0" })), instruments, asOf);
  assert.ok(flat.failures.includes("nonpositive_30d_pnl"));
});
test("Old entries contribute only their recent close notional, and future fields cannot pass", () => {
  const old = row(1, { openTime: String(asOf - 40 * day) });
  assert.equal(screenOkxLead([old], [], pnl, instruments, asOf).observedVolumeLowerBound30d, 1000010);
  assert.throws(() => screenOkxLead([row(1, { closeTime: String(asOf + 1) })], [], pnl, instruments, asOf), /invalid_closed/);
});
