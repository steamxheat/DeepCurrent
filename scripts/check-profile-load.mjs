import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";

const base = new URL(process.argv[2] ?? "http://localhost:3001"), filename = path.resolve(process.argv[3] ?? "");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Profile load is local-only");
assert.ok(filename.startsWith(path.join(tmpdir(), "dc-stages-7-10-")) && path.basename(filename) === "fixture.sqlite", "Use the isolated load fixture, never a production database");
const db = new DatabaseSync(filename, { readOnly: true });
const wallets = JSON.parse(db.prepare("SELECT payload FROM collector_status WHERE name='targets'").get().payload).wallets.map((row) => row.address); db.close();
assert.equal(wallets.length, 1000, "Expected 1000 load-fixture wallets");
let cursor = 0; let stopped = false; const samples = []; const began = performance.now();
await Promise.all(Array.from({ length: 10 }, async () => {
  while (!stopped && cursor < wallets.length) {
    const wallet = wallets[cursor++], start = performance.now();
    try {
      const response = await fetch(new URL(`/api/wallet/${wallet}/watch`, base), { method: "POST", headers: { origin: base.origin }, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.snapshot.address, wallet);
      assert.equal(value.snapshot.positions.length, wallet === wallets[3] ? 0 : 1); if (value.snapshot.positions.length) assert.ok(value.snapshot.positions[0].size > 0);
      samples.push(performance.now() - start); if (performance.now() - start > 5000) stopped = true;
    } catch (error) { stopped = true; console.error({ wallet, error: error.message }); }
  }
}));
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ wallets: samples.length, concurrency: 10, stoppedEarly: stopped, elapsedMs: performance.now() - began,
  p50Ms: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.floor(samples.length * .95)], maxMs: samples.at(-1),
  scope: "1000 different fixture snapshots and viewer leases; not full profile pages or a collector running concurrently." }, null, 2));
assert.equal(stopped, false); assert.equal(samples.length, 1000);
