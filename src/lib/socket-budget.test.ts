import assert from "node:assert/strict";
import test from "node:test";
import { createSocketBudget } from "./socket-budget.ts";

test("reconnect subscription bursts cannot exceed the rolling socket budget", () => {
  const take = createSocketBudget();
  for (let i = 0; i < 1800; i++) assert.equal(take(100_000), true);
  assert.equal(take(100_001), false); assert.equal(take(159_999), false);
  assert.equal(take(160_000), true);
});
