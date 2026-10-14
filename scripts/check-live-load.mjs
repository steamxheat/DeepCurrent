import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:3002");
assert.ok(["localhost", "127.0.0.1"].includes(base.hostname) && ["3001", "3002"].includes(base.port), "Only isolated local QA ports are allowed");
const seconds = Number(process.argv[3] ?? 35);
assert.ok(Number.isFinite(seconds) && seconds >= 20 && seconds <= 120);
const percentile = values => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * .95))] ?? null;
assert.equal(percentile([]), null); assert.equal(percentile([1, 2, 3]), 3);
const started = Date.now(), directory = path.resolve("backups", `live-load-${started}`);
mkdirSync(directory, { mode: 0o700 });
// Fail before creating load if the temporary fixture has already stopped.
assert.equal((await fetch(new URL("/manifest.webmanifest", base), { signal: AbortSignal.timeout(3000) })).status, 200, "QA fixture must be running");
const clients = [], stages = [], failures = [];
let bytes = 0;
async function connect() {
  const client = { id: clients.length, controller: new AbortController(), frames: 0, lastFrameAt: 0, firstFrameMs: null, eventLatencies: [], closing: false, seen: new Set() };
  clients.push(client); const began = Date.now();
  client.task = (async () => {
    const response = await fetch(new URL("/api/live", base), { signal: client.controller.signal });
    assert.equal(response.status, 200); assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffered = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { assert.ok(client.closing, "SSE ended before the test closed it"); break; }
        bytes += chunk.value.byteLength; buffered += decoder.decode(chunk.value, { stream: true });
        assert.ok(buffered.length < 1_000_000, "SSE frame exceeded bounded parser buffer");
        let boundary;
        while ((boundary = buffered.indexOf("\n\n")) >= 0) {
          const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const message = JSON.parse(data), received = Date.now();
          assert.ok(Number.isFinite(message.serverAt) && message.serverAt <= received + 1000);
          if (!client.frames) client.firstFrameMs = received - began;
          client.frames++; client.lastFrameAt = received;
          for (const row of message.rows ?? []) {
            const key = `${row[0]}:${row[1]}:${row[2]}:${row[3]}`;
            // A new connection's reset includes old rows; those are not delivery latency samples.
            if (row[2] < began || client.seen.has(key)) continue;
            client.seen.add(key); client.eventLatencies.push(received - row[2]);
          }
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  })().catch(error => { if (!client.closing) failures.push({ client: client.id, error: error.message }); });
}
try {
  for (const count of [25, 100, 250, 500]) {
    while (clients.length < count) {
      await Promise.all(Array.from({ length: Math.min(25, count - clients.length) }, connect));
      await sleep(100);
      assert.equal(failures.length, 0, JSON.stringify(failures));
    }
    const began = Date.now(), startingBytes = bytes;
    const beforeFrames = clients.map(client => client.frames);
    for (let tick = 0; tick < seconds; tick++) {
      await sleep(1000);
      assert.equal(failures.length, 0, JSON.stringify(failures));
      assert.ok(clients.every(client => client.lastFrameAt && Date.now() - client.lastFrameAt < 5000), "Stale/missing SSE client");
    }
    const row = { clients: count, durationMs: Date.now() - began, receivedBytes: bytes - startingBytes,
      bitsPerSecond: (bytes - startingBytes) * 8 / ((Date.now() - began) / 1000),
      clientsReceivingFrames: clients.filter((client, index) => client.frames > beforeFrames[index]).length,
      firstFrameP95Ms: percentile(clients.map(client => client.firstFrameMs).filter(value => value !== null)),
      clientsReceivingNewFixtureEvents: clients.filter(client => client.eventLatencies.length).length,
      fixtureEventP95Ms: percentile(clients.flatMap(client => client.eventLatencies)), runnerRssBytes: process.memoryUsage().rss };
    stages.push(row); console.log(JSON.stringify(row));
    assert.equal(row.clientsReceivingFrames, count);
    assert.equal(row.clientsReceivingNewFixtureEvents, count, "Each connected client must receive an actual new fixture event, not only heartbeats");
    assert.ok(row.fixtureEventP95Ms < 10000, "New fixture events exceeded the local ten-second delivery target");
  }
} catch (error) { failures.push({ stage: "load", error: error.message }); process.exitCode = 1; }
finally {
  for (const client of clients) { client.closing = true; client.controller.abort(); }
  await Promise.all(clients.map(client => client.task));
  const result = { started, endedAt: Date.now(), stages, failures, scope: "25→100→250→500 persistent SSE connections receiving synthetic events; localhost transport only, not browser rendering, public network, paid billing, or exchange latency." };
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, failures: failures.length }));
}
