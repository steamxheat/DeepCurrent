import assert from "node:assert/strict";
import test from "node:test";
import { auditDydxReportedHistory, dydxOfficialPnl30d } from "./dydx-screening.ts";

const asOf = Date.parse("2026-10-15T00:00:00Z");
const open = { id: "open", marketId: "BTC-USD", time: "2026-10-01T00:00:00Z", action: "OPEN", side: "BUY", prevSize: "0", additionalSize: "2", value: "200000", netFee: "10", netRealizedPnl: "0" };
const partial = { ...open, id: "partial", time: "2026-10-02T00:00:00Z", action: "PARTIAL_CLOSE", side: "SELL", prevSize: "2", additionalSize: "-1", value: "110000", netFee: "20", netRealizedPnl: "100" };
const close = { ...partial, id: "close", time: "2026-10-03T00:00:00Z", action: "CLOSE", prevSize: "1", netFee: "30", netRealizedPnl: "200" };
const position = { market: "BTC-USD", status: "CLOSED", createdAt: open.time, closedAt: close.time, size: "0", netFunding: "-180" };
test("dYdX counts complete lifecycle once and includes fees and signed funding", () => {
  const result = auditDydxReportedHistory([close, open, partial], [position], [], true, asOf);
  assert.equal(result.closedPositionsLifetime, 1); assert.equal(result.winsLifetime, 0); assert.equal(result.cycles[0].netPnl, "-10");
  assert.equal(result.volume30dUsd, "420000"); assert.equal(result.fullyAccepted, false);
});
test("dYdX never turns partial history, missing fees or mismatched positions into success", () => {
  assert.throws(() => auditDydxReportedHistory([partial, close], [position], [], true, asOf), /continuity/);
  assert.throws(() => auditDydxReportedHistory([open, partial, { ...close, netFee: null }], [position], [], true, asOf), /decimal/);
  assert.throws(() => auditDydxReportedHistory([open], [], [{ market: "BTC-USD", size: "1", createdAt: open.time }], true, asOf), /mismatch/);
});
test("dYdX lifetime denominator includes losing cycles, not partial closes", () => {
  const result = auditDydxReportedHistory([open, partial, close], [{ ...position, netFunding: "0" }], [], true, asOf);
  assert.equal(result.winRateLifetime, 100); assert.equal(result.cycles[0].netPnl, "170"); assert.ok(result.sampleWarning);
  assert.equal(auditDydxReportedHistory([], [], [], false, asOf).winRateLifetime, null);
});
test("dYdX lifetime winrate includes old losing positions and a rebate is a real credit", () => {
  const rows: Array<Record<string, unknown>> = [], positions: Array<Record<string, unknown>> = [];
  for (let n = 0; n < 5; n++) {
    const openedAt = new Date(Date.UTC(2024 + Math.floor(n / 2), n, 1)).toISOString();
    const closedAt = new Date(Date.parse(openedAt) + 86400000).toISOString();
    rows.push({ ...open, id: `o${n}`, time: openedAt, additionalSize: "1" }, { ...close, id: `c${n}`, time: closedAt, prevSize: "1", additionalSize: "-1", netFee: n === 2 ? "-1" : "1", netRealizedPnl: n < 2 ? "-100" : n === 2 ? "0" : "100" });
    positions.push({ ...position, createdAt: openedAt, closedAt, netFunding: "0" });
  }
  const result = auditDydxReportedHistory(rows, positions, [], true, asOf);
  assert.equal(result.closedPositionsLifetime, 5); assert.equal(result.winRateLifetime, 60);
  assert.equal(result.cycles[2].netPnl, "1");
});
test("dYdX tied partial closes follow size continuity, not reverse API order", () => {
  const secondPartial = { ...partial, id: "partial2", prevSize: "1", additionalSize: "-0.5", netRealizedPnl: "150", netFee: "25", value: "55000" };
  const final = { ...close, prevSize: "0.5", additionalSize: "-0.5" };
  for (const tied of [[secondPartial, partial], [partial, secondPartial]]) {
    const result = auditDydxReportedHistory([final, ...tied, open], [{ ...position, netFunding: "0" }], [], true, asOf);
    assert.equal(result.closedPositionsLifetime, 1); assert.equal(result.cycles[0].netPnl, "170");
  }
});
test("dYdX a same-time flip closes the old short before opening the new long", () => {
  const short = { ...open, side: "SELL", additionalSize: "-2" };
  const flipClose = { ...close, id: "flip:close", prevSize: "2", additionalSize: "2", side: "BUY" };
  const flipOpen = { ...open, id: "flip:open", time: close.time, additionalSize: "1" };
  const result = auditDydxReportedHistory([flipOpen, short, flipClose], [position], [{ market: "BTC-USD", size: "1", createdAt: close.time }], true, asOf);
  assert.equal(result.closedPositionsLifetime, 1); assert.equal(result.openings[0].openedAt, Date.parse(close.time));
  assert.equal(result.openings[0].size, "1");
});

const pnl = (at: number, equity: string, netTransfers: string, totalPnl: string) => ({ createdAt: new Date(at).toISOString(), equity, netTransfers, totalPnl });
test("Official30d PnL uses exact common boundaries and excludes cash transfers", () => {
  const startAt = asOf - 30 * 86400000;
  const head = pnl(asOf, "1160000", "1100000", "60000"), start = pnl(startAt, "110000", "100000", "10000");
  const r = dydxOfficialPnl30d([{ subaccountNumber: 0, head, startRows: [pnl(startAt - 3600000, "90000", "100000", "-10000"), start] }], asOf + 1);
  assert.equal(r.officialNetPnl30dUsd, "50000"); assert.equal(r.officialPnlAll, "60000"); assert.equal(r.startAt, startAt);
  assert.equal(dydxOfficialPnl30d([{ subaccountNumber: 0, head, startRows: [pnl(startAt, "110000.000000000001", "100000", "10000.000000000001")] }], asOf + 1).officialNetPnl30dUsd, "49999.999999999999");
});
test("Official PnL never interpolates an hourly boundary or assumes a missing subaccount is zero", () => {
  const head = pnl(asOf, "100", "0", "100"), prior = pnl(asOf - 30 * 86400000 - 3600000, "0", "0", "0");
  assert.throws(() => dydxOfficialPnl30d([{ subaccountNumber: 0, head, startRows: [prior] }], asOf), /exact_pnl_boundary/);
  assert.throws(() => dydxOfficialPnl30d([], asOf), /invalid_pnl_subaccounts/);
  assert.throws(() => dydxOfficialPnl30d([{ subaccountNumber: 0, head, startRows: [] }, { subaccountNumber: 0, head, startRows: [] }], asOf), /invalid_pnl_subaccounts/);
  const start = pnl(asOf - 30 * 86400000, "0", "0", "0");
  assert.throws(() => dydxOfficialPnl30d([{ subaccountNumber: 0, head, startRows: [start, start] }], asOf), /ambiguous_exact/);
});
test("Multiple subaccounts use the same end hour, with signed loss and transfer-aware equity", () => {
  const endAt = asOf - 3600000, startAt = endAt - 30 * 86400000;
  const r = dydxOfficialPnl30d([
    { subaccountNumber: 0, head: pnl(asOf, "999999", "0", "999999"), endRows: [pnl(endAt, "60000", "0", "60000")], startRows: [pnl(startAt, "0", "0", "0")] },
    { subaccountNumber: 128, head: pnl(endAt, "0", "10000", "-10000"), startRows: [pnl(startAt, "10000", "10000", "0")] },
  ], asOf);
  assert.equal(r.endAt, endAt); assert.equal(r.officialNetPnl30dUsd, "50000");
  assert.throws(() => dydxOfficialPnl30d([{ subaccountNumber: 0, head: pnl(asOf, "100", "0", "100"), startRows: [pnl(startAt, "0", "0", "0")] }, { subaccountNumber: 1, head: pnl(endAt, "0", "0", "0"), startRows: [pnl(startAt, "0", "0", "0")] }], asOf), /exact_pnl_boundary/);
});
test("Stale/future timestamps, missing money and inconsistent PnL never pass", () => {
  const start = pnl(asOf - 30 * 86400000, "0", "0", "0");
  for (const t of [asOf + 1, asOf - 2 * 3600000]) assert.throws(() => dydxOfficialPnl30d([{ subaccountNumber: 0, head: pnl(t, "1", "0", "1"), startRows: [start] }], asOf), /stale_or_future/);
  assert.throws(() => dydxOfficialPnl30d([{ subaccountNumber: 0, head: pnl(asOf, "100", "50", "100"), startRows: [start] }], asOf), /equity_transfer_conflict/);
  assert.throws(() => dydxOfficialPnl30d([{ subaccountNumber: 0, head: { ...pnl(asOf, "1", "0", "1"), totalPnl: null }, startRows: [start] }], asOf), /decimal/);
});
