import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("a pinned WAL read snapshot backs up consistently while the writer continues", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dc-backup-test-"));
  const filename = path.join(directory, "source.sqlite"), destination = path.join(directory, "backup.sqlite");
  const writer = new DatabaseSync(filename); writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(n); INSERT INTO t VALUES(1)");
  const reader = new DatabaseSync(filename, { readOnly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM sqlite_master").get();
  writer.exec("INSERT INTO t VALUES(2)"); await backup(reader, destination); reader.close(); writer.close();
  const restored = new DatabaseSync(destination, { readOnly: true });
  assert.equal(restored.prepare("SELECT COUNT(*) n FROM t").get()!.n, 1);
  assert.equal(restored.prepare("PRAGMA quick_check").get()!.quick_check, "ok"); restored.close();
});
