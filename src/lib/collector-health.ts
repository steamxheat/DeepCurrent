import type { DatabaseSync } from "node:sqlite";

const kinds = new Set(["recovery_seeded", "viewer_priority", "start", "stop", "connect", "disconnect", "stream_error", "recovery_ok", "recovery_failed", "confirmation_failed", "fill_rejected", "projection_failed", "storage_stop", "http", "snapshot_failed", "resource_failed", "delivery_failed", "fatal", "targets_failed"]);

export function diagnosticError(error: unknown) {
  return (error instanceof Error ? error.stack || `${error.name}: ${error.message}` : typeof error === "string" ? error : "Unknown error")
    .replace(/https?:\/\/\S+/gi, "[URL redacted]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[token redacted]")
    .replace(/\b(authorization|cookie|token|secret|password|initData)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 2000);
}

export type HealthDetails = { wallet?: string; coin?: string; fillId?: string | null; code?: number; clean?: boolean; durationMs?: number; complete?: boolean; count?: number; operation?: string; scope?: string; attempt?: number; priority?: number; error?: string; stage?: string; from?: number; through?: number };

export function createCollectorHealth(db: DatabaseSync, runId: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS collector_health (
    id INTEGER PRIMARY KEY, time INTEGER NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS collector_health_time ON collector_health(time,id);`);
  const insert = db.prepare("INSERT INTO collector_health(time,run_id,kind,payload) VALUES (?,?,?,?)");
  const repeats = new Map<string, { id: number | bigint; time: number }>();
  let lastSample: number | undefined;
  function event(kind: string, details: HealthDetails = {}, now = Date.now()) {
    if (!kinds.has(kind)) throw new Error("Unknown collector health event");
    // Never include request bodies, headers or notification payloads; sanitize error messages too.
    const payload = JSON.stringify({ ...details, ...(details.error ? { error: diagnosticError(details.error) } : {}) });
    const key = `${kind}:${payload}`; const previous = details.error ? repeats.get(key) : undefined;
    if (previous && now - previous.time < 10000) {
      db.prepare("UPDATE collector_health SET payload=json_set(payload,'$.repetitions',COALESCE(json_extract(payload,'$.repetitions'),1)+1,'$.lastOccurrence',?) WHERE id=?").run(now, previous.id); return;
    }
    const row = insert.run(now, runId, kind, payload);
    if (details.error) { if (repeats.size >= 1000) repeats.clear(); repeats.set(key, { id: row.lastInsertRowid, time: now }); }
  }
  function sample(input: { connected: boolean; lastReceive: number; recoveryBacklog: number; pendingRequests: number; activeRequests: number; confirmationBacklog: number; confirmationFailures: number; cooldownUntil: number; freeBytes: number; rssBytes?: number; heapBytes?: number; confirmationOldestAgeMs?: number; confirmationExpired?: number; confirmationRejected?: number; indexedWallets?: number; acknowledgedMarkets?: number; exactUsers?: number; databaseBytes?: number; fillsChanged?: number; fillsRepeated?: number; fillsRejected?: number }, now = Date.now()) {
    if (lastSample !== undefined && now - lastSample < 60_000) return;
    const heartbeatGapMs = lastSample === undefined ? null : now - lastSample;
    lastSample = now;
    insert.run(now, runId, "sample", JSON.stringify({ ...input, heartbeatGapMs, receiveAgeMs: input.lastReceive ? Math.max(0, now - input.lastReceive) : null }));
    // shortcut: retain 30 days / at most 100,000 diagnostics, export before that for a longer audit.
    db.prepare("DELETE FROM collector_health WHERE time<? OR id<(SELECT id FROM collector_health ORDER BY id DESC LIMIT 1 OFFSET 99999)").run(now - 30 * 86_400_000);
  }
  return { event, sample };
}

export function collectorHealthReport(db: DatabaseSync, since: number, now = Date.now()) {
  if (!Number.isSafeInteger(since) || since < 0 || since > now) throw new Error("Invalid report start time");
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collector_health'").get();
  if (!exists) return { available: false, reason: "Diagnostics not installed on this database" };
  const samples = db.prepare("SELECT time,run_id,payload FROM collector_health WHERE kind='sample' AND time>=? ORDER BY time,id").all(since) as { time: number; run_id: string; payload: string }[];
  const events = db.prepare("SELECT time,run_id,kind,payload FROM collector_health WHERE kind!='sample' AND (kind!='http' OR json_extract(payload,'$.error') IS NOT NULL OR json_extract(payload,'$.durationMs')>=3000) AND time>=? ORDER BY time DESC,id DESC LIMIT 1001").all(since) as { time: number; run_id: string; kind: string; payload: string }[];
  const counts = db.prepare("SELECT kind,SUM(COALESCE(json_extract(payload,'$.repetitions'),1)) count FROM collector_health WHERE time>=? GROUP BY kind").all(since);
  const http = db.prepare("SELECT json_extract(payload,'$.operation') operation,json_extract(payload,'$.code') code,COUNT(*) count,ROUND(AVG(json_extract(payload,'$.durationMs'))) averageMs,MAX(json_extract(payload,'$.durationMs')) maxMs FROM collector_health WHERE kind='http' AND time>=? GROUP BY operation,code").all(since);
  const retainedFrom = db.prepare("SELECT MIN(time) time FROM collector_health").get() as { time: number | null };
  const values = samples.map((row) => JSON.parse(row.payload));
  const max = (key: string) => { const numbers = values.map((row) => row[key]).filter((value) => typeof value === "number" && Number.isFinite(value)); return numbers.length ? Math.max(...numbers) : null; };
  const latest = db.prepare("SELECT time,payload FROM collector_health WHERE kind='sample' ORDER BY id DESC LIMIT 1").get() as { time: number; payload: string } | undefined;
  const hasJournal = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_fills'").get();
  const latencyRows = hasJournal ? db.prepare(`SELECT f.received_at-f.occurred_at receiveMs,
    e.confirmed_at-f.occurred_at confirmationMs FROM canonical_fills f LEFT JOIN lifecycle_events e ON e.id=f.id
    WHERE f.occurred_at>=? AND f.mode!='history' ORDER BY f.occurred_at DESC LIMIT 100001`).all(since) as { receiveMs: number; confirmationMs: number | null }[] : [];
  const percentile = (key: "receiveMs" | "confirmationMs") => {
    const numbers = latencyRows.slice(0, 100000).map((row) => row[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    return { samples: numbers.length, p50: numbers[Math.floor(numbers.length * .5)] ?? null, p95: numbers[Math.floor(numbers.length * .95)] ?? null, max: numbers.at(-1) ?? null };
  };
  const dataState = hasJournal ? {
    projectionBacklog: db.prepare("SELECT COUNT(*) count FROM projection_jobs").get(),
    recoveryJobs: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_jobs'").get() ? db.prepare("SELECT COUNT(*) count,MIN(queued_at) oldestQueuedAt,SUM(due_at>?) delayed,MAX(attempts) maxAttempts FROM recovery_jobs").get(now) : null,
    coverage: db.prepare("SELECT status,COUNT(*) wallets FROM ingestion_coverage WHERE feed='fills' GROUP BY status").all(),
    uncertainPositions: db.prepare("SELECT reason,COUNT(*) positions FROM position_projection WHERE reason IS NOT NULL GROUP BY reason").all(),
    snapshots: db.prepare("SELECT COUNT(*) scopes,SUM(last_error IS NOT NULL) errors,SUM(received_at<?) olderThan30Seconds FROM scope_snapshots").get(now - 30000),
    deliveries: db.prepare("SELECT state,COUNT(*) count FROM delivery_outbox GROUP BY state").all(),
  } : null;
  return { available: true, since, generatedAt: now, retentionDays: 30, maxRows: 100000, retainedFrom: retainedFrom.time, http, counts, dataState,
    latency: { receiveMs: percentile("receiveMs"), confirmationMs: percentile("confirmationMs"),
      unconfirmed: latencyRows.slice(0, 100000).filter((row) => row.confirmationMs === null).length, capped: latencyRows.length > 100000,
      scope: "Latest 100,000 persisted non-history fills in window, including delays above 10 seconds; excludes unsupported wallets and client delivery latency." },
    sampleCount: samples.length, disconnectedSamples: values.filter((row) => !row.connected).length,
    cooldownSamples: values.filter((row, index) => row.cooldownUntil > samples[index].time).length,
    staleStreamSamples: values.filter((row) => row.connected && (row.receiveAgeMs === null || row.receiveAgeMs > 90_000)).length,
    max: { receiveAgeMs: max("receiveAgeMs"), heartbeatGapMs: max("heartbeatGapMs"), recoveryBacklog: max("recoveryBacklog"), pendingRequests: max("pendingRequests"), confirmationBacklog: max("confirmationBacklog") },
    latest: latest ? { time: latest.time, ageMs: now - latest.time, ...JSON.parse(latest.payload) } : null,
    eventsTruncated: events.length > 1000, events: events.slice(0, 1000).map((row) => ({ time: row.time, runId: row.run_id, kind: row.kind, ...JSON.parse(row.payload) })),
    note: "Minute samples are not an uptime percentage. A stale heartbeat can mean a stopped process or a machine outage; latency and full-history coverage require separate journal checks." };
}
