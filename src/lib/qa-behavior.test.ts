import assert from "node:assert/strict";
import test from "node:test";
import { createQaBehavior } from "./qa-behavior.ts";
test("random QA is replayable, bounded, varied and covers every scenario", () => {
  const a = createQaBehavior(42), b = createQaBehavior(42), steps = new Set<number>(), pauses = new Set<number>();
  for (let i = 0; i < 10000; i++) {
    const next = a(i % 100); assert.deepEqual(next, b(i % 100));
    assert.ok(next.pauseMs >= 3000 && next.pauseMs < 240000);
    assert.ok(next.step >= 0 && next.step <= 15); steps.add(next.step); pauses.add(next.pauseMs);
  }
  assert.equal(steps.size, 16); assert.ok(pauses.size > 100);
});
