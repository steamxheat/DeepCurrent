import assert from "node:assert/strict";
import test from "node:test";
import { createConfirmationQueue } from "./confirmation-queue.ts";

const wallet = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;
test("expired and clipped windows send the missed interval to recovery", () => {
  const missed: unknown[] = []; const queue = createConfirmationQueue((...gap) => missed.push(gap));
  queue.enqueue(wallet(1), 1000, 1000); assert.equal(queue.take(() => 0, 61001), null);
  assert.deepEqual(missed, [[wallet(1), 999, 1000, "expired"]]);
  queue.enqueue(wallet(2), 1000, 1000); queue.enqueue(wallet(2), 70000, 70000);
  const task = queue.take(() => 0, 70250)!; assert.equal(task.from, 10250);
  assert.deepEqual(missed[1], [wallet(2), 999, 10249, "window_trimmed"]);
  queue.complete(wallet(2), task.through, true, 70251); assert.equal(queue.stats().pending, 0);
});
test("confirmations coalesce fills, prioritize viewers and never duplicate an in-flight wallet", () => {
  const queue = createConfirmationQueue(); queue.enqueue(wallet(1), 1000, 1000); queue.enqueue(wallet(1), 1001, 1001);
  queue.enqueue(wallet(2), 1000, 1000);
  assert.equal(queue.stats(1200).pending, 2); assert.equal(queue.take(() => 0, 1249), null);
  assert.equal(queue.take((address) => address === wallet(2) ? 0 : 1, 1250)?.wallet, wallet(2));
  const first = queue.take(() => 0, 1250)!; assert.equal(first.wallet, wallet(1)); assert.equal(first.from, 999);
  assert.equal(queue.take(() => 0, 1251), null);
  queue.enqueue(wallet(1), 1400, 1400); queue.complete(wallet(1), first.through, true, 1500);
  queue.complete(wallet(2), 1250, true, 1500);
  assert.equal(queue.take(() => 0, 3499), null);
  const next = queue.take(() => 0, 3500)!; assert.equal(next.from, 1250);
  queue.complete(wallet(1), next.through, true, 3501); assert.equal(queue.stats().pending, 0);
});
test("an empty or failed confirmation retries with backoff; stale work expires visibly", () => {
  const queue = createConfirmationQueue(); queue.enqueue(wallet(1), 1000, 1000); const task = queue.take(() => 0, 1250)!;
  queue.complete(task.wallet, task.through, false, 1251);
  assert.equal(queue.take(() => 0, 6250), null); assert.equal(queue.take(() => 0, 6251)?.wallet, wallet(1));
  queue.complete(wallet(1), 6251, false, 6252);
  assert.equal(queue.take(() => 0, 61_001), null); assert.equal(queue.stats().expired, 1);
});
test("confirmation queues are bounded and reject invalid source timestamps", () => {
  const queue = createConfirmationQueue();
  for (let index = 1; index <= 1000; index++) assert.equal(queue.enqueue(wallet(index), 1000, 1000), true);
  assert.equal(queue.enqueue(wallet(1001), 1000, 1000), false); assert.equal(queue.stats().rejected, 1);
  assert.throws(() => queue.enqueue("invalid", 1000, 1000)); assert.throws(() => queue.enqueue(wallet(1), NaN, 1000));
});
