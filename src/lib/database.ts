import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const connections = new Map<string, DatabaseSync>();

export function getDatabase() {
  const filename = path.resolve(/* turbopackIgnore: true */ process.env.DEEPCURRENT_DB_PATH || path.join(process.cwd(), ".data", "deep-current.sqlite"));
  let db = connections.get(filename);
  if (!db) {
    mkdirSync(path.dirname(filename), { recursive: true });
    db = new DatabaseSync(filename);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    connections.set(filename, db);
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    if (result instanceof Promise) throw new Error("Database transactions must not await network work");
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
