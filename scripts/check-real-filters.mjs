import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFillJournal } from "../src/lib/fill-journal.ts";
import { readWalletSnapshot } from "../src/lib/wallet-snapshot.ts";
import { sortPositions, filterPositions } from "../src/lib/wallet-sort.ts";

// Copy only public market records into memory; never initialize the journal on production SQLite.
const source = new DatabaseSync(".data/deep-current.sqlite", { readOnly: true });
const db = new DatabaseSync(":memory:"), journal = createFillJournal(db), now = Date.now();
let checks = 0, positions = 0, knownOpenings = 0;
try {
  source.exec("BEGIN");
  const wallets = source.prepare("SELECT wallet FROM lifecycle_events WHERE occurred_at>=? GROUP BY wallet ORDER BY COUNT(*) DESC LIMIT 6").all(now - 86_400_000).map(row => row.wallet);
  assert.equal(wallets.length, 6, "Real-data sample must contain six active wallets");
  const rows = wallets.flatMap(wallet => source.prepare("SELECT id,wallet,coin,occurred_at,payload FROM lifecycle_events WHERE wallet=? ORDER BY occurred_at DESC,id DESC LIMIT 500").all(wallet));
  assert.ok(rows.length >= 100, "Empty or tiny real history is not acceptance");
  const insert = db.prepare("INSERT INTO lifecycle_events(id,wallet,coin,occurred_at,payload,revision,algorithm_version) VALUES(?,?,?,?,?,1,7)");
  for (const row of rows) insert.run(row.id, row.wallet, row.coin, row.occurred_at, row.payload);
  const events = rows.map(row => ({ ...JSON.parse(row.payload), id: row.id }));
  const catalog = source.prepare("SELECT payload FROM collector_status WHERE name='catalog'").get();
  if (catalog) journal.status("catalog", JSON.parse(catalog.payload));
  for (const wallet of wallets) {
    const insertState = db.prepare("INSERT INTO position_projection VALUES(?,?,?,?,?,?)");
    for (const row of source.prepare("SELECT * FROM position_projection WHERE wallet=?").all(wallet)) insertState.run(row.wallet, row.coin, row.size, row.opened_at, row.last_time, row.reason);
    for (const row of source.prepare("SELECT * FROM ingestion_coverage WHERE wallet=?").all(wallet)) journal.coverage(wallet, row.feed, row.from_time, row.through_time, row.status, row.reason);
    for (const row of source.prepare("SELECT * FROM scope_snapshots WHERE wallet=? AND payload IS NOT NULL").all(wallet)) journal.recordScope({ wallet, scope: row.scope, requestedAt: row.requested_at, receivedAt: row.received_at, payload: JSON.parse(row.payload), error: row.last_error ?? undefined });
    const snapshot = readWalletSnapshot(wallet, journal, now);
    positions += snapshot.positions.length; knownOpenings += snapshot.positions.filter(p => p.openedAt !== null).length;
    for (const field of ["time", "duration", "notional", "pnl", "roi", "entry"]) for (const order of ["asc", "desc"]) {
      const value = p => field === "time" || field === "duration" ? p.openedAt : field === "notional" ? Math.abs(p.positionValue) : field === "roi" ? p.marginUsed > 0 ? p.unrealizedPnl / p.marginUsed * 100 : null : field === "pnl" ? p.unrealizedPnl : p.entryPx;
      const sorted = sortPositions(snapshot.positions, `${field}-${order}`);
      let unknown = false;
      for (let i = 0; i < sorted.length; i++) {
        const current = value(sorted[i]);
        if (!Number.isFinite(current)) unknown = true;
        else { assert.equal(unknown, false, "Known value after unknown"); if (i && Number.isFinite(value(sorted[i - 1]))) assert.ok((current - value(sorted[i - 1])) * (order === "asc" ? 1 : -1) * (field === "duration" ? -1 : 1) >= 0); }
      }
      checks++;
    }
    for (const side of ["LONG", "SHORT"]) assert.deepEqual(filterPositions(snapshot.positions, { coin: "", side, exactOnly: false }), snapshot.positions.filter(p => side === "LONG" ? p.size > 0 : p.size < 0));
    checks += 2;
  }
  assert.ok(positions > 0, "No real positions: cannot accept position filters");
  for (const order of ["newest", "oldest", "largest", "price", "price-asc"]) for (const coin of [...new Set(events.map(e => e.coin))].slice(0, 5)) for (const precision of ["exact", "observed"]) for (const direction of [undefined, "LONG", "SHORT"]) {
    const input = { coin, precision, direction, from: 0, to: now, minNotional: 100, order, limit: 100 };
    const expected = events.filter(e => e.coin === coin && e.precision === precision && (!direction || e.direction === direction) && Number(e.px) * Number(e.sz) >= 100 && e.time <= now).sort((a, b) => {
      const primary = order === "largest" ? Number(b.px) * Number(b.sz) - Number(a.px) * Number(a.sz) : order === "price" ? Number(b.px) - Number(a.px) : order === "price-asc" ? Number(a.px) - Number(b.px) : 0;
      return primary || (order === "oldest" ? a.time - b.time : b.time - a.time) || (order === "oldest" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id));
    });
    const actual = [], ids = new Set(); let offset = 0;
    do { const page = journal.queryEvents({ ...input, offset }); for (const event of page.events) { assert.equal(ids.has(event.id), false, "Duplicate across pages"); ids.add(event.id); actual.push(event.id); } offset = page.nextOffset; } while (offset !== null);
    assert.deepEqual(actual, expected.map(e => e.id), JSON.stringify(input)); checks++;
  }
  console.log(JSON.stringify({ checks, wallets: wallets.length, events: events.length, positions, knownOpenings, sourceReadOnly: true, productionChanged: false, scope: "Saved production records; no API truth or full browser acceptance. Opening history is not reconstructed by this check." }));
} finally { source.close(); db.close(); }
