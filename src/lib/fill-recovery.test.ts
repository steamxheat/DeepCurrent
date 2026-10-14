import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createFillJournal, type RawFill } from "./fill-journal.ts";
import { recoverFills, recoveryCoverage } from "./fill-recovery.ts";
import { createRecoveryQueue } from "./recovery-queue.ts";

const wallet = `0x${"a".repeat(40)}`;
const fills: RawFill[] = [
  { coin: "BTC", time: 100, tid: 1, side: "B", dir: "Open Long", sz: "1", px: "100", startPosition: "0", hash: "a", fee: "0", closedPnl: "0" },
  { coin: "BTC", time: 200, tid: 2, side: "B", dir: "Open Long", sz: "1", px: "100", startPosition: "1", hash: "b", fee: "0", closedPnl: "0" },
  { coin: "BTC", time: 300, tid: 3, side: "A", dir: "Close Long", sz: "1", px: "110", startPosition: "2", hash: "c", fee: "0", closedPnl: "10" },
  { coin: "BTC", time: 400, tid: 4, side: "A", dir: "Close Long", sz: "1", px: "120", startPosition: "1", hash: "d", fee: "0", closedPnl: "20" },
];

test("disconnect replay recovers missing fills once and restores the complete lifecycle", async () => {
  const db = new DatabaseSync(":memory:"), journal = createFillJournal(db), queue = createRecoveryQueue(db);
  try {
    journal.ingest(wallet, fills[0], "userFills"); journal.coverage(wallet, "fills", 100, 150, "covered_interval");
    journal.markStreamGap([wallet]); queue.add(wallet, 149, 450);
    // A reconnect snapshot contains the closing fill, but the intervening executions were missed.
    journal.ingest(wallet, fills[3], "userFills"); journal.project();
    const job = queue.get(wallet)!;
    const result = await recoverFills(149, 450, async () => [...fills.slice(1), fills[3]]);
    assert.equal(result.fills.length, 3);
    for (let pass = 0; pass < 2; pass++) journal.ingestBatch(result.fills.map(fill => ({ wallet, fill, source: "userFills" as const, mode: "history" as const })));
    const proof = recoveryCoverage(result, 149, 450, 100, journal.hasUnconfirmed(wallet, 149, 450), job);
    assert.equal(proof.complete, true); journal.coverage(wallet, "fills", proof.from, proof.through, proof.status, proof.reason); journal.project();
    assert.equal(queue.complete(wallet, job.revision), true);
    assert.equal(journal.fills(wallet).length, 4); assert.equal(journal.events().length, 4);
    assert.deepEqual(journal.events().reverse().map(event => event.action), ["OPEN", "ADD", "REDUCE", "CLOSE"]);
    assert.equal(journal.getState(wallet, "BTC")?.size, "0"); assert.equal(journal.getCoverage(wallet)?.status, "covered_interval");
    assert.equal(journal.completed(wallet).length, 1); assert.equal(journal.completed(wallet)[0].openedAt, 100); assert.equal(journal.completed(wallet)[0].closedAt, 400);
    assert.equal(journal.readySignals().length, 0);
  } finally { db.close(); }
});

test("empty history cannot confirm an observed execution or erase an older missing interval", async () => {
  const db = new DatabaseSync(":memory:"), journal = createFillJournal(db);
  try {
    journal.ingest(wallet, { ...fills[1], startPosition: undefined }, "market");
    const result = await recoverFills(150, 400, async () => []);
    const missing = recoveryCoverage(result, 150, 400, 100, journal.hasUnconfirmed(wallet, 150, 400), { from_time: 150, through_time: 400 });
    assert.equal(missing.complete, false); assert.equal(missing.status, "gap"); assert.equal(missing.reason, "unconfirmed_executions");
    const old = recoveryCoverage(result, 150, 400, 300, false, { from_time: 150, through_time: 400 });
    assert.equal(old.complete, false); assert.equal(old.from, 300); assert.equal(old.reason, "older_history_not_proven");
  } finally { db.close(); }
});

test("contradictory history observations survive deduplication and prevent successful confirmation", async () => {
  const db = new DatabaseSync(":memory:"), journal = createFillJournal(db);
  try {
    const result = await recoverFills(100, 100, async () => [fills[0], fills[0], { ...fills[0], sz: "2" }]);
    assert.equal(result.fills.length, 2);
    journal.ingestBatch(result.fills.map(fill => ({ wallet, fill, source: "userFills" as const })));
    assert.equal(journal.fills(wallet).length, 1); assert.equal(journal.hasUnconfirmed(wallet, 100, 100), true);
    assert.equal(recoveryCoverage(result, 100, 100, 100, true).complete, false);
  } finally { db.close(); }
});

test("recovery marks offline, malformed, saturated and unvisited intervals instead of claiming completeness", async () => {
  for (const fetcher of [async () => { throw new Error("offline"); }, async () => [{ ...fills[0], time: 999 }], async () => [{ ...fills[0], tid: NaN }]]) {
    const result = await recoverFills(100, 200, fetcher); assert.equal(result.complete, false); assert.ok(result.gaps.length > 0);
  }
  const all = Array.from({ length: 2500 }, (_, tid) => ({ ...fills[0], time: tid < 1250 ? 100 : 200, tid }));
  const limited = await recoverFills(100, 200, async (from, to) => all.filter(fill => fill.time >= from && fill.time <= to).slice(0, 2000), 1);
  assert.equal(limited.complete, false); assert.ok(limited.gaps.every(gap => gap.reason === "request_budget"));
  const saturated = await recoverFills(100, 100, async () => all.slice(0, 2000).map(fill => ({ ...fill, time: 100 })));
  assert.equal(saturated.complete, false); assert.equal(saturated.gaps[0].reason, "saturated_timestamp");
  await assert.rejects(recoverFills(200, 100, async () => []));
});
