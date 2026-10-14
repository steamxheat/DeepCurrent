import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecoveryQueue } from "./recovery-queue.ts";

test("recovery survives restart, preserves missing intervals and does not delete concurrent gaps", () => {
  const directory = mkdtempSync(join(tmpdir(), "dc-recovery-test-"));
  let db = new DatabaseSync(join(directory, "queue.sqlite")); const wallet = `0x${"a".repeat(40)}`;
  const first = createRecoveryQueue(db); first.add(wallet, 100, 200); const job = first.get(wallet)!;
  first.defer(wallet, 30000, "offline");
  db.close(); db = new DatabaseSync(join(directory, "queue.sqlite"));
  const restored = createRecoveryQueue(db); assert.equal(restored.size, 1); assert.equal(restored.get(wallet)?.last_error, "offline");
  assert.equal(restored.get(wallet)?.attempts, 1); assert.ok(restored.get(wallet)!.due_at > Date.now());
  restored.add(wallet); restored.add(wallet, 100, 200); assert.equal(restored.get(wallet)?.revision, job.revision);
  restored.add(wallet.toUpperCase(), 50, 300); assert.equal(restored.get(wallet)?.from_time, 50); assert.equal(restored.get(wallet)?.through_time, 300);
  assert.equal(restored.complete(wallet, job.revision), false); assert.equal(restored.size, 1);
  assert.equal(restored.complete(wallet, restored.get(wallet)!.revision), true); assert.equal(restored.size, 0);
  assert.throws(() => restored.add("invalid", 1, 2)); assert.throws(() => restored.add(wallet, 200, 100)); db.close(); rmSync(directory, { recursive: true });
});
