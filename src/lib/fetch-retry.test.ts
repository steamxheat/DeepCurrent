import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetry } from "./fetch-retry.ts";

test("transient API errors are retried without hiding the final response", async () => {
  let calls = 0; const delays: number[] = [];
  const response = await fetchWithRetry(async () => new Response("", { status: ++calls < 3 ? 429 : 200 }), 3, async (delay) => { delays.push(delay); });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [200, 400]);
});

test("permanent client errors are not retried", async () => {
  let calls = 0;
  const response = await fetchWithRetry(async () => { calls += 1; return new Response("", { status: 400 }); });
  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});

test("cancelled and timed-out requests do not restart an expired deadline", async () => {
  for (const name of ["AbortError", "TimeoutError"]) {
    let calls = 0;
    await assert.rejects(fetchWithRetry(async () => { calls++; throw new DOMException("deadline", name); }, 3, async () => { assert.fail("Must not retry cancellation"); }), { name });
    assert.equal(calls, 1);
  }
});
