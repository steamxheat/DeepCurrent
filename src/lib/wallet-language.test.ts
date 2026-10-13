import assert from "node:assert/strict";
import test from "node:test";
import { walletText } from "./wallet-language.ts";
import { walletDuration, walletTime } from "./wallet-format.ts";

test("wallet language changes labels and duration without changing exchange time", () => {
  assert.equal(walletText("ru", "Открытые позиции"), "Открытые позиции");
  assert.equal(walletText("en", "Открытые позиции"), "Open positions");
  assert.equal(walletText("en", "История открытия неполная"), "Opening history is incomplete");
  assert.equal(walletDuration(3661000, "en"), "1h 1m");
  for (const language of ["ru", "en"]) assert.match(walletTime(Date.UTC(2026, 9, 14, 12, 3, 4), language), /15:03:04/);
});
