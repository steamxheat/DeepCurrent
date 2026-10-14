import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRecoveryQueue } from "./recovery-queue.ts";

test("a killed worker preserves committed recovery jobs and a new process resumes them", { timeout: 10000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "dc-recovery-crash-"));
  const filename = join(directory, "queue.sqlite"), moduleUrl = new URL("./recovery-queue.ts", import.meta.url).href;
  const worker = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    import { createRecoveryQueue } from ${JSON.stringify(moduleUrl)};
    const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=WAL');
    const queue = createRecoveryQueue(db), address = i => '0x' + i.toString(16).padStart(40, '0');
    for(let i=0;i<100;i++) queue.add(address(i),100,200);
    for(let i=0;i<50;i++) queue.complete(address(i),queue.get(address(i)).revision);
    queue.defer(address(50),30000,'offline'); queue.add(address(51),50,300);
    db.exec('BEGIN'); queue.add(address(100),1,2);
    process.send({ready:true}); setInterval(()=>{},1000);
  `, filename], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  context.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); rmSync(directory, { recursive: true }); });
  const ready = await Promise.race([once(worker, "message"), once(worker, "exit").then(() => { throw new Error("Recovery worker exited before saving its queue"); })]);
  assert.deepEqual(ready[0], { ready: true });
  const exit = once(worker, "exit"); assert.equal(worker.kill("SIGKILL"), true); assert.equal((await exit)[1], "SIGKILL");
  const resumed = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict'; import { DatabaseSync } from 'node:sqlite';
    import { createRecoveryQueue } from ${JSON.stringify(moduleUrl)};
    const db=new DatabaseSync(process.argv[1]), queue=createRecoveryQueue(db), address=i=>'0x'+i.toString(16).padStart(40,'0');
    assert.equal(queue.size,50); assert.equal(queue.has(address(100)),false);
    const deferred=queue.get(address(50)); assert.equal(deferred.attempts,1); assert.equal(deferred.last_error,'offline'); assert.ok(deferred.due_at>deferred.queued_at);
    assert.equal(queue.get(address(51)).from_time,50); assert.equal(queue.get(address(51)).through_time,300);
    assert.equal(queue.complete(address(51),1),false);
    for(const wallet of queue) assert.equal(queue.complete(wallet,queue.get(wallet).revision),true);
    assert.equal(queue.size,0); db.close(); console.log('50 pending jobs resumed; completed jobs stayed completed');
  `, filename], { encoding: "utf8", timeout: 5000 });
  assert.equal(resumed.status, 0, resumed.stderr); assert.match(resumed.stdout, /50 pending jobs resumed/);
});

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
