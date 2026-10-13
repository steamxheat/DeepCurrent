import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createInfoClient } from "./hyperliquid-client.ts";

test("bulk HTTP work leaves a slot for urgent confirmations", async () => {
  const requests: Array<{ type: string; resolve: (response: Response) => void }> = [];
  const client = createInfoClient(async (_url, options) => new Promise<Response>((resolve) => requests.push({ type: JSON.parse(String(options?.body)).type, resolve })));
  const background = Array.from({ length: 4 }, () => client.post({ type: "meta" }, 4));
  assert.equal(requests.length, 3); assert.equal(client.pending(), 1);
  const urgent = client.post({ type: "userFillsByTime" }, 0); assert.equal(requests[3].type, "userFillsByTime");
  for (const request of requests) request.resolve(Response.json([]));
  await setImmediate(); assert.equal(requests.length, 5);
  requests[4].resolve(Response.json([])); await Promise.all([...background, urgent]);
});

test("large backfills reserve response weight without consuming the urgent allowance", async () => {
  const requests: Array<{ resolve: (response: Response) => void }> = [];
  const client = createInfoClient(async () => new Promise<Response>((resolve) => requests.push({ resolve })));
  const bulk = client.post({ type: "userFills" }, 4);
  assert.equal(client.budget().tokens, 30);
  const urgent = client.post({ type: "userFillsByTime" }, 0); assert.equal(requests.length, 2);
  requests[0].resolve(Response.json([])); requests[1].resolve(Response.json([]));
  await Promise.all([bulk, urgent]); assert.ok(client.budget().tokens >= 110);
});

test("429 releases workers and applies one shared cooldown before retry", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const calls: number[] = [];
  const client = createInfoClient(async () => { calls.push(Date.now()); return calls.length === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "10" } }) : Response.json([]); });
  const result = client.post({ type: "userFillsByTime" }, 0);
  await setImmediate(); assert.equal(client.active(), 0); assert.equal(client.budget().cooldownUntil, 11_000);
  context.mock.timers.tick(9999); await setImmediate(); assert.equal(calls.length, 1);
  context.mock.timers.tick(1); await result; assert.deepEqual(calls, [1000, 11_000]);
});

test("permanent API errors are not retried", async () => {
  let calls = 0; const client = createInfoClient(async () => { calls++; return new Response(null, { status: 400 }); });
  await assert.rejects(client.post({ type: "meta" }, 0), /400/); assert.equal(calls, 1);
});

test("HTTP diagnostics describe successful and failed attempts without request bodies", async () => {
  const entries: unknown[] = [];
  const client = createInfoClient(async (_url, options) => JSON.parse(String(options?.body)).type === "meta" ? Response.json([]) : new Response(null, { status: 400 }), (entry) => entries.push(entry));
  await client.post({ type: "meta", secret: "do not log" }, 0);
  await assert.rejects(client.post({ type: "userFills", user: "wallet" }, 0));
  assert.equal(entries.length, 2); assert.ok(!JSON.stringify(entries).includes("do not log"));
  assert.equal((entries[0] as { code: number }).code, 200); assert.equal((entries[1] as { code: number }).code, 400);
});

test("a failed diagnostic writer does not turn a successful request into a retry", async (context) => {
  context.mock.method(console, "error", () => {}); let calls = 0;
  const client = createInfoClient(async () => { calls++; return Response.json([]); }, () => { throw new Error("disk full"); });
  assert.deepEqual(await client.post({ type: "meta" }, 0), []); assert.equal(calls, 1);
});
