import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDatabase, transaction } from "./database.ts";
import { decimalEqual, decimalSign, fillTransition, orderFillChain, reducePosition, validDecimal, type PositionState } from "./position-reducer.ts";
import { closedTrades, type ClosedTrade, type Fill } from "./stats.ts";
import type { FillEvidence } from "./hyperliquid";

export type JournalSource = "market" | "userFills";
export type IngestMode = "live" | "history" | "shadow";
export type RawFill = Fill & { oid?: number; builderFee?: string };
export type StoredFill = RawFill & { wallet: string; id: string; source: "user" | "market"; revision: number; receivedAt: number };
type FillRow = { id: string; wallet: string; coin: string; occurred_at: number; payload: string; revision: number; received_at: number; mode: IngestMode; conflict: number; projected_revision: number };
type StateRow = { size: string; opened_at: number | null; last_time: number; reason: string | null };
export type ScopeSnapshot = { wallet: string; scope: string; requestedAt: number; receivedAt: number; sourceTime?: number; error?: string; payload?: Record<string, unknown> };
export type Delivery = { recipient: string; channel: "telegram" | "push"; payload: Record<string, unknown>; destination?: string };

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
export const validWalletAddress = (value: string) => addressPattern.test(value);
export const marketScope = (coin: string) => coin.startsWith("#") ? "outcome" : coin.startsWith("@") ? "spot" : coin.includes(":") ? coin.split(":", 1)[0] : "";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const parse = (row: FillRow): StoredFill => ({ ...JSON.parse(row.payload), id: row.id, wallet: row.wallet,
  source: JSON.parse(row.payload).startPosition === undefined ? "market" : "user", revision: row.revision, receivedAt: row.received_at });
const stateFrom = (row?: StateRow): PositionState | null => row ? { size: row.size, openedAt: row.opened_at, lastTime: row.last_time, reason: row.reason } : null;
const parseEvent = (row: { payload: string; confirmed_at: number | null }) => ({ ...JSON.parse(row.payload), confirmedAt: row.confirmed_at ?? null });

export function createFillJournal(db: DatabaseSync) {
  let batching = false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_schema (version INTEGER PRIMARY KEY, installed_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO journal_schema VALUES (2, ${Date.now()});
    CREATE TABLE IF NOT EXISTS fill_observations (
      id TEXT PRIMARY KEY, fill_id TEXT, wallet TEXT NOT NULL, source TEXT NOT NULL, received_at INTEGER NOT NULL,
      payload TEXT NOT NULL, error TEXT
    );
    CREATE INDEX IF NOT EXISTS observations_fill ON fill_observations(fill_id);
    CREATE TABLE IF NOT EXISTS canonical_fills (
      id TEXT PRIMARY KEY, wallet TEXT NOT NULL, coin TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      payload TEXT NOT NULL, revision INTEGER NOT NULL, projected_revision INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL, mode TEXT NOT NULL, conflict INTEGER NOT NULL DEFAULT 0, persisted_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS canonical_wallet_market ON canonical_fills(wallet, coin, occurred_at, id);
    CREATE INDEX IF NOT EXISTS canonical_time ON canonical_fills(occurred_at DESC, id);
    CREATE INDEX IF NOT EXISTS canonical_pending ON canonical_fills(projected_revision, revision);
    CREATE TABLE IF NOT EXISTS projection_jobs (wallet TEXT NOT NULL, coin TEXT NOT NULL, PRIMARY KEY(wallet,coin));
    CREATE TABLE IF NOT EXISTS journal_changes (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO journal_changes VALUES (1,0);
    CREATE TABLE IF NOT EXISTS position_projection (
      wallet TEXT NOT NULL, coin TEXT NOT NULL, size TEXT NOT NULL, opened_at INTEGER, last_time INTEGER NOT NULL,
      reason TEXT, PRIMARY KEY(wallet, coin)
    );
    CREATE TABLE IF NOT EXISTS lifecycle_events (
      id TEXT PRIMARY KEY, wallet TEXT NOT NULL, coin TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      payload TEXT NOT NULL, revision INTEGER NOT NULL, algorithm_version INTEGER NOT NULL, updated_seq INTEGER NOT NULL DEFAULT 0,
      projected_at INTEGER NOT NULL DEFAULT 0, confirmed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS lifecycle_time ON lifecycle_events(occurred_at DESC, id);
    CREATE INDEX IF NOT EXISTS lifecycle_wallet_market ON lifecycle_events(wallet,coin,occurred_at DESC,id);
    CREATE TABLE IF NOT EXISTS ingestion_coverage (
      wallet TEXT NOT NULL, feed TEXT NOT NULL, from_time INTEGER, through_time INTEGER,
      status TEXT NOT NULL, reason TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(wallet, feed)
    );
    CREATE TABLE IF NOT EXISTS covered_fill_intervals (
      wallet TEXT NOT NULL,feed TEXT NOT NULL,from_time INTEGER NOT NULL,through_time INTEGER NOT NULL,
      PRIMARY KEY(wallet,feed,from_time)
    );
    CREATE TABLE IF NOT EXISTS scope_snapshots (
      wallet TEXT NOT NULL, scope TEXT NOT NULL, requested_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      source_time INTEGER, payload TEXT, last_error TEXT, attempted_at INTEGER NOT NULL,
      PRIMARY KEY(wallet, scope)
    );
    CREATE TABLE IF NOT EXISTS active_wallets (wallet TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wallet_resources (
      wallet TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(wallet, kind)
    );
    CREATE TABLE IF NOT EXISTS completed_position_projection (
      wallet TEXT NOT NULL,coin TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(wallet,coin)
    );
    CREATE TABLE IF NOT EXISTS snapshot_history (
      wallet TEXT NOT NULL,scope TEXT NOT NULL,captured_at INTEGER NOT NULL,payload TEXT NOT NULL,
      PRIMARY KEY(wallet,scope,captured_at)
    );
    CREATE TABLE IF NOT EXISTS collector_status (name TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS signal_groups (
      id TEXT PRIMARY KEY, group_key TEXT NOT NULL, ready_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS signal_ready ON signal_groups(processed, ready_at);
    CREATE TABLE IF NOT EXISTS signal_fills (fill_id TEXT PRIMARY KEY, group_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_outbox (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, recipient TEXT NOT NULL, channel TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, receipt TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS delivery_due ON delivery_outbox(state, next_attempt, lease_until);
  `);
  if (!(db.prepare("PRAGMA table_info(lifecycle_events)").all() as { name: string }[]).some((column) => column.name === "updated_seq")) {
    db.exec("ALTER TABLE lifecycle_events ADD COLUMN updated_seq INTEGER NOT NULL DEFAULT 0;");
  }
  for (const [table, column, definition] of [["canonical_fills", "persisted_at", "INTEGER NOT NULL DEFAULT 0"], ["lifecycle_events", "projected_at", "INTEGER NOT NULL DEFAULT 0"], ["lifecycle_events", "confirmed_at", "INTEGER"]]) {
    if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((field) => field.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS lifecycle_seq ON lifecycle_events(updated_seq)");
  db.exec(`INSERT OR IGNORE INTO projection_jobs SELECT wallet,coin FROM lifecycle_events WHERE algorithm_version!=6;
    UPDATE canonical_fills SET projected_revision=0 WHERE id IN (SELECT id FROM lifecycle_events WHERE algorithm_version!=6);`);

  function ingest(wallet: string, input: unknown, source: JournalSource, mode: IngestMode = "history", receivedAt = Date.now()) {
    const address = wallet.toLowerCase(); const payload = JSON.stringify(input);
    if (!payload || payload.length > 32_768) throw new Error("Fill payload is too large");
    const fill = input as RawFill;
    const valid = validWalletAddress(address) && fill && typeof fill.coin === "string" && fill.coin.length <= 128 && /^[\w#@:/.+-]+$/.test(fill.coin)
      && ["A", "B"].includes(fill.side) && validDecimal(fill.sz) && decimalSign(fill.sz) > 0 && validDecimal(fill.px) && decimalSign(fill.px) > 0
      && Number.isSafeInteger(fill.time) && fill.time >= 0 && fill.time <= receivedAt + 60_000 && Number.isSafeInteger(fill.tid) && Number(fill.tid) >= 0
      && (fill.startPosition === undefined || validDecimal(fill.startPosition)) && (fill.fee === undefined || validDecimal(fill.fee))
      && (fill.closedPnl === undefined || validDecimal(fill.closedPnl))
      && (fill.feeToken === undefined || typeof fill.feeToken === "string" && fill.feeToken.length <= 32)
      && (fill.oid === undefined || Number.isSafeInteger(fill.oid) && fill.oid >= 0)
      && (fill.crossed === undefined || typeof fill.crossed === "boolean")
      && (fill.hash === undefined || typeof fill.hash === "string" && fill.hash.length <= 256)
      && (fill.dir === undefined || typeof fill.dir === "string" && fill.dir.length <= 64);
    const id = valid ? `hyperliquid:mainnet:${address}:${fill.coin}:${fill.time}:${fill.tid}` : null;
    const write = () => {
      db.prepare("INSERT OR IGNORE INTO fill_observations VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(digest(`${address}:${source}:${payload}`), id, address, source, receivedAt, payload, valid ? null : "invalid_or_unresolved_fill");
      if (!id) return { id: null, changed: false, error: "invalid_or_unresolved_fill" };
      const prior = db.prepare("SELECT * FROM canonical_fills WHERE id=?").get(id) as FillRow | undefined;
      const old = prior ? JSON.parse(prior.payload) as RawFill : undefined;
      const conflict = prior?.conflict || old && (old.side !== fill.side || !decimalEqual(old.px, fill.px) || !decimalEqual(old.sz, fill.sz)
        || (old.startPosition !== undefined && fill.startPosition !== undefined && !decimalEqual(old.startPosition, fill.startPosition)));
      const merged = conflict ? old! : { ...old, ...Object.fromEntries(Object.entries(fill).filter(([, value]) => value !== undefined)) } as RawFill;
      // Market messages cannot overwrite authoritative financial fields with invented zeroes.
      if (source === "market") for (const key of ["startPosition", "closedPnl", "fee", "feeToken", "oid", "crossed"] as const) {
        if (old?.[key] === undefined) delete merged[key];
        else Object.assign(merged, { [key]: old[key] });
      }
      if (source === "market" && old?.startPosition !== undefined) merged.dir = old.dir;
      const nextPayload = JSON.stringify(merged);
      const changed = !prior || nextPayload !== prior.payload || Boolean(conflict) !== Boolean(prior.conflict);
      if (changed) db.prepare(`INSERT INTO canonical_fills (id,wallet,coin,occurred_at,payload,revision,received_at,mode,conflict,persisted_at)
        VALUES (?,?,?,?,?,1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=canonical_fills.revision+1,conflict=excluded.conflict`)
        .run(id, address, fill.coin, fill.time, nextPayload, receivedAt, mode, conflict ? 1 : 0, Date.now());
      if (changed) db.prepare("INSERT OR IGNORE INTO projection_jobs VALUES (?,?)").run(address, fill.coin);
      if (changed && source === "market" && merged.startPosition === undefined && mode !== "history" && receivedAt - fill.time <= 10_000) {
        // Publish observed evidence without waiting for a potentially large lifecycle replay.
        const row = db.prepare("SELECT * FROM canonical_fills WHERE id=?").get(id) as FillRow;
        apply(row, null);
        db.prepare("UPDATE canonical_fills SET projected_revision=0 WHERE id=?").run(id);
        db.exec("UPDATE journal_changes SET revision=revision+1 WHERE id=1");
      }
      return { id, changed, error: conflict ? "conflicting_fill_evidence" : null };
    };
    return batching ? write() : transaction(db, write);
  }

  function ingestBatch(rows: { wallet: string; fill: unknown; source: JournalSource; mode?: IngestMode; receivedAt?: number }[]) {
    if (batching || rows.length > 2000) throw new Error("Invalid ingestion batch");
    return transaction(db, () => {
      batching = true;
      try { return rows.map((row) => ingest(row.wallet, row.fill, row.source, row.mode, row.receivedAt)); }
      finally { batching = false; }
    });
  }

  function getState(wallet: string, coin: string) {
    return stateFrom(db.prepare("SELECT * FROM position_projection WHERE wallet=? AND coin=?").get(wallet.toLowerCase(), coin) as StateRow | undefined);
  }

  function apply(row: FillRow, prior: PositionState | null, uncertain = false) {
    const fill = parse(row); const transition = fillTransition(fill);
    const validTransition = !row.conflict && !uncertain ? transition : null;
    const state = row.conflict || uncertain ? { size: prior?.size ?? "0", openedAt: null, lastTime: row.occurred_at, reason: row.conflict ? "conflicting_evidence" : "ambiguous_order" }
      : reducePosition(prior, fill);
    const event = { ...fill, action: validTransition?.action ?? (fill.side === "B" ? "BUY" : "SELL"),
      direction: validTransition?.direction ?? (fill.side === "B" ? "BUY" : "SELL"),
      beforeSize: validTransition ? Number(validTransition.before) : undefined, afterSize: validTransition ? Number(validTransition.after) : undefined,
      precision: validTransition ? "exact" : "observed", openingReason: state.reason,
      legs: validTransition?.action === "FLIP" ? [
        { action: "CLOSE", direction: decimalSign(validTransition.before) > 0 ? "LONG" : "SHORT", size: validTransition.before.replace(/^-/, ""), after: "0" },
        { action: "OPEN", direction: validTransition.direction, size: validTransition.after.replace(/^-/, ""), after: validTransition.after },
      ] : undefined };
    const eventPayload = JSON.stringify(event);
    const previous = db.prepare("SELECT payload,revision,algorithm_version FROM lifecycle_events WHERE id=?").get(row.id) as { payload: string; revision: number; algorithm_version: number } | undefined;
    // Replaying history must not turn unchanged old fills into thousands of live updates.
    if (previous?.payload === eventPayload && previous.revision === row.revision && previous.algorithm_version === 6) {
      if (row.projected_revision !== row.revision) db.prepare("UPDATE canonical_fills SET projected_revision=revision WHERE id=?").run(row.id);
      return state;
    }
    db.prepare(`INSERT INTO lifecycle_events (id,wallet,coin,occurred_at,payload,revision,algorithm_version,updated_seq,projected_at,confirmed_at)
      VALUES (?,?,?,?,?,?,6,(SELECT revision+1 FROM journal_changes WHERE id=1),?,?) ON CONFLICT(id) DO UPDATE SET
      payload=excluded.payload,revision=excluded.revision,algorithm_version=excluded.algorithm_version,updated_seq=excluded.updated_seq,
      confirmed_at=CASE WHEN excluded.confirmed_at IS NULL THEN NULL ELSE COALESCE(lifecycle_events.confirmed_at,excluded.confirmed_at) END`)
      .run(row.id, row.wallet, row.coin, row.occurred_at, eventPayload, row.revision, Date.now(), validTransition ? Date.now() : null);
    db.prepare("UPDATE canonical_fills SET projected_revision=revision WHERE id=?").run(row.id);
    if (row.mode === "live" && validTransition && Date.now() - row.occurred_at <= 120_000 && !db.prepare("SELECT 1 FROM signal_fills WHERE fill_id=?").get(row.id)) {
      const groupKey = `${row.wallet}:${row.coin}:${fill.oid ?? row.id}:${fill.side}`;
      let group = db.prepare("SELECT id FROM signal_groups WHERE group_key=? AND processed=0 AND created_at>=? ORDER BY created_at DESC LIMIT 1").get(groupKey, Date.now() - 3_000) as { id: string } | undefined;
      if (group) {
        const previousFill = db.prepare("SELECT e.payload FROM signal_fills f JOIN lifecycle_events e ON e.id=f.fill_id WHERE f.group_id=? ORDER BY f.rowid DESC LIMIT 1").get(group.id) as { payload: string } | undefined;
        const previousChange = previousFill ? fillTransition(JSON.parse(previousFill.payload)) : null;
        if (!previousChange || !decimalEqual(previousChange.after, validTransition.before)) group = undefined;
      }
      const groupId = group?.id ?? row.id;
      db.prepare("INSERT OR IGNORE INTO signal_groups VALUES (?,?,?,?,0)").run(groupId, groupKey, Date.now() + 500, Date.now());
      db.prepare("INSERT OR IGNORE INTO signal_fills VALUES (?,?)").run(row.id, groupId);
    }
    return state;
  }

  function project(limit = 100, budgetMs = Infinity) {
    const started = performance.now(); let processed = 0;
    const markets = db.prepare("SELECT wallet,coin FROM projection_jobs LIMIT ?").all(limit) as { wallet: string; coin: string }[];
    for (const { wallet, coin } of markets) {
    if (processed && performance.now() - started >= budgetMs) break;
    transaction(db, () => {
      const pending = db.prepare("SELECT * FROM canonical_fills WHERE wallet=? AND coin=? AND revision!=projected_revision ORDER BY occurred_at,id").all(wallet, coin) as FillRow[];
      let state = getState(wallet, coin);
      const incremental = state && pending.every((row) => row.projected_revision === 0 && row.occurred_at > state!.lastTime);
      const rows = incremental ? pending : db.prepare("SELECT * FROM canonical_fills WHERE wallet=? AND coin=? ORDER BY occurred_at,id").all(wallet, coin) as FillRow[];
      if (!incremental) state = null;
      const chain = orderFillChain(rows.map(parse), state);
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const fill of chain.fills) state = apply(byId.get(fill.id)!, state, chain.ambiguousTimes.has(fill.time));
      if (state) db.prepare(`INSERT INTO position_projection VALUES (?,?,?,?,?,?) ON CONFLICT(wallet,coin) DO UPDATE
        SET size=excluded.size,opened_at=excluded.opened_at,last_time=excluded.last_time,reason=excluded.reason`)
        .run(wallet, coin, state.size, state.openedAt, state.lastTime, state.reason);
      if (!incremental || pending.some((row) => row.conflict || JSON.parse(row.payload).startPosition !== undefined)) {
        const history = db.prepare("SELECT payload,conflict FROM canonical_fills WHERE wallet=? AND coin=? ORDER BY occurred_at,id").all(wallet, coin) as { payload: string; conflict: number }[];
        // Unknown/conflicting executions break continuity; dropping them invents a lifecycle across the gap.
        const completed = closedTrades(history.map((row) => ({ ...JSON.parse(row.payload), ...(row.conflict ? { startPosition: undefined } : {}) }) as RawFill));
        db.prepare("INSERT INTO completed_position_projection VALUES (?,?,?,?) ON CONFLICT(wallet,coin) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at")
          .run(wallet, coin, JSON.stringify(completed), Date.now());
      }
      db.prepare("DELETE FROM projection_jobs WHERE wallet=? AND coin=?").run(wallet, coin);
      db.exec("UPDATE journal_changes SET revision=revision+1 WHERE id=1");
    }); processed++;
    }
    return processed;
  }

  function fills(wallet: string, limit = 10_000): StoredFill[] {
    return (db.prepare("SELECT * FROM canonical_fills WHERE wallet=? ORDER BY occurred_at DESC,id LIMIT ?").all(wallet.toLowerCase(), limit) as FillRow[]).map(parse);
  }

  function events(since = 0, limit = 2_000, wallet?: string) {
    return (db.prepare(`SELECT payload,confirmed_at FROM lifecycle_events WHERE occurred_at>=? ${wallet ? "AND wallet=?" : ""} ORDER BY occurred_at DESC,id LIMIT ?`)
      .all(...(wallet ? [since, wallet.toLowerCase(), limit] : [since, limit])) as { payload: string; confirmed_at: number | null }[]).map((row) => parseEvent(row) as StoredFill & { confirmedAt: number | null; action: string; direction: string; precision: string; beforeSize?: number; afterSize?: number });
  }
  function eventsSince(sequence: number, since = 0, limit = 2001) {
    return (db.prepare("SELECT payload,confirmed_at FROM lifecycle_events WHERE updated_seq>? AND occurred_at>=? ORDER BY updated_seq,id LIMIT ?").all(sequence, since, limit) as { payload: string; confirmed_at: number | null }[]).map(parseEvent);
  }

  function recordScope(input: ScopeSnapshot) {
    if (!validWalletAddress(input.wallet) || !Number.isSafeInteger(input.receivedAt) || !Number.isSafeInteger(input.requestedAt)
      || input.requestedAt < 0 || input.requestedAt > input.receivedAt || typeof input.scope !== "string" || input.scope.length > 64) throw new Error("Invalid scope snapshot");
    if (!input.error) {
      const members = input.scope === "spot" ? input.payload?.balances : input.payload?.assetPositions;
      if (!Array.isArray(members)) throw new Error("Incomplete scope snapshot");
      if (input.scope !== "spot" && members.some((row) => !row?.position || typeof row.position.coin !== "string" || !validDecimal(row.position.szi))) throw new Error("Invalid position in scope snapshot");
    }
    const prior = scope(input.wallet, input.scope);
    if (prior && prior.requestedAt > input.requestedAt) return false;
    const write = () => {
    db.prepare(`INSERT INTO scope_snapshots VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(wallet,scope) DO UPDATE SET
      requested_at=CASE WHEN excluded.last_error IS NULL THEN excluded.requested_at ELSE scope_snapshots.requested_at END,
      received_at=CASE WHEN excluded.last_error IS NULL THEN excluded.received_at ELSE scope_snapshots.received_at END,
      source_time=CASE WHEN excluded.last_error IS NULL THEN excluded.source_time ELSE scope_snapshots.source_time END,
      payload=COALESCE(excluded.payload,scope_snapshots.payload),last_error=excluded.last_error,attempted_at=excluded.attempted_at`)
      .run(input.wallet.toLowerCase(), input.scope, input.requestedAt, input.receivedAt, input.sourceTime ?? null, input.error ? null : JSON.stringify(input.payload ?? {}), input.error ?? null, input.receivedAt);
    if (!input.error) {
      const previous = db.prepare("SELECT MAX(captured_at) latest FROM snapshot_history WHERE wallet=? AND scope=?").get(input.wallet.toLowerCase(), input.scope) as { latest: number | null };
      if (previous.latest === null || input.receivedAt - previous.latest >= 10_000) db.prepare("INSERT OR IGNORE INTO snapshot_history VALUES (?,?,?,?)")
        .run(input.wallet.toLowerCase(), input.scope, input.receivedAt, JSON.stringify(input.payload ?? {}));
    }
    };
    if (batching) write(); else transaction(db, write);
    return true;
  }
  function recordScopes(inputs: ScopeSnapshot[]) {
    if (batching || inputs.length > 100) throw new Error("Invalid snapshot batch");
    return transaction(db, () => {
      batching = true;
      try { return inputs.map(recordScope); } finally { batching = false; }
    });
  }

  function scopes(wallet: string): ScopeSnapshot[] {
    return (db.prepare("SELECT * FROM scope_snapshots WHERE wallet=?").all(wallet.toLowerCase()) as { wallet: string; scope: string; requested_at: number; received_at: number; source_time: number | null; payload: string | null; last_error: string | null }[])
      .map((row) => ({ wallet: row.wallet, scope: row.scope, requestedAt: row.requested_at, receivedAt: row.received_at, sourceTime: row.source_time ?? undefined, payload: row.payload ? JSON.parse(row.payload) : undefined, error: row.last_error ?? undefined }));
  }
  function scope(wallet: string, name: string) { return scopes(wallet).find((row) => row.scope === name); }

  function coverage(wallet: string, feed: string, from: number, through: number, status: string, reason: string | null = null) {
    if (!validWalletAddress(wallet) || !Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from < 0 || through < from) throw new Error("Invalid coverage interval");
    const address = wallet.toLowerCase();
    transaction(db, () => {
    if (status === "covered_interval") {
      const intervals = db.prepare("SELECT from_time,through_time FROM covered_fill_intervals WHERE wallet=? AND feed=? AND from_time<=? AND through_time>=?")
        .all(address, feed, through + 1, from - 1) as { from_time: number; through_time: number }[];
      from = Math.min(from, ...intervals.map((interval) => interval.from_time));
      through = Math.max(through, ...intervals.map((interval) => interval.through_time));
      db.prepare("DELETE FROM covered_fill_intervals WHERE wallet=? AND feed=? AND from_time<=? AND through_time>=?").run(address, feed, through + 1, from - 1);
      db.prepare("INSERT INTO covered_fill_intervals VALUES (?,?,?,?)").run(address, feed, from, through);
    }
    db.prepare(`INSERT INTO ingestion_coverage VALUES (?,?,?,?,?,?,?) ON CONFLICT(wallet,feed) DO UPDATE SET
      from_time=excluded.from_time,through_time=excluded.through_time,status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`)
      .run(address, feed, from, through, status, reason, Date.now());
    });
  }
  function getCoverage(wallet: string, feed = "fills") {
    return db.prepare("SELECT * FROM ingestion_coverage WHERE wallet=? AND feed=?").get(wallet.toLowerCase(), feed) as { from_time: number; through_time: number; status: string; reason: string | null; updated_at: number } | undefined;
  }
  function markStreamGap(wallets: string[], reason = "stream_disconnected") {
    if (wallets.some((wallet) => !validWalletAddress(wallet))) throw new Error("Invalid stream wallet set");
    const update = db.prepare("UPDATE ingestion_coverage SET status='gap',reason=?,updated_at=? WHERE wallet=? AND feed='fills'");
    const now = Date.now();
    for (let start = 0; start < wallets.length; start += 5000) transaction(db, () => {
      for (const wallet of wallets.slice(start, start + 5000)) update.run(reason, now, wallet.toLowerCase());
    });
  }
  function hasUnconfirmed(wallet: string, from: number, through: number) {
    return Boolean(db.prepare("SELECT 1 FROM canonical_fills WHERE wallet=? AND occurred_at BETWEEN ? AND ? AND (json_extract(payload,'$.startPosition') IS NULL OR conflict=1) LIMIT 1")
      .get(wallet.toLowerCase(), from, through));
  }
  function touchWallet(wallet: string, now = Date.now()) {
    if (!validWalletAddress(wallet)) throw new Error("Invalid wallet");
    const prior = db.prepare("SELECT expires_at FROM active_wallets WHERE wallet=?").get(wallet.toLowerCase()) as { expires_at: number } | undefined;
    if (prior && prior.expires_at >= now + 20_000) return;
    const timeout = (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    db.exec("PRAGMA busy_timeout=50");
    try { transaction(db, () => {
    if (!db.prepare("SELECT 1 FROM active_wallets WHERE wallet=?").get(wallet.toLowerCase())) {
      db.prepare("DELETE FROM active_wallets WHERE expires_at<=?").run(now);
      if ((db.prepare("SELECT COUNT(*) n FROM active_wallets").get() as { n: number }).n >= 1000) throw new Error("Active wallet capacity reached");
    }
    db.prepare("INSERT INTO active_wallets VALUES (?,?) ON CONFLICT(wallet) DO UPDATE SET expires_at=excluded.expires_at").run(wallet.toLowerCase(), now + 30_000);
    }); } finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
  }
  function activeWallets(now = Date.now()) {
    return (db.prepare("SELECT wallet FROM active_wallets WHERE expires_at>? ORDER BY expires_at DESC LIMIT 1000").all(now) as { wallet: string }[]).map((row) => row.wallet);
  }
  function currentSnapshots(since = Date.now() - 900_000) {
    type SnapshotPosition = { coin: string; szi: string; entryPx?: string; positionValue?: string; unrealizedPnl?: string; leverage?: { value: number }; liquidationPx?: string; marginUsed?: string };
    return (db.prepare("SELECT wallet,scope,payload,received_at,last_error FROM scope_snapshots WHERE received_at>=? AND payload IS NOT NULL AND last_error IS NULL AND scope!='spot'").all(since) as { wallet: string; scope: string; payload: string; received_at: number; last_error: string | null }[])
      .flatMap((row) => ((JSON.parse(row.payload).assetPositions ?? []) as { position: SnapshotPosition }[]).flatMap(({ position: p }) => {
        const state = getState(row.wallet, p.coin);
        if (!Number(p.szi) || state && state.lastTime > row.received_at && !state.reason && !decimalEqual(state.size, p.szi)) return [];
        return [{
        wallet: row.wallet, coin: p.coin, capturedAt: row.received_at, size: Number(p.szi), entryPx: Number(p.entryPx ?? 0),
        positionValue: Number(p.positionValue ?? 0), unrealizedPnl: Number(p.unrealizedPnl ?? 0), leverage: Number(p.leverage?.value ?? 1),
        liquidationPx: p.liquidationPx ? Number(p.liquidationPx) : null, marginUsed: Number(p.marginUsed ?? 0),
        source: row.last_error ? "Hyperliquid snapshot · stale/error" : "Hyperliquid scoped snapshot",
      }]; }));
  }
  function revision() { return (db.prepare("SELECT revision FROM journal_changes WHERE id=1").get() as { revision: number }).revision; }
  function resource(wallet: string, kind: string, payload?: unknown) {
    if (payload !== undefined) db.prepare("INSERT INTO wallet_resources VALUES (?,?,?,?) ON CONFLICT(wallet,kind) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at")
      .run(wallet.toLowerCase(), kind, JSON.stringify(payload), Date.now());
    const row = db.prepare("SELECT payload,updated_at FROM wallet_resources WHERE wallet=? AND kind=?").get(wallet.toLowerCase(), kind) as { payload: string; updated_at: number } | undefined;
    return row ? { payload: JSON.parse(row.payload), updatedAt: row.updated_at } : undefined;
  }
  function completed(wallet: string): ClosedTrade[] {
    return (db.prepare("SELECT payload FROM completed_position_projection WHERE wallet=?").all(wallet.toLowerCase()) as { payload: string }[])
      .flatMap((row) => JSON.parse(row.payload) as ClosedTrade[]).sort((a, b) => b.closedAt - a.closedAt);
  }
  function opening(wallet: string, coin: string, time: number) {
    const row = db.prepare("SELECT payload FROM lifecycle_events WHERE wallet=? AND coin=? AND occurred_at=? AND json_extract(payload,'$.action') IN ('OPEN','FLIP') AND json_extract(payload,'$.precision')='exact' LIMIT 1")
      .get(wallet.toLowerCase(), coin, time) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ReturnType<typeof events>[number] : undefined;
  }
  function evidence(rows: ReturnType<typeof events>, now = Date.now()): Array<ReturnType<typeof events>[number] & FillEvidence> {
    const wallets = new Map<string, { scopes: ScopeSnapshot[]; trades: Map<string, ClosedTrade[]>; coverage: ReturnType<typeof getCoverage>; states: Map<string, ReturnType<typeof getState>> }>();
    return rows.map((event) => {
      let details = wallets.get(event.wallet);
      if (!details) {
        const trades = new Map<string, ClosedTrade[]>();
        for (const trade of completed(event.wallet)) { const rows = trades.get(trade.coin) ?? []; rows.push(trade); trades.set(trade.coin, rows); }
        details = { scopes: scopes(event.wallet), trades, coverage: getCoverage(event.wallet), states: new Map() }; wallets.set(event.wallet, details);
      }
      const scope = details.scopes.find((scope) => scope.scope === marketScope(event.coin));
      if (!details.states.has(event.coin)) details.states.set(event.coin, getState(event.wallet, event.coin));
      const state = details.states.get(event.coin);
      const completedTrade = details.trades.get(event.coin)?.find((trade) => trade.direction === event.direction && trade.openedAt !== null && trade.openedAt <= event.time && (trade.closedAt > event.time || event.action === "CLOSE" && trade.closedAt === event.time));
      if (completedTrade) return { ...event, positionStatus: "closed" as const, openedAt: completedTrade.openedAt, closedAt: completedTrade.closedAt, netPnl: Number.isFinite(completedTrade.netPnl) ? completedTrade.netPnl : null };
      const fresh = scope?.payload && !scope.error && scope.receivedAt >= event.time && now - scope.receivedAt < 30_000;
      const position = fresh ? (scope.payload!.assetPositions as { position: { coin: string; szi: string; leverage?: { value: number } } }[] | undefined)?.find((row) => row.position.coin === event.coin)?.position : undefined;
      const aligned = position && state && !state.reason && state.lastTime <= scope!.receivedAt && decimalEqual(state.size, position.szi) && state.openedAt !== null && state.openedAt <= event.time;
      const coverage = details.coverage;
      const covered = aligned && coverage?.status === "covered_interval" && coverage.from_time <= state.openedAt! && coverage.through_time >= state.lastTime;
      return { ...event, positionStatus: aligned ? "open" as const : fresh && !position && ["OPEN", "ADD", "FLIP"].includes(event.action) ? "absent" as const : "unknown" as const,
        openedAt: covered ? state.openedAt : null, leverage: aligned ? position.leverage?.value : undefined,
        checkedAt: scope?.receivedAt, reason: !fresh ? "Нет свежей сверки позиции" : !aligned ? "Начало или завершение позиции не подтверждено" : !covered ? "История открытия неполная" : undefined };
    });
  }
  function queryEvents(input: { wallet?: string; wallets?: string[]; coin?: string; action?: string; actions?: string[]; direction?: string; precision?: string; query?: string; minNotional?: number; from?: number; to?: number; order?: "newest" | "oldest" | "largest" | "price" | "price-asc"; offset?: number; limit?: number }) {
    const where = ["occurred_at>=?", "occurred_at<=?"]; const values: (number | string)[] = [input.from ?? 0, input.to ?? Date.now()];
    if (input.wallet) { if (!validWalletAddress(input.wallet)) throw new Error("Invalid wallet"); where.push("wallet=?"); values.push(input.wallet.toLowerCase()); }
    if (input.coin) { where.push("coin=?"); values.push(input.coin); }
    if (input.action) { where.push("json_extract(payload,'$.action')=?"); values.push(input.action); }
    if (input.actions) { where.push("json_extract(payload,'$.action') IN (SELECT value FROM json_each(?))"); values.push(JSON.stringify(input.actions)); }
    if (input.wallets) { if (input.wallets.length > 1500 || input.wallets.some((wallet) => !validWalletAddress(wallet))) throw new Error("Invalid wallets"); where.push("wallet IN (SELECT value FROM json_each(?))"); values.push(JSON.stringify(input.wallets.map((wallet) => wallet.toLowerCase()))); }
    if (input.direction) { where.push("json_extract(payload,'$.direction')=?"); values.push(input.direction); }
    if (input.precision) { where.push("json_extract(payload,'$.precision')=?"); values.push(input.precision); }
    if (input.query) { where.push("(instr(lower(wallet),?)>0 OR instr(lower(coin),?)>0)"); values.push(input.query.toLowerCase(), input.query.toLowerCase()); }
    if (input.minNotional) { where.push("CAST(json_extract(payload,'$.px') AS REAL)*CAST(json_extract(payload,'$.sz') AS REAL)>=?"); values.push(input.minNotional); }
    const order = input.order === "oldest" ? "occurred_at ASC,id ASC" : input.order === "largest" ? "CAST(json_extract(payload,'$.px') AS REAL)*CAST(json_extract(payload,'$.sz') AS REAL) DESC,occurred_at DESC,id DESC"
      : input.order === "price" || input.order === "price-asc" ? `CAST(json_extract(payload,'$.px') AS REAL) ${input.order === "price" ? "DESC" : "ASC"},occurred_at DESC,id DESC` : "occurred_at DESC,id DESC";
    const offset = Math.max(0, Math.min(100_000, Math.floor(input.offset ?? 0))); const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
    const rows = db.prepare(`SELECT payload,confirmed_at FROM lifecycle_events WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, limit + 1, offset) as { payload: string; confirmed_at: number | null }[];
    return { events: rows.slice(0, limit).map(parseEvent), nextOffset: rows.length > limit ? offset + limit : null };
  }
  function status(name: string, payload?: unknown) {
    if (payload !== undefined) db.prepare("INSERT INTO collector_status VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at").run(name, JSON.stringify(payload), Date.now());
    const row = db.prepare("SELECT payload,updated_at FROM collector_status WHERE name=?").get(name) as { payload: string; updated_at: number } | undefined;
    return row ? { payload: JSON.parse(row.payload), updatedAt: row.updated_at } : undefined;
  }
  function readySignals(now = Date.now()) {
    return (db.prepare("SELECT id FROM signal_groups WHERE processed=0 AND ready_at<=? ORDER BY ready_at LIMIT 100").all(now) as { id: string }[])
      .map(({ id }) => ({ id, fills: (db.prepare("SELECT e.payload FROM signal_fills f JOIN lifecycle_events e ON e.id=f.fill_id WHERE f.group_id=? ORDER BY e.occurred_at,e.id").all(id) as { payload: string }[]).map((row) => JSON.parse(row.payload)) }));
  }
  function completeSignal(id: string, deliveries: Delivery[], inApp: () => void = () => {}) {
    transaction(db, () => {
      inApp();
      for (const delivery of deliveries) db.prepare("INSERT OR IGNORE INTO delivery_outbox (id,group_id,recipient,channel,payload,next_attempt) VALUES (?,?,?,?,?,?)")
        .run(`${id}:${delivery.recipient}:${delivery.channel}${delivery.destination ? `:${digest(delivery.destination)}` : ""}`, id, delivery.recipient, delivery.channel, JSON.stringify(delivery.payload), Date.now());
      db.prepare("UPDATE signal_groups SET processed=1 WHERE id=?").run(id);
    });
  }
  function claimDelivery(now = Date.now()) {
    return transaction(db, () => {
      const row = db.prepare("SELECT * FROM delivery_outbox WHERE state IN ('pending','sending') AND next_attempt<=? AND lease_until<=? ORDER BY next_attempt LIMIT 1").get(now, now) as { id: string; recipient: string; channel: "push" | "telegram"; payload: string; attempts: number } | undefined;
      if (!row) return null;
      db.prepare("UPDATE delivery_outbox SET state='sending',lease_until=?,attempts=attempts+1 WHERE id=?").run(now + 60_000, row.id);
      return { ...row, payload: JSON.parse(row.payload), attempts: row.attempts + 1 };
    });
  }
  function finishDelivery(id: string, receipt?: string, error?: string, now = Date.now()) {
    if (!error) db.prepare("UPDATE delivery_outbox SET state=?,receipt=?,lease_until=0 WHERE id=?").run(receipt?.startsWith("cancelled_") ? "cancelled" : "delivered", receipt ?? "accepted", id);
    else {
      const row = db.prepare("SELECT attempts FROM delivery_outbox WHERE id=?").get(id) as { attempts: number };
      db.prepare("UPDATE delivery_outbox SET state=?,lease_until=0,error=?,next_attempt=? WHERE id=?")
        .run(row.attempts >= 10 ? "failed" : "pending", error.slice(0, 500), now + Math.min(300_000, 1_000 * 2 ** row.attempts), id);
    }
  }
  return { ingest, ingestBatch, project, fills, events, eventsSince, queryEvents, getState, recordScope, recordScopes, scopes, scope, coverage, getCoverage, markStreamGap, hasUnconfirmed, touchWallet, activeWallets, currentSnapshots, revision, resource, completed, status,
    readySignals, completeSignal, claimDelivery, finishDelivery, opening, evidence, db };
}

let journal: ReturnType<typeof createFillJournal> | undefined;
export const getFillJournal = () => journal ??= createFillJournal(getDatabase());
