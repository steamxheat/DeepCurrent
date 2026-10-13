import assert from "node:assert/strict";

const base = new URL(process.argv[2] ?? "http://localhost:3001");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Bulk load is restricted to localhost; do not point this script at production");
const requests = Number(process.argv[3] ?? 1000), concurrency = Number(process.argv[4] ?? 50);
assert.ok(Number.isInteger(requests) && requests >= 1 && requests <= 10000);
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 100);
const routes = ["/api/events?limit=50", "/api/events?order=oldest&limit=50", "/api/events?precision=exact&limit=50", "/api/confluences?minutes=15", "/api/confluences?minutes=60&onlyOpen=true"];
const measurements = []; let cursor = 0; let stopped = false; const start = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (!stopped && cursor < requests) {
    const index = cursor++, route = routes[index % routes.length], began = performance.now();
    try {
      const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(10000) });
      const bytes = (await response.arrayBuffer()).byteLength;
      measurements.push({ route, ms: performance.now() - began, status: response.status, bytes, wireBytes: response.headers.has("content-length") ? Number(response.headers.get("content-length")) : null });
      if (response.status >= 500 || performance.now() - began > 5000) stopped = true;
    } catch (error) { measurements.push({ route, ms: performance.now() - began, status: 0, error: error.name, bytes: 0 }); stopped = true; }
  }
}));
const summary = routes.map((route) => {
  const rows = measurements.filter((row) => row.route === route), times = rows.map((row) => row.ms).sort((a, b) => a - b);
  return { route, requests: rows.length, errors: rows.filter((row) => row.status !== 200).length, p50Ms: times[Math.floor(times.length * .5)] ?? null, p95Ms: times[Math.floor(times.length * .95)] ?? null,
    maxMs: times.at(-1) ?? null, decodedBytes: rows.reduce((sum, row) => sum + row.bytes, 0), wireBytesFromContentLength: rows.every((row) => row.wireBytes != null) ? rows.reduce((sum, row) => sum + row.wireBytes, 0) : null };
});
console.log(JSON.stringify({ requests: measurements.length, requested: requests, concurrency, stoppedEarly: stopped, elapsedMs: performance.now() - start, summary,
  scope: "Local API traffic; not 1000 complete browsers, production network performance or exchange latency." }, null, 2));
assert.equal(stopped, false, "Load stopped on a slow/error response"); assert.equal(measurements.length, requests); assert.ok(summary.every((row) => row.errors === 0));
