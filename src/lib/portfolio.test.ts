import assert from "node:assert/strict";
import test from "node:test";
import { normalizePerpPortfolio, type RawPortfolioEntry } from "./portfolio.ts";

test("wallet charts use perpetuals portfolio windows", () => {
  const rows: RawPortfolioEntry[] = [
    ["day", { accountValueHistory: [[1, "999"]], pnlHistory: [[1, "99"]], vlm: "999" }],
    ["perpDay", { accountValueHistory: [[2, "20"]], pnlHistory: [[2, "3"]], vlm: "40" }],
  ];

  assert.deepEqual(normalizePerpPortfolio(rows).day, {
    accountValue: [[2, 20]],
    pnl: [[2, 3]],
    volume: 40,
  });
});
