import type { DatabaseSync } from "node:sqlite";
import { validWalletAddress } from "./fill-journal.ts";

type Job = { wallet: string; from_time: number | null; through_time: number | null; revision: number; due_at: number; queued_at: number; attempts: number; last_error: string | null };
export function createRecoveryQueue(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_jobs(wallet TEXT PRIMARY KEY,from_time INTEGER,through_time INTEGER,revision INTEGER NOT NULL,due_at INTEGER NOT NULL,queued_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT)`);
  const get = (wallet: string) => db.prepare("SELECT * FROM recovery_jobs WHERE wallet=?").get(wallet.toLowerCase()) as Job | undefined;
  const rows = () => db.prepare("SELECT wallet FROM recovery_jobs ORDER BY queued_at,wallet").all() as { wallet: string }[];
  const queue = {
    add(wallet: string, from?: number, through?: number) {
      wallet = wallet.toLowerCase();
      if (!validWalletAddress(wallet) || (from !== undefined && (!Number.isSafeInteger(from) || from < 0)) || (through !== undefined && (!Number.isSafeInteger(through) || through < (from ?? 0)))) throw new Error("Invalid recovery job");
      db.prepare(`INSERT INTO recovery_jobs(wallet,from_time,through_time,revision,due_at,queued_at) VALUES(?,?,?,1,0,?) ON CONFLICT(wallet) DO UPDATE SET
        from_time=CASE WHEN excluded.from_time IS NULL THEN recovery_jobs.from_time WHEN recovery_jobs.from_time IS NULL THEN excluded.from_time ELSE MIN(recovery_jobs.from_time,excluded.from_time) END,
        through_time=CASE WHEN excluded.through_time IS NULL THEN recovery_jobs.through_time WHEN recovery_jobs.through_time IS NULL THEN excluded.through_time ELSE MAX(recovery_jobs.through_time,excluded.through_time) END,
        revision=recovery_jobs.revision+1 WHERE
        (excluded.from_time IS NOT NULL AND (recovery_jobs.from_time IS NULL OR excluded.from_time<recovery_jobs.from_time)) OR
        (excluded.through_time IS NOT NULL AND (recovery_jobs.through_time IS NULL OR excluded.through_time>recovery_jobs.through_time))`).run(wallet.toLowerCase(), from ?? null, through ?? null, Date.now()); return queue;
    },
    get,
    has: (wallet: string) => Boolean(get(wallet)),
    seedMissing(wallets: Iterable<string>, hasCoverage: (wallet: string) => boolean): number {
      let added=0;
      for(const wallet of wallets) if(!hasCoverage(wallet) && !queue.has(wallet)) { queue.add(wallet); added++; }
      return added;
    },
    complete: (wallet: string, revision: number) => db.prepare("DELETE FROM recovery_jobs WHERE wallet=? AND revision=?").run(wallet.toLowerCase(), revision).changes > 0,
    defer: (wallet: string, delayMs: number, error: string | null = null) => {
      if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error("Invalid recovery delay");
      db.prepare("UPDATE recovery_jobs SET due_at=?,attempts=attempts+1,last_error=? WHERE wallet=?").run(Date.now() + delayMs, error?.slice(0, 2000) ?? null, wallet.toLowerCase());
    },
    get size() { return (db.prepare("SELECT COUNT(*) n FROM recovery_jobs").get() as { n: number }).n; },
    [Symbol.iterator]: function* () { for (const row of rows()) yield row.wallet; },
  };
  return queue;
}
