import assert from "node:assert/strict";
import test from "node:test";
import { closedTrades, computeFillStats, findConfluences, mergeFillHistoryPage, mergeFills, netClosedPnl, positionOpenedAt, type Fill } from "./stats.ts";

const fill = (overrides: Partial<Fill>): Fill => ({
  coin: "BTC", px: "100", sz: "1", side: "B", time: 1_000, dir: "Open Long",
  closedPnl: "0", fee: "1", hash: Math.random().toString(), wallet: "0x1", ...overrides,
});

test("fill stats use only closed trades and include signed fees", () => {
  const result = computeFillStats([
    fill({ closedPnl: "11", fee: "1" }),
    fill({ closedPnl: "-4", fee: "1" }),
    fill({ closedPnl: "0", fee: "1" }),
  ]);
  assert.deepEqual(result, { closed: 2, wins: 1, winRate: 50, profitFactor: 2, netPnl: 5 });
});

test("fill history pagination moves backward and detects its final page", () => {
  const current = Array.from({ length: 2_000 }, (_, index) => fill({ time: 4_000 + index, tid: index }));
  const older = Array.from({ length: 2_000 }, (_, index) => fill({ time: 2_000 + index, tid: 2_000 + index }));
  const progress = mergeFillHistoryPage(current, older);
  assert.equal(progress.progressed, true);
  assert.equal(progress.complete, false);
  assert.equal(progress.oldest, 2_000);
  assert.equal(mergeFillHistoryPage(progress.fills, [fill({ time: 1_999, tid: 9_999 })]).complete, true);
});

test("confluence requires two unique wallets in the same market and direction", () => {
  const result = findConfluences([
    fill({ wallet: "0x1", startPosition: "0" }), fill({ wallet: "0x2", time: 900, startPosition: "0" }),
    fill({ wallet: "0x1", time: 800, startPosition: "0" }), fill({ wallet: "0x3", dir: "Open Short", side: "A", startPosition: "0" }),
  ], 1_000, 500);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].wallets.sort(), ["0x1", "0x2"]);
});

test("confluence ignores public fills, stale entries, and wallets that already closed", () => {
  const result = findConfluences([
    fill({ wallet: "0x1", time: 900, startPosition: "0" }),
    fill({ wallet: "0x1", time: 950, side: "A", startPosition: "1", dir: "Close Long" }),
    fill({ wallet: "0x2", time: 900, startPosition: "0" }),
    fill({ wallet: "0x3", time: 900, source: "market" }),
    fill({ wallet: "0x4", time: 100 }),
  ], 1_000, 500);
  assert.deepEqual(result, []);
});

test("confluence exposes the distinct entries and their actual time span", () => {
  const [result] = findConfluences([
    fill({ wallet: "0x1", walletName: "Alpha", time: 900, startPosition: "0", px: "100", sz: "2" }),
    fill({ wallet: "0x2", walletName: "Beta", time: 980, startPosition: "0", px: "100", sz: "3" }),
  ], 1_000, 500);
  assert.equal(result.spanMs, 80);
  assert.equal(result.totalNotional, 500);
  assert.deepEqual(result.entries.map((entry) => entry.walletName), ["Beta", "Alpha"]);
  assert.equal(result.stillOpen, null);
});

test("confluences never turn inventory or missing evidence into long entries", () => {
  assert.deepEqual(findConfluences([fill({ wallet: "0x1" }), fill({ wallet: "0x2" })], 1000), []);
  assert.deepEqual(findConfluences([fill({ wallet: "0x1", coin: "@107", startPosition: "0" }), fill({ wallet: "0x2", coin: "@107", startPosition: "0" })], 1000), []);
});

test("confluence 2.0 collapses strongly correlated addresses and scores independent traders", () => {
  const linked = ["BTC", "ETH", "SOL"].flatMap((coin, index) => [
    fill({ coin, wallet: "0xa", time: 700 + index * 30_000, startPosition: "0" }),
    fill({ coin, wallet: "0xb", time: 705 + index * 30_000, startPosition: "0" }),
  ]);
  const collapsed = findConfluences(linked, 70_800, 90_000);
  assert.equal(collapsed.length, 0);
  const [independent] = findConfluences([
    fill({ wallet: "0xa", time: 900, startPosition: "0" }),
    fill({ wallet: "0xc", time: 980, startPosition: "0", sz: "20" }),
  ], 1_000, 500, { "0xa": { quality: 90 }, "0xc": { quality: 80 } });
  assert.equal(independent.independentWallets, 2);
  assert.ok(independent.score >= 60);
});

test("confluence rules respect quality, copyability, price, ADD and unique position evidence", () => {
  const fills = [fill({ wallet: "0xa", time: 900, startPosition: "10", sz: "2" }), fill({ wallet: "0xa", time: 901, startPosition: "12", sz: "1" }), fill({ wallet: "0xb", time: 950, startPosition: "0" })];
  const context = { "0xa": { quality: 90, copyability: 80, cluster: "owner" }, "0xb": { quality: 85, copyability: 75 } };
  const [result] = findConfluences(fills, 1000, 100, context, { minQuality: 80, minCopyability: 70 });
  assert.equal(result.entries.length, 2); assert.equal(result.entries.find((e) => e.wallet === "0xa")?.positionChangePct, 20);
  assert.equal(result.spanMs, 50); assert.equal(result.entries[0].price, 100);
  assert.equal(findConfluences(fills, 1000, 100, context, { onlyOpen: true }).length, 0);
  assert.equal(findConfluences(fills, 1000, 100, context, { minWallets: 3 }).length, 0);
  assert.equal(findConfluences(fills, 1000, 100, { "0xa": context["0xa"] }, { minCopyability: 70 }).length, 0);
  assert.equal(findConfluences(fills, 1000, 100, { ...context, "0xb": { ...context["0xb"], cluster: "owner" } }).length, 0);
});

test("flip confluence counts only new exposure and missing quality stays unknown", () => {
  const [group] = findConfluences([fill({ wallet: "0xa", startPosition: "-1", sz: "3", time: 900 }), fill({ wallet: "0xb", time: 950, startPosition: "0" })], 1000, 100);
  assert.equal(group.entries.find((entry) => entry.wallet === "0xa")?.notional, 200);
  assert.equal(group.entries.find((entry) => entry.wallet === "0xa")?.size, 2);
  assert.equal(group.entries[0].quality, null); assert.equal(group.averageQuality, null);
});

test("position opening time survives later additions and reductions", () => {
  const fills = [
    fill({ time: 100, sz: "4", side: "B", startPosition: "0" }),
    fill({ time: 200, sz: "3", side: "B", startPosition: "4" }),
    fill({ time: 300, sz: "2", side: "A", startPosition: "7", dir: "Close Long" }),
  ];
  assert.equal(positionOpenedAt(5, "BTC", fills), 100);
});

test("position opening time is the fill that flipped its direction", () => {
  const fills = [fill({ time: 100, sz: "10", side: "B", startPosition: "-5", dir: "Open Long" })];
  assert.equal(positionOpenedAt(5, "BTC", fills), 100);
});

test("fill history pagination stays newest-first and removes inclusive-page duplicates", () => {
  const oldest = fill({ time: 100, tid: 1, hash: "0xa" });
  const newest = fill({ time: 300, tid: 3, hash: "0xc" });
  assert.deepEqual(mergeFills([oldest, fill({ time: 200, tid: 2, hash: "0xb" })], [newest, oldest]), [newest, fill({ time: 200, tid: 2, hash: "0xb" }), oldest]);
});

test("closed trades combine partial reductions and preserve duration", () => {
  const result = closedTrades([
    fill({ time: 100, sz: "4", side: "B", startPosition: "0", px: "100", fee: "1" }),
    fill({ time: 200, sz: "1", side: "A", startPosition: "4", px: "110", dir: "Close Long", closedPnl: "10", fee: "1" }),
    fill({ time: 300, sz: "3", side: "A", startPosition: "3", px: "120", dir: "Close Long", closedPnl: "60", fee: "1" }),
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { coin: "BTC", direction: "LONG", openedAt: 100, closedAt: 300, entryPx: 100, exitPx: 117.5, size: 4, netPnl: 67 });
});

test("closed trades mark an opening before available history as unknown", () => {
  const [trade] = closedTrades([fill({ time: 300, sz: "2", side: "B", startPosition: "-2", dir: "Close Short", closedPnl: "5" })]);
  assert.equal(trade.openedAt, null);
  assert.equal(trade.direction, "SHORT");
});

test("fee expenses, rebates and unknown fee currency are treated separately", () => {
  assert.equal(netClosedPnl(fill({ closedPnl: "10", fee: "1" })), 9);
  assert.equal(netClosedPnl(fill({ closedPnl: "10", fee: "-1" })), 11);
  assert.equal(Number.isNaN(netClosedPnl(fill({ feeToken: "BTC" }))), true);
});

test("a partial-history addition does not invent the original cost basis", () => {
  const [trade] = closedTrades([fill({ time: 100, startPosition: "10" }), fill({ time: 200, startPosition: "11", side: "A", sz: "11" })]);
  assert.equal(trade.entryPx, null); assert.equal(trade.openedAt, null);
});

test("flip allocates its fee once across the old and new lifecycle", () => {
  const trades = closedTrades([fill({ time: 100, startPosition: "0" }), fill({ time: 200, startPosition: "1", side: "A", sz: "2", fee: "2", closedPnl: "10" }), fill({ time: 300, startPosition: "-1", side: "B", fee: "1", closedPnl: "5" })]);
  assert.equal(trades.reduce((sum, row) => sum + row.netPnl, 0), 11);
});

test("short opening retains its time and entry through partial buybacks", () => {
  const [trade] = closedTrades([fill({ time: 100, startPosition: "0", side: "A", sz: "2" }), fill({ time: 200, startPosition: "-2", side: "B" }), fill({ time: 300, startPosition: "-1", side: "B" })]);
  assert.equal(trade.direction, "SHORT"); assert.equal(trade.openedAt, 100); assert.equal(trade.entryPx, 100);
});

test("a break-even closing fill with a fee is a loss rather than omitted", () => {
  const stats = computeFillStats([fill({ side: "A", startPosition: "1", dir: "Close Long", closedPnl: "0", fee: "1" })]);
  assert.equal(stats.closed, 1); assert.equal(stats.netPnl, -1); assert.equal(stats.winRate, 0);
});
