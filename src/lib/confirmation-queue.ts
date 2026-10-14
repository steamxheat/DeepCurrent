import { validWalletAddress } from "./fill-journal.ts";

type Pending = { from: number; latest: number; queuedAt: number; due: number; inFlight: boolean };
export function createConfirmationQueue(onGap: (wallet: string, from: number, through: number, reason: string) => void = () => {}) {
  const pending = new Map<string, Pending>(); let rejected = 0; let expired = 0;
  function enqueue(address: string, time: number, now = Date.now()) {
    const wallet = address.toLowerCase();
    if (!validWalletAddress(wallet) || !Number.isSafeInteger(time) || time < 0 || time > now + 60_000) throw new Error("Invalid confirmation event");
    const previous = pending.get(wallet);
    if (previous) { previous.from = Math.min(previous.from, Math.max(0, time - 1)); previous.latest = Math.max(previous.latest, time); return true; }
    if (pending.size >= 1000) { rejected++; return false; }
    pending.set(wallet, { from: Math.max(0, time - 1), latest: time, queuedAt: now, due: now + 250, inFlight: false }); return true;
  }
  function take(priority: (wallet: string) => number, now = Date.now()) {
    for (const [wallet, entry] of pending) if (!entry.inFlight && entry.latest < now - 60_000) { onGap(wallet, entry.from, entry.latest, "expired"); pending.delete(wallet); expired++; }
    const next = [...pending].filter(([, entry]) => !entry.inFlight && entry.due <= now)
      .sort(([a, left], [b, right]) => priority(a) - priority(b) || left.queuedAt - right.queuedAt)[0];
    if (!next) return null;
    const [wallet, entry] = next; entry.inFlight = true;
    const from = Math.min(now, Math.max(now - 60_000, entry.from));
    if (from > entry.from) { onGap(wallet, entry.from, from - 1, "window_trimmed"); entry.from = from; }
    return { wallet, from, through: now };
  }
  function complete(wallet: string, through: number, confirmed: boolean, now = Date.now()) {
    const entry = pending.get(wallet); if (!entry) return;
    if (confirmed && entry.latest <= through) pending.delete(wallet);
    else {
      entry.inFlight = false; entry.due = now + (confirmed ? 2000 : 5000);
      if (confirmed) { entry.from = Math.max(entry.from, through); entry.queuedAt = now; }
    }
  }
  return { enqueue, take, complete, stats: (now = Date.now()) => ({ pending: pending.size, inFlight: [...pending.values()].filter((entry) => entry.inFlight).length,
    oldestAgeMs: pending.size ? Math.max(0, now - Math.min(...[...pending.values()].map((entry) => entry.queuedAt))) : 0, rejected, expired }) };
}
