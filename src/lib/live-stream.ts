import { getFillJournal } from "./fill-journal.ts";
import { encodeLiveFills } from "./live-wire.ts";

const listeners = new Set<(message: string) => void>();
let timer: ReturnType<typeof setInterval> | undefined; let sequence = -1; let lastStatus = 0;
let snapshot = ""; let lastEvidence = 0;
let snapshotFills: unknown[] = [];
function update(force = false) {
  const store = getFillJournal(); const revision = store.revision(); const now = Date.now();
  const collector = store.status("collector"); const catalog = store.status("catalog")?.payload;
  const priceState = store.status("mids")?.payload; const prices = priceState?.prices ?? {};
  const displayPrices = Object.fromEntries(["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"].map((coin) => [coin, Number(prices[coin] ?? 0)]));
  const healthy = Boolean(collector && now - collector.updatedAt < 5000 && collector.payload.connected && collector.payload.acknowledgedMarkets > 0
    && collector.payload.acknowledgedMarkets === collector.payload.marketCount && now - collector.payload.lastReceive < 60_000);
  const reset = force || sequence < 0; const changed = revision !== sequence;
  const delta = changed && !reset ? store.eventsSince(sequence, now - 60_000, 101) : [];
  // The ticker is bounded; the complete, filterable history lives in /api/events.
  const full = reset || delta.length > 100;
  const refreshEvidence = now - lastEvidence >= 10_000;
  const names = new Map<string, string>((store.status("targets")?.payload?.wallets ?? []).map((wallet: { address: string; name: string }) => [wallet.address, wallet.name]));
  const normalize = (row: ReturnType<typeof store.evidence>[number]) => ({ ...row, coin: catalog?.coinNames?.[row.coin] ?? row.coin,
    wallet: row.wallet, walletName: names.get(row.wallet) ?? row.wallet, px: row.px, sz: row.sz, side: row.side, time: row.time, tid: row.tid,
    hash: row.hash, dir: row.dir, fee: row.fee ?? "0", feeToken: row.feeToken, closedPnl: row.closedPnl ?? "0", precision: row.precision,
    startPosition: row.precision === "exact" ? row.startPosition : undefined, source: row.precision === "exact" ? "user" : "market" });
  if (full || changed || now - lastStatus >= 1000) {
    const message = JSON.stringify({ rows: encodeLiveFills(store.evidence(full || refreshEvidence ? store.events(now - 86_400_000, 50) : delta).map(normalize)), reset: full,
      prices: displayPrices,
      healthy, collectorAt: collector?.updatedAt ?? 0, pricesAt: priceState?.receivedAt ?? 0, serverAt: now, revision });
    for (const listener of listeners) { try { listener(message); } catch { listeners.delete(listener); } }
    lastStatus = now;
    if (full || refreshEvidence) lastEvidence = now;
  }
  if (full || changed || refreshEvidence || !snapshot) snapshotFills = encodeLiveFills(store.evidence(store.events(now - 86_400_000, 50)).map(normalize));
  snapshot = JSON.stringify({ rows: snapshotFills, reset: true, prices: displayPrices, healthy, collectorAt: collector?.updatedAt ?? 0,
    pricesAt: priceState?.receivedAt ?? 0, serverAt: now, revision });
  sequence = revision;
}

export function subscribeLive(listener: (message: string) => void) {
  if (listeners.size >= 1500) throw new Error("Live connection capacity reached");
  if (!timer) update(true);
  listeners.add(listener); listener(snapshot);
  if (!timer) timer = setInterval(() => {
    try { update(); }
    catch { for (const listener of listeners) { try { listener(JSON.stringify({ fills: [], healthy: false, serverAt: Date.now() })); } catch { listeners.delete(listener); } } }
  }, 250);
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; sequence = -1; snapshot = ""; snapshotFills = []; } };
}
