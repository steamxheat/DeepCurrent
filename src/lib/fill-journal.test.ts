import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFillJournal, type RawFill } from "./fill-journal.ts";
import { decimalAdd, decimalEqual, orderFillChain, reducePosition } from "./position-reducer.ts";
import { recoverFills } from "./fill-recovery.ts";
import { transaction } from "./database.ts";

const wallet = `0x${"a".repeat(40)}`;
const fill = (overrides: Partial<RawFill> = {}): RawFill => ({ coin: "BTC", time: 100, side: "B", sz: "1", px: "100", startPosition: "0", fee: "1", feeToken: "USDC", closedPnl: "0", dir: "Open Long", hash: "h", tid: 1, ...overrides });
const setup = () => createFillJournal(new DatabaseSync(":memory:"));

test("all event readers expose exchange, first receipt and journal confirmation without inventing legacy times", context => {
  context.mock.timers.enable({ apis: ["Date"], now: 110 });
  const journal = setup();
  try {
    journal.ingest(wallet, { ...fill(), startPosition: undefined }, "market", "live", 110);
    assert.equal(journal.events()[0].confirmedAt, null);
    context.mock.timers.setTime(500); journal.ingest(wallet, fill(), "userFills", "history", 500);
    context.mock.timers.setTime(900); journal.project();
    for (const event of [journal.events()[0], journal.eventsSince(0)[0], journal.queryEvents({wallet}).events[0]]) {
      assert.equal(event.time,100); assert.equal(event.receivedAt,110); assert.equal(event.confirmedAt,900);
    }
    context.mock.timers.setTime(1200); journal.ingest(wallet, fill(), "userFills", "history",1200); journal.project();
    assert.equal(journal.events()[0].confirmedAt,900);
    journal.db.prepare("UPDATE lifecycle_events SET confirmed_at=NULL").run();
    assert.equal(journal.queryEvents({wallet}).events[0].confirmedAt,null);
    journal.ingest(wallet, fill({sz:"2"}), "userFills"); journal.project(); assert.equal(journal.events()[0].confirmedAt,null);
  } finally { journal.db.close(); }
});

test("unconfirmed or conflicting intervening executions cannot invent a completed opening", () => {
  for (const conflict of [false, true]) {
    const j = setup(); j.ingest(wallet, fill(), "userFills");
    j.ingest(wallet, fill({ time: 200, tid: 2, side: "A", startPosition: conflict ? "1" : undefined }), conflict ? "userFills" : "market");
    if (conflict) j.ingest(wallet, fill({ time: 200, tid: 2, side: "A", startPosition: "2" }), "userFills");
    j.ingest(wallet, fill({ time: 300, tid: 3, startPosition: undefined }), "market");
    j.ingest(wallet, fill({ time: 400, tid: 4, side: "A", startPosition: "1" }), "userFills"); j.project();
    assert.equal(j.completed(wallet).at(-1)?.openedAt, null);
    assert.equal(j.completed(wallet).at(-1)?.entryPx, null);
    j.db.prepare("UPDATE lifecycle_events SET algorithm_version=5").run();
    const upgraded = createFillJournal(j.db); assert.ok(upgraded.db.prepare("SELECT COUNT(*) n FROM projection_jobs").get()!.n);
    upgraded.project(); assert.equal(upgraded.completed(wallet).at(-1)?.openedAt, null);
    assert.equal(upgraded.db.prepare("SELECT MIN(algorithm_version) version FROM lifecycle_events").get()?.version, 7);
    j.db.close();
  }
});

test("disconnect marks more than 5000 watched addresses without rejecting valid favorites", () => {
  const j = setup(); const wallets = Array.from({ length: 5001 }, (_, index) => `0x${index.toString(16).padStart(40, "0")}`);
  const insert = j.db.prepare("INSERT INTO ingestion_coverage VALUES (?,'fills',1,2,'covered_interval',NULL,3)");
  transaction(j.db, () => { wallets.forEach((wallet) => insert.run(wallet)); });
  assert.throws(() => j.markStreamGap([...wallets, "invalid"]));
  assert.equal(j.db.prepare("SELECT COUNT(*) n FROM ingestion_coverage WHERE status='gap'").get()?.n, 0);
  j.markStreamGap(wallets);
  assert.equal(j.db.prepare("SELECT COUNT(*) n FROM ingestion_coverage WHERE status='gap'").get()?.n, 5001);
  j.db.close();
});

test("feed evidence separates historic closed, absent, unknown and current lifecycles", () => {
  const j = setup(); j.ingest(wallet, fill(), "userFills"); j.ingest(wallet, fill({ time: 200, tid: 2, side: "A", startPosition: "1", closedPnl: "10" }), "userFills"); j.project();
  const open = j.events().find((row) => row.action === "OPEN")!;
  assert.equal(j.evidence([open], 201)[0].positionStatus, "closed"); assert.equal(j.evidence([open], 201)[0].closedAt, 200);
  assert.equal(j.evidence(j.events().filter((row) => row.action === "CLOSE"), 201)[0].positionStatus, "closed");
  j.ingest(wallet, fill({ time: 300, tid: 3 }), "userFills"); j.project();
  const newOpen = j.events()[0];
  assert.equal(j.evidence([newOpen], 301)[0].positionStatus, "unknown");
  j.recordScope({ wallet, scope: "", requestedAt: 305, receivedAt: 310, payload: { assetPositions: [{ position: { coin: "BTC", szi: "1", leverage: { value: 5 } } }] } });
  assert.equal(j.evidence([newOpen], 311)[0].positionStatus, "unknown"); assert.equal(j.evidence([open], 311)[0].positionStatus, "closed");
  assert.equal(j.evidence([newOpen], 311)[0].openedAt, null);
  j.coverage(wallet, "fills", 300, 310, "covered_interval"); assert.equal(j.evidence([newOpen], 311)[0].openedAt, 300); assert.equal(j.evidence([newOpen],311)[0].positionStatus,"open");
  j.markStreamGap([wallet]); assert.equal(j.evidence([newOpen], 311)[0].openedAt, null); assert.equal(j.evidence([newOpen],311)[0].positionStatus,"unknown");
  j.recordScope({ wallet, scope: "", requestedAt: 315, receivedAt: 320, payload: { assetPositions: [] } });
  assert.equal(j.evidence([newOpen], 321)[0].positionStatus, "absent");
  assert.equal(j.evidence([newOpen], 40000)[0].positionStatus, "unknown");
});

test("server event filters are applied before pagination and price ordering", () => {
  const j = setup(); const other = `0x${"b".repeat(40)}`;
  j.ingest(wallet, fill(), "userFills"); j.ingest(wallet, fill({ time: 200, tid: 2, startPosition: "1", px: "200" }), "userFills"); j.ingest(other, fill({ coin: "ETH", side: "A" }), "userFills"); j.project();
  assert.equal(j.queryEvents({ wallets: [wallet], actions: ["OPEN", "ADD"], precision: "exact", minNotional: 150, direction: "LONG" }).events.length, 1);
  assert.equal(j.queryEvents({ wallets: [], order: "oldest" }).events.length, 0);
  assert.equal(j.queryEvents({ wallet, order: "price-asc", limit: 1 }).events[0].px, "100");
});

test("push destinations are independently deduplicated and retried", () => {
  const j = setup(); const now = Date.now(); j.ingest(wallet, fill({ time: now }), "userFills", "live"); j.project();
  const id = j.readySignals(now + 1000)[0].id;
  const deliveries = ["a", "b"].map((destination) => ({ recipient: "u", channel: "push" as const, destination, payload: { endpoint: destination } }));
  j.completeSignal(id, deliveries); j.completeSignal(id, deliveries);
  const first = j.claimDelivery(now + 2000)!; j.finishDelivery(first.id, "accepted");
  const second = j.claimDelivery(now + 2001)!; assert.notEqual(first.id, second.id); j.finishDelivery(second.id, undefined, "timeout", now + 2002);
  assert.equal(j.claimDelivery(now + 10000)?.id, second.id);
});

test("cancelled notifications are not reported as delivered", () => {
  const j = setup(); const now = Date.now(); j.ingest(wallet, fill({ time: now }), "userFills", "live"); j.project();
  j.completeSignal(j.readySignals(now + 1000)[0].id, [{ recipient: "u", channel: "push", payload: {} }]);
  const delivery = j.claimDelivery(now + 2000)!; j.finishDelivery(delivery.id, "cancelled_no_active_subscription");
  assert.equal(j.db.prepare("SELECT state FROM delivery_outbox WHERE id=?").get(delivery.id)?.state, "cancelled");
});

test("REST enriches one market fill; distinct tids and both wallets survive reconnects", () => {
  const j = setup(); const f = fill(); const market = { ...f, startPosition: undefined };
  for (let i = 0; i < 3; i++) j.ingest(wallet, market, "market");
  j.ingest(wallet, f, "userFills"); j.ingest(wallet, fill({ tid: 2 }), "userFills");
  j.ingest(`0x${"b".repeat(40)}`, { ...f, side: "A" }, "market");
  assert.equal(j.fills(wallet).length, 2);
  assert.equal(j.fills(wallet).find((row) => row.tid === 1)?.startPosition, "0");
  assert.equal(j.fills(wallet).find((row) => row.tid === 1)?.fee, "1");
  assert.equal(j.fills(`0x${"b".repeat(40)}`).length, 1);
});

test("ingestion survives close and reopen; projection rollback replays pending work", async () => {
  const filename = path.join(mkdtempSync(path.join(tmpdir(), "dc-journal-")), "test.sqlite");
  let db = new DatabaseSync(filename); let j = createFillJournal(db);
  j.ingest(wallet, fill(), "userFills"); db.close(); db = new DatabaseSync(filename); j = createFillJournal(db);
  db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON position_projection BEGIN SELECT RAISE(ABORT,'crash'); END;");
  assert.throws(() => j.project(), /crash/);
  assert.equal(j.events().length, 0);
  db.exec("DROP TRIGGER fail_projection"); j.project();
  assert.equal(j.getState(wallet, "BTC")?.openedAt, 100);
  assert.equal(j.project(), 0);
  await backup(db, `${filename}.backup`); const restored = createFillJournal(new DatabaseSync(`${filename}.backup`));
  assert.deepEqual(restored.getState(wallet, "BTC"), j.getState(wallet, "BTC")); db.close(); restored.db.close();
});

test("late fills repair the opening while missing baseline stays unknown", () => {
  const j = setup(); j.ingest(wallet, fill({ time: 200, tid: 2, startPosition: "1" }), "userFills"); j.project();
  assert.equal(j.getState(wallet, "BTC")?.openedAt, null);
  j.ingest(wallet, fill(), "userFills"); j.project();
  assert.deepEqual(j.getState(wallet, "BTC"), { size: "2", openedAt: 100, lastTime: 200, reason: null });
  j.ingest(wallet, fill({ time: 300, tid: 3, side: "A", sz: "3", startPosition: "2" }), "userFills"); j.project();
  assert.equal(j.getState(wallet, "BTC")?.openedAt, 300);
  assert.equal(j.getState(wallet, "BTC")?.size, "-1");
});

test("exact decimal reduction, flip, and zero do not use floating point epsilon", () => {
  assert.equal(decimalAdd("0.1", "0.2"), "0.3");
  assert.equal(decimalAdd("100000000000000000000.00000001", "-0.00000001"), "100000000000000000000");
  assert.equal(decimalEqual("-0.00", "0"), true);
  let state = reducePosition(null, fill({ sz: "0.3" }));
  state = reducePosition(state, fill({ time: 200, side: "A", sz: "0.1", startPosition: "0.3" }));
  assert.equal(state.size, "0.2"); assert.equal(state.openedAt, 100);
  state = reducePosition(state, fill({ time: 300, side: "A", sz: "0.2", startPosition: "0.2" }));
  assert.equal(state.size, "0"); assert.equal(state.openedAt, null);
});

test("tied timestamps use before/after chains; ambiguous chains cannot claim an opening", () => {
  const ordered = orderFillChain([fill({ tid: 2, startPosition: "1" }), fill()]);
  assert.equal(ordered.state?.size, "2"); assert.equal(ordered.ambiguous, false);
  const ambiguous = orderFillChain([fill(), fill({ tid: 2 })]);
  assert.equal(ambiguous.ambiguous, true); assert.equal(ambiguous.state?.openedAt, null);
});

test("malformed inputs and conflicting evidence are saved but never projected as exact", () => {
  const j = setup(); assert.equal(j.ingest(wallet, fill({ sz: "NaN" }), "userFills").id, null);
  assert.equal(j.ingest(wallet, fill({ feeToken: 123 as unknown as string }), "userFills").id, null);
  j.ingest(wallet, fill(), "userFills"); j.ingest(wallet, fill({ sz: "2" }), "userFills"); j.project();
  assert.equal(j.events()[0].precision, "observed"); assert.equal(j.getState(wallet, "BTC")?.openedAt, null);
  assert.equal((j.db.prepare("SELECT COUNT(*) n FROM fill_observations").get() as { n: number }).n, 4);
});

test("empty snapshots clear their scope while a failed scope preserves its last data", () => {
  const j = setup(); const snapshot = { wallet, scope: "xyz", requestedAt: 100, receivedAt: 110, payload: { assetPositions: [{ position: { coin: "xyz:GOLD", szi: "1" } }] } };
  j.recordScope(snapshot); j.recordScope({ ...snapshot, scope: "", payload: { assetPositions: [] } });
  j.recordScope({ ...snapshot, requestedAt: 200, receivedAt: 210, error: "timeout" });
  assert.equal(j.scope(wallet, "xyz")?.error, "timeout"); assert.deepEqual(j.scope(wallet, "xyz")?.payload, snapshot.payload);
  j.recordScope({ ...snapshot, requestedAt: 300, receivedAt: 310, payload: { assetPositions: [] } });
  assert.deepEqual(j.scope(wallet, "xyz")?.payload, { assetPositions: [] });
  assert.equal(j.recordScope(snapshot), false);
});

test("history boundaries split without losing same-time executions and report unrecoverable saturation", async () => {
  const all = Array.from({ length: 2500 }, (_, i) => fill({ time: i < 1000 ? 100 : 200, tid: i }));
  const result = await recoverFills(100, 200, async (from, to) => all.filter((f) => f.time >= from && f.time <= to).slice(0, 2000));
  assert.equal(result.complete, true); assert.equal(result.fills.length, 2500);
  const saturated = await recoverFills(100, 100, async () => Array.from({ length: 2000 }, (_, tid) => fill({ tid })));
  assert.equal(saturated.complete, false); assert.equal(saturated.gaps[0].reason, "saturated_timestamp");
  assert.equal((await recoverFills(0, 100, async () => { throw new Error("offline"); })).complete, false);
});

test("history and shadow do not enqueue; outbox survives delivery timeout and respects leases", () => {
  const j = setup(); const now = Date.now();
  j.ingest(wallet, fill({ time: now }), "userFills", "history"); j.project(); assert.equal(j.readySignals(now + 2000).length, 0);
  j.ingest(wallet, fill({ time: now + 1, tid: 2, startPosition: "1" }), "userFills", "live"); j.project();
  const group = j.readySignals(now + 2000)[0]; assert.ok(group);
  j.completeSignal(group.id, [{ recipient: "u", channel: "telegram", payload: { text: "test" } }]);
  const first = j.claimDelivery(now + 3000); assert.ok(first); assert.equal(j.claimDelivery(now + 3001), null);
  const restarted = createFillJournal(j.db); const retry = restarted.claimDelivery(now + 70_000); assert.equal(retry?.id, first.id);
  restarted.finishDelivery(first.id, "message-1"); assert.equal(restarted.claimDelivery(now + 140_000), null);
});

test("transactions reject async work and roll back partial writes", () => {
  const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE t(n)");
  assert.throws(() => transaction(db, () => { db.exec("INSERT INTO t VALUES (1)"); throw new Error("stop"); }));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM t").get() as { n: number }).n, 0);
});

test("later confirmed opening restores confidence after an ambiguous older block", () => {
  const j = setup(); j.ingest(wallet, fill(), "userFills"); j.ingest(wallet, fill({ tid: 2 }), "userFills");
  j.ingest(wallet, fill({ time: 200, tid: 3, startPosition: "0" }), "userFills"); j.project();
  assert.equal(j.getState(wallet, "BTC")?.openedAt, 200);
  assert.equal(j.events().find((row) => row.tid === 3)?.precision, "exact");
});

test("one order opening through several fills creates one durable signal group", () => {
  const j = setup(); const now = Date.now();
  j.ingest(wallet, fill({ time: now, oid: 42 }), "userFills", "live"); j.project();
  j.ingest(wallet, fill({ time: now + 1, tid: 2, oid: 42, startPosition: "1" }), "userFills", "live"); j.project();
  const groups = j.readySignals(now + 3000); assert.equal(groups.length, 1); assert.equal(groups[0].fills.length, 2);
});

test("an intervening order prevents grouping non-contiguous position changes", () => {
  const j = setup(); const now = Date.now();
  j.ingest(wallet, fill({ time: now, oid: 42 }), "userFills", "live"); j.project();
  j.ingest(wallet, fill({ time: now + 1, tid: 2, oid: 43, startPosition: "1", side: "A" }), "userFills", "live"); j.project();
  j.ingest(wallet, fill({ time: now + 2, tid: 3, oid: 42, startPosition: "0" }), "userFills", "live"); j.project();
  assert.equal(j.readySignals(now + 3000).length, 3);
});

test("a close after a snapshot cannot remain a coin participant", () => {
  const j = setup(); j.recordScope({ wallet, scope: "", requestedAt: 100, receivedAt: 110, payload: { assetPositions: [{ position: { coin: "BTC", szi: "1" } }] } });
  j.ingest(wallet, fill({ time: 200, side: "A", startPosition: "1" }), "userFills"); j.project();
  assert.equal(j.currentSnapshots(0).length, 0);
});

test("ingestion batches roll back all rows on a database failure", () => {
  const j = setup();
  j.db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON canonical_fills WHEN NEW.occurred_at=200 BEGIN SELECT RAISE(ABORT,'write_failure'); END;");
  assert.throws(() => j.ingestBatch([{ wallet, fill: fill(), source: "userFills" }, { wallet, fill: fill({ time: 200 }), source: "userFills" }]), /write_failure/);
  assert.equal(j.fills(wallet).length, 0);
  assert.equal((j.db.prepare("SELECT COUNT(*) n FROM fill_observations").get() as { n: number }).n, 0);
  j.db.exec("DROP TRIGGER reject_second"); j.ingest(wallet, fill(), "userFills"); assert.equal(j.fills(wallet).length, 1);
});

test("inventory outcome trades never become leveraged short positions", () => {
  const j = setup(); j.ingest(wallet, fill({ coin: "#14731", side: "A" }), "userFills"); j.project();
  assert.equal(j.events()[0].action, "SELL"); assert.equal(j.events()[0].direction, "SELL");
});

test("full journal pagination filters before sorting and does not depend on a browser buffer", () => {
  const j = setup();
  j.ingestBatch(Array.from({ length: 125 }, (_, i) => ({ wallet, fill: fill({ time: 100 + i, tid: i, startPosition: String(i), px: String(i + 1) }), source: "userFills" as const })));
  j.project(); const page = j.queryEvents({ wallet, order: "oldest", limit: 50 });
  assert.equal(page.events[0].time, 100); assert.equal(page.nextOffset, 50);
  assert.equal(j.queryEvents({ wallet, order: "oldest", offset: page.nextOffset!, limit: 50 }).events[0].time, 150);
  assert.equal(j.queryEvents({ wallet, action: "OPEN", order: "largest" }).events.length, 1);
  assert.equal(j.queryEvents({ wallet, from: 220, order: "price" }).events[0].px, "125");
});

test("replaying unchanged history does not re-emit old events", () => {
  const j = setup(); j.ingest(wallet, fill(), "userFills"); j.project();
  const sequence = j.revision();
  j.ingest(wallet, fill({ time: 50, tid: 2, coin: "BTC", startPosition: "0", side: "A" }), "userFills"); j.project();
  assert.deepEqual(j.eventsSince(sequence).map((row) => row.tid), [2]);
  assert.equal(j.eventsSince(sequence, 60).length, 0);
});

test("viewer leases are throttled and never block the web process for seconds", () => {
  const filename = path.join(mkdtempSync(path.join(tmpdir(), "dc-lease-")), "test.sqlite");
  const db = new DatabaseSync(filename); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  const j = createFillJournal(db); j.touchWallet(wallet, 100); j.touchWallet(wallet, 101);
  assert.equal((db.prepare("SELECT expires_at FROM active_wallets").get() as { expires_at: number }).expires_at, 30100);
  const writer = new DatabaseSync(filename); writer.exec("BEGIN IMMEDIATE");
  const start = performance.now(); assert.throws(() => j.touchWallet(wallet, 20100), /locked/);
  assert.ok(performance.now() - start < 1000);
  writer.exec("ROLLBACK"); writer.close();
  j.touchWallet(wallet, 20100); assert.deepEqual(j.activeWallets(30101), [wallet]); db.close();
});

test("coverage never bridges a missing interval and survives a failed recovery", () => {
  const j = setup(); j.coverage(wallet, "fills", 100, 200, "covered_interval");
  j.coverage(wallet, "fills", 300, 400, "covered_interval");
  assert.equal(j.getCoverage(wallet)?.from_time, 300);
  j.coverage(wallet, "fills", 300, 400, "gap", "offline");
  j.coverage(wallet, "fills", 200, 300, "covered_interval");
  assert.equal(j.getCoverage(wallet)?.from_time, 100); assert.equal(j.getCoverage(wallet)?.through_time, 400);
});

test("restart invalidates coverage atomically without inventing history for unseen wallets", () => {
  const j = setup(); j.coverage(wallet, "fills", 100, 200, "covered_interval");
  j.markStreamGap([wallet, `0x${"b".repeat(40)}`], "stream_restart");
  assert.equal(j.getCoverage(wallet)?.status, "gap"); assert.equal(j.getCoverage(wallet)?.from_time, 100);
  assert.equal(j.getCoverage(wallet)?.through_time, 200); assert.equal(j.getCoverage(`0x${"b".repeat(40)}`), undefined);
});

test("missing source fields stay unconfirmed until the actual API fill enriches them", () => {
  const j = setup(); j.ingest(wallet, { ...fill(), startPosition: undefined }, "market");
  assert.equal(j.hasUnconfirmed(wallet, 0, 1000), true);
  j.ingest(wallet, fill(), "userFills"); assert.equal(j.hasUnconfirmed(wallet, 0, 1000), false);
});

test("new market evidence is immediately observed but position replay remains pending", () => {
  const j = setup(); const now = Date.now();
  j.ingest(wallet, { ...fill({ time: now }), startPosition: undefined }, "market", "shadow", now);
  assert.equal(j.events()[0].precision, "observed"); assert.equal(j.events()[0].action, "BUY");
  assert.equal(j.getState(wallet, "BTC"), null); assert.equal(j.hasUnconfirmed(wallet, now, now), true);
  const sequence = j.revision(); j.project(); assert.equal(j.eventsSince(sequence).length, 0);
  j.ingest(wallet, fill({ time: now }), "userFills", "history", now + 1); j.project();
  assert.equal(j.events()[0].precision, "exact"); assert.equal(j.events()[0].action, "OPEN");
  assert.equal(j.getState(wallet, "BTC")?.size, "1"); assert.equal(j.eventsSince(sequence).length, 1);
  assert.equal(j.fills(wallet).length, 1); assert.equal(j.readySignals(now + 2000).length, 0);
});
