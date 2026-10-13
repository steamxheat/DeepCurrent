import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createCollectorHealth, collectorHealthReport, diagnosticError } from "./collector-health.ts";
import { createFillJournal } from "./fill-journal.ts";

const sample = { connected: true, lastReceive: 1000, recoveryBacklog: 2, pendingRequests: 3, activeRequests: 1, confirmationBacklog: 4, confirmationFailures: 0, cooldownUntil: 0, freeBytes: 2 ** 32 };

test("collector diagnostics survive restart, report gaps and do not sample every heartbeat", () => {
  const db = new DatabaseSync(":memory:");
  const first = createCollectorHealth(db, "first");
  first.event("start", {}, 1000); first.sample(sample, 1000); first.sample(sample, 2000);
  first.event("disconnect", { code: 1006, clean: false }, 5000);
  first.sample({ ...sample, connected: false, cooldownUntil: 200000 }, 121000);
  const second = createCollectorHealth(db, "second"); second.event("start", {}, 150000); second.event("connect", { durationMs: 145000 }, 150001);
  second.sample(sample, 150002);
  const report = collectorHealthReport(db, 0, 160000);
  assert.equal(report.sampleCount, 3); assert.equal(report.disconnectedSamples, 1); assert.equal(report.cooldownSamples, 1);
  assert.equal(report.max?.heartbeatGapMs, 120000); assert.equal(report.latest?.ageMs, 9998);
  assert.equal(report.events?.find((event) => event.kind === "disconnect")?.code, 1006);
  assert.equal(report.events?.[0].runId, "second"); assert.throws(() => first.event("unknown")); db.close();
});

test("diagnostic retention deletes only diagnostics and missing tables are reported honestly", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(collectorHealthReport(db, 0).available, false);
  db.exec("CREATE TABLE protected_data(value TEXT); INSERT INTO protected_data VALUES ('keep')");
  const health = createCollectorHealth(db, "test"); health.event("start", {}, 1); health.sample(sample, 31 * 86400000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM collector_health").get()?.n, 1);
  assert.equal(db.prepare("SELECT value FROM protected_data").get()?.value, "keep");
  assert.throws(() => collectorHealthReport(db, -1)); db.close();
});

test("diagnostics redact credentials and preserve useful HTTP and failure context", () => {
  const db = new DatabaseSync(":memory:"); const health = createCollectorHealth(db, "run");
  const secret = "123456789:abcdefghijklmnopqrstuvwxyz123456";
  const message = diagnosticError(new Error(`fetch https://api.telegram.org/bot${secret}/sendMessage token=private cookie=session ${secret}`));
  assert.ok(!message.includes(secret)); assert.ok(!message.includes("private")); assert.ok(!message.includes("session"));
  health.event("http", { operation: "userFills", code: 429, attempt: 2, durationMs: 40, error: message }, 100);
  health.event("http", { operation: "userFills", code: 200, attempt: 1, durationMs: 10 }, 101);
  const report = collectorHealthReport(db, 0, 200);
  assert.equal(report.events?.length, 1); assert.equal(report.events?.[0].attempt, 2);
  assert.equal(report.http?.length, 2); assert.equal(report.http?.find((row) => row.code === 429)?.count, 1); db.close();
});

test("latency report includes slow and unconfirmed fills instead of hiding them", () => {
  const db = new DatabaseSync(":memory:"); const journal = createFillJournal(db); const health = createCollectorHealth(db, "run"); health.event("start", {}, 1);
  journal.ingest(`0x${"a".repeat(40)}`, { coin: "BTC", time: 1000, side: "B", sz: "1", px: "100", tid: 1, hash: "h", dir: "Buy" }, "market", "live", 30000);
  const report = collectorHealthReport(db, 0, 40000);
  assert.equal(report.latency?.receiveMs.p95, 29000); assert.equal(report.latency?.confirmationMs.samples, 0); assert.equal(report.latency?.unconfirmed, 1); db.close();
});

test("repeated identical errors retain occurrence counts without flooding the report", () => {
  const db = new DatabaseSync(":memory:"); const health = createCollectorHealth(db, "run");
  for (let i = 0; i < 50; i++) health.event("stream_error", { error: "subscription capacity" }, 1000 + i);
  const report = collectorHealthReport(db, 0, 2000);
  assert.equal(report.events?.length, 1); assert.equal(report.events?.[0].repetitions, 50);
  assert.equal(report.counts?.find((row) => row.kind === "stream_error")?.count, 50); db.close();
});
