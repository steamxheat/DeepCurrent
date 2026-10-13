import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.DEEPCURRENT_DB_PATH || ".data/deep-current.sqlite", { readOnly: true });
const since = process.argv[2] === undefined ? Date.now() - 600_000 : Number(process.argv[2]);
assert.ok(Number.isSafeInteger(since) && since >= 0 && since <= Date.now());
const integrity = db.prepare("PRAGMA quick_check").get().quick_check; assert.equal(integrity, "ok");
const statusRow = db.prepare("SELECT payload,updated_at FROM collector_status WHERE name='collector'").get();
const status = statusRow ? { ...JSON.parse(statusRow.payload), ageMs: Date.now() - statusRow.updated_at } : null;
const precision = db.prepare("SELECT json_extract(payload,'$.precision') precision,COUNT(*) n FROM lifecycle_events GROUP BY precision").all();
const pending = db.prepare("SELECT COUNT(*) n FROM projection_jobs").get().n;
const conflicts = db.prepare("SELECT COUNT(*) n FROM canonical_fills WHERE conflict=1").get().n;
const history = db.prepare("SELECT status,COUNT(*) wallets FROM ingestion_coverage WHERE feed='fills' GROUP BY status").all();
const deliveries = db.prepare("SELECT state,COUNT(*) n FROM delivery_outbox GROUP BY state").all();
const confirmationRow = db.prepare("SELECT payload,updated_at FROM collector_status WHERE name='confirmations'").get();
const confirmations = confirmationRow ? { ...JSON.parse(confirmationRow.payload), ageMs: Date.now() - confirmationRow.updated_at } : null;
const rows = db.prepare(`SELECT f.wallet,f.received_at-f.occurred_at received,f.persisted_at-f.occurred_at persisted,
  e.projected_at-f.occurred_at projected,e.confirmed_at-f.occurred_at confirmed
  FROM canonical_fills f JOIN lifecycle_events e ON e.id=f.id WHERE f.occurred_at>=? AND f.persisted_at>0 AND f.mode!='history' AND f.received_at-f.occurred_at BETWEEN 0 AND 10000`).all(since);
const percentile = (key, selected = rows) => { const values = selected.map((row) => row[key]).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b); return { n: values.length, p50: values[Math.floor(values.length * .5)] ?? null, p95: values[Math.floor(values.length * .95)] ?? null }; };
const outsidePersonal = rows.filter((row) => status?.exactWallets && !status.exactWallets.includes(row.wallet));
console.log(JSON.stringify({ since, integrity, status, precision, pending, conflicts, history, deliveries, confirmations,
  liveCoverage: { fills: rows.length, wallets: new Set(rows.map((row) => row.wallet)).size,
    outsidePersonalFills: outsidePersonal.length, outsidePersonalConfirmed: outsidePersonal.filter((row) => row.confirmed !== null).length,
    outsidePersonalConfirmedWallets: new Set(outsidePersonal.filter((row) => row.confirmed !== null).map((row) => row.wallet)).size },
  latencyMs: { receive: percentile("received"), persist: percentile("persisted"), projection: percentile("projected"), confirmation: percentile("confirmed"),
    confirmationCurrentlyPersonal: percentile("confirmed", rows.filter((row) => status?.exactWallets?.includes(row.wallet))),
    confirmationOutsidePersonal: percentile("confirmed", outsidePersonal) } }, null, 2));
db.close();
