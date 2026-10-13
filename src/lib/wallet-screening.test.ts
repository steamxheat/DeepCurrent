import assert from "node:assert/strict";
import test from "node:test";
import type { Fill } from "./stats.ts";
import { screenWallet, screeningWindowMs } from "./wallet-screening.ts";

const fill = (time: number, index: number): Fill => ({
  coin: `C${index}`, px: "100", sz: "1", side: "B", time, dir: "Open Long", closedPnl: "0", fee: "0", hash: `open-${index}`, tid: index * 2, startPosition: "0",
});

test("60-day screening requires activity, more than five closing transactions and at least 60% wins", () => {
  const now = Date.UTC(2026, 9, 13);
  const fills: Fill[] = [];
  for (let index = 0; index < 10; index++) {
    fills.push(fill(now - 60_000 - index, index));
    fills.push({ ...fill(now - 30_000 - index, index), side: "A", dir: "Close Long", closedPnl: index < 8 ? "20" : "-10", fee: "-1", hash: `close-${index}`, tid: index * 2 + 1, startPosition: "1" });
  }
  fills.push({ ...fill(now - 30_000, 0), side: "A", dir: "Close Long", closedPnl: "1", fee: "0", hash: "close-0", tid: 999, startPosition: "0.1" });
  fills.push(fill(now - screeningWindowMs - 1, 99));
  const result = screenWallet("0xABC", fills, true, now);
  assert.equal(result.trades, 10);
  assert.equal(result.wins, 8);
  assert.equal(result.winRate, 80);
  assert.equal(result.windowDays, 60);
  assert.equal(result.qualifies, true);
  assert.equal(result.lastActive, now - 30_000);
  assert.equal(screenWallet("0xABC", fills, false, now).reason, "history_limit");
  assert.equal(screenWallet("0xABC", fills.filter((item) => /^C[0-4]$/.test(item.coin)), true, now).reason, "too_few_trades");
  assert.equal(screenWallet("0xABC", [fill(now - screeningWindowMs - 1, 99)], true, now).reason, "inactive");
});
