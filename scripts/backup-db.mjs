import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

mkdirSync(".data", { recursive: true });
const directory = mkdtempSync(path.resolve(".data", "journal-backup-")); chmodSync(directory, 0o700);
const source = new DatabaseSync(process.env.DEEPCURRENT_DB_PATH || ".data/deep-current.sqlite", { readOnly: true });
// Pin one WAL snapshot so continuous collector writes cannot repeatedly restart the backup.
source.exec("BEGIN"); source.prepare("SELECT COUNT(*) FROM sqlite_master").get();
const filename = path.join(directory, "database.sqlite"); await backup(source, filename); source.close(); chmodSync(filename, 0o600);
const restored = new DatabaseSync(filename, { readOnly: true });
const check = restored.prepare("PRAGMA quick_check").get(); restored.close();
if (check.quick_check !== "ok") throw new Error("Backup verification failed");
console.log(JSON.stringify({ directory, quickCheck: "ok" }));
