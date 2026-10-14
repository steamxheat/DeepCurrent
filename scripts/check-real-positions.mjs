import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFillJournal, validWalletAddress } from "../src/lib/fill-journal.ts";
import { readWalletSnapshot } from "../src/lib/wallet-snapshot.ts";
import { createInfoClient } from "../src/lib/hyperliquid-client.ts";
import { decimalEqual, fillTransition } from "../src/lib/position-reducer.ts";

const wallets = process.argv.slice(2);
assert.ok(wallets.length > 0 && wallets.length <= 5 && wallets.every(validWalletAddress), "Supply 1–5 public wallet addresses");
const client = createInfoClient(); const db = new DatabaseSync(":memory:"); const journal = createFillJournal(db);
const feedUrl = process.env.DC_VERIFY_FEED_URL;
assert.ok(!feedUrl || feedUrl === "http://127.0.0.1:3000", "Feed reconciliation is read-only and localhost-only");
const dexes = ["", ...(await client.post({ type: "perpDexs" })).flatMap((row) => row?.name ? [row.name] : [])];
journal.status("catalog", { dexNames: dexes });
const results = [];
try {
  for (const wallet of wallets) {
    const receivedAt = Date.now(); const fills = await client.post({ type: "userFills", user: wallet, aggregateByTime: false });
    assert.ok(Array.isArray(fills), "Invalid real fills response");
    for (const fill of fills) assert.ok(Number.isSafeInteger(fill.time) && fill.time > 0 && fill.time <= Date.now(), "Invalid exchange time");
    journal.ingestBatch(fills.map((fill) => ({ wallet, fill, source: "userFills", mode: "history", receivedAt }))); journal.project(1000);
    const first = fills.length ? Math.min(...fills.map((fill) => fill.time)) : Date.now();
    journal.coverage(wallet, "fills", first, Date.now(), "covered_interval", "Recent seed only; older history unproven");
    const outcomes = await Promise.all([...dexes, "spot"].map(async (scope) => {
      const requestedAt = Date.now();
      try {
        const payload = await client.post(scope === "spot" ? { type: "spotClearinghouseState", user: wallet } : { type: "clearinghouseState", user: wallet, ...(scope ? { dex: scope } : {}) });
        assert.ok(scope === "spot" ? Array.isArray(payload.balances) : Array.isArray(payload.assetPositions));
        journal.recordScope({ wallet, scope, requestedAt, receivedAt: Date.now(), payload }); return { scope, ok: true };
      } catch (error) { journal.recordScope({ wallet, scope, requestedAt, receivedAt: Date.now(), error: error.message }); return { scope, ok: false, error: error.message }; }
    }));
    const snapshot = readWalletSnapshot(wallet, journal);
    const sourceTimes = new Set(fills.map((fill) => fill.time));
    for (const position of snapshot.positions) {
      if (position.openedAt !== null) assert.ok(sourceTimes.has(position.openedAt), "Opening must refer to a real exchange fill, never a snapshot time");
    }
    const closed = journal.completed(wallet);
    for (const trade of closed) {
      assert.ok(sourceTimes.has(trade.closedAt), "Close must refer to a real exchange fill");
      if (trade.openedAt !== null) assert.ok(sourceTimes.has(trade.openedAt) && trade.closedAt >= trade.openedAt, "Invalid real position duration");
    }
    const before = journal.events(0, 10000, wallet).length;
    const repeats = journal.ingestBatch(fills.map((fill) => ({ wallet, fill, source: "userFills", mode: "history" }))); journal.project(1000);
    assert.equal(journal.events(0, 10000, wallet).length, before, "Replayed real fills must not create duplicates");
    assert.ok(repeats.every((row) => !row.changed && !row.error), "Repeated real evidence must be unchanged");
    let feed;
    if (feedUrl) {
      const response = await fetch(`${feedUrl}/api/events?wallet=${wallet}&precision=exact&limit=100`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
      const events = (await response.json()).events; const source = new Map(fills.map((fill) => [`${fill.time}:${fill.tid}`, fill])); let compared = 0;
      for (const event of events) {
        const original = source.get(`${event.time}:${event.tid}`); if (!original) continue;
        for (const field of ["px", "sz", "fee", "closedPnl", "startPosition"]) {
          if (event[field] === undefined || original[field] === undefined) assert.equal(event[field], original[field], `Feed differs from API: ${field}`);
          else assert.ok(decimalEqual(event[field], original[field]), `Feed differs from API: ${field}`);
        }
        assert.equal(event.side, original.side); assert.equal(event.hash, original.hash);
        const transition = fillTransition(original); assert.ok(transition); assert.equal(event.action, transition.action); assert.equal(event.direction, transition.direction); compared++;
      }
      feed = { returned: events.length, compared, notInFetchedSample: events.length - compared, source: "Production feed vs API executions; samples are non-atomic and API history is bounded" };
    }
    results.push({ wallet, fills: fills.length, feed, scopes: outcomes, positions: snapshot.positions.length, verifiedOpeningTimes: snapshot.positions.filter((p) => p.openedAt !== null).length,
      unknownOpeningTimes: snapshot.positions.filter((p) => p.openedAt === null).length, completedPositions: closed.length, unknownCompletedOpenings: closed.filter((p) => p.openedAt === null).length,
      unavailableScopes: snapshot.unavailableScopes, replayDuplicates: 0, latestExchangeFill: fills.length ? Math.max(...fills.map((fill) => fill.time)) : null });
  }
  console.log(JSON.stringify({ checkedAt: Date.now(), results, realApi: true, sourceDatabaseChanged: false, notificationsSent: false,
    limitation: "Point-in-time reconciliation of API-retained fills. Does not prove complete blockchain history, notification delivery, all 1000 wallets or continuous <=3 second confirmation." }, null, 2));
} finally { db.close(); }
