import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createFillJournal } from "../src/lib/fill-journal.ts";

const directory = mkdtempSync(path.join(tmpdir(), "dc-journal-load-")); const filename = path.join(directory, "benchmark.sqlite");
const db = new DatabaseSync(filename); db.exec("PRAGMA journal_mode=WAL"); const j = createFillJournal(db);
const addresses = Array.from({ length: 1000 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`);
const start = performance.now(); const samples = [];
for (const wallet of addresses) {
  const began = performance.now();
  j.ingestBatch(Array.from({ length: 10 }, (_, i) => ({ wallet, source: "userFills", fill: { coin: "BTC", px: "100", sz: "1", side: "B", time: 100 + i, tid: i, hash: "benchmark", startPosition: String(i), fee: "1", feeToken: "USDC", closedPnl: "0", dir: "Open Long" } })));
  samples.push(performance.now() - began);
}
const writeMs = performance.now() - start; const projectStart = performance.now(); j.project(1000); const projectMs = performance.now() - projectStart;
const readStart = performance.now();
for (const wallet of addresses) { assert.equal(j.fills(wallet).length, 10); assert.equal(j.getState(wallet, "BTC").size, "10"); }
const readMs = performance.now() - readStart; const replayStart = performance.now(); assert.equal(j.project(1000), 0); const idleMs = performance.now() - replayStart;
const evidenceStart = performance.now(); const evidence = j.evidence(j.events(0, 10000), 1000); const evidenceMs = performance.now() - evidenceStart;
assert.equal(evidence.length, 10000);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); samples.sort((a, b) => a - b);
assert.equal(j.db.prepare("SELECT COUNT(*) n FROM canonical_fills").get().n, 10_000);
console.log(JSON.stringify({ wallets: 1000, fills: 10_000, writeMs, projectMs, read1000Ms: readMs, idleMs,
  evidence10000Ms: evidenceMs, write10FillsP95Ms: samples[Math.floor(samples.length * .95)], databaseBytes: statSync(filename).size, directory }));
db.close();
