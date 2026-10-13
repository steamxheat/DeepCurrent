import assert from "node:assert/strict";
import test from "node:test";
import { defaultActivityFilters, defaultWalletFilters, filterActivity, filterWallets, qualityBand, walletInsights, walletRiskFlags, walletsCsv } from "./workspace.ts";
import type { PulseFill, WalletRow } from "./hyperliquid.ts";

const wallet = (overrides: Partial<WalletRow> = {}): WalletRow => ({ rank: 1, address: "0x1111111111111111111111111111111111111111", name: "Alpha", accountValue: 1_000_000, dayPnl: 10_000, dayRoi: 1, dayVolume: 2_000_000, weekPnl: 20_000, monthPnl: 100_000, monthRoi: 20, ...overrides });
const fill = (overrides: Partial<PulseFill> = {}): PulseFill => ({ coin: "BTC", px: "100", sz: "20", side: "B", time: 1000, dir: "Open Long", startPosition: "0", source: "user", closedPnl: "0", fee: "-1", hash: "h", wallet: wallet().address, walletName: "Alpha", ...overrides });

test("wallet workspace filters, sorts and summarizes consistently", () => {
  const rows = [wallet(), wallet({ rank: 2, address: "0x2222222222222222222222222222222222222222", name: "Wallet 2222", dayPnl: -50, monthRoi: 1500, dayVolume: 0 })];
  assert.deepEqual(filterWallets(rows, { ...defaultWalletFilters, performance: "winners" }, new Set(), "rank", "asc").map((row) => row.rank), [1]);
  assert.equal(walletInsights(rows).positiveToday, 1);
  assert.deepEqual(walletRiskFlags(rows[1]), ["Минус за 24H", "Аномальный ROI", "Нет объёма за 24H"]);
  assert.equal(qualityBand(rows[1]), "Elite");
  assert.match(walletsCsv(rows), /account_value/);
});

test("activity workspace filters by size and direction", () => {
  const result = filterActivity([fill(), fill({ hash: "b", dir: "Buy" }), fill({ hash: "s", dir: "Open Short", sz: "1" })], { ...defaultActivityFilters, action: "long", minNotional: 1_000 }, new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0].dir, "Open Long");
  assert.deepEqual(filterActivity([fill(), fill({ hash: "m", source: "market" })], { ...defaultActivityFilters, source: "exact" }, new Set()).map((row) => row.hash), ["h"]);
});

test("a public buy is not proof of LONG; lifecycle and oldest/price filters agree", () => {
  const rows = [fill({ time: 200 }), fill({ time: 100, px: "50", startPosition: "20" }), fill({ source: "market", startPosition: undefined })];
  assert.equal(filterActivity(rows, { ...defaultActivityFilters, action: "long" }, new Set()).length, 2);
  assert.equal(filterActivity(rows, { ...defaultActivityFilters, action: "ADD" }, new Set()).length, 1);
  assert.equal(filterActivity(rows, { ...defaultActivityFilters, sort: "oldest" }, new Set())[0].time, 100);
});
