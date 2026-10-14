import type { JournalEvent, PositionSnapshot } from "./event-store.ts";
import { dataFresh } from "./data-freshness.ts";

export type FlowChange = { long: number; short: number; net: number; wallets: number };
export type CoinParticipant = {
  wallet: string; direction: "LONG" | "SHORT"; notional: number; lastTime: number;
  events: number; kind: "position" | "activity"; walletName?: string; unrealizedPnl?: number;
};

export function baseMarketSymbol(coin: string) {
  const raw = coin.includes(":") ? coin.slice(coin.lastIndexOf(":") + 1) : coin;
  const base = raw.split("/", 1)[0].toUpperCase();
  return raw.includes("/") && ["UBTC", "UETH", "USOL"].includes(base) ? base.slice(1) : base;
}

export function coinFlowChange(events: JournalEvent[], now: number, duration: number): FlowChange {
  let long = 0; let short = 0; const wallets = new Set<string>();
  for (const event of events) {
    if (event.time > now || now - event.time > duration || !["OPEN", "ADD", "REDUCE", "CLOSE", "FLIP"].includes(event.action) || !["LONG", "SHORT"].includes(event.direction ?? "")) continue;
    let longDelta = 0; let shortDelta = 0;
    if (event.beforeSize !== undefined && event.afterSize !== undefined && event.price !== undefined) {
      longDelta = (Math.max(0, event.afterSize) - Math.max(0, event.beforeSize)) * event.price;
      shortDelta = (Math.max(0, -event.afterSize) - Math.max(0, -event.beforeSize)) * event.price;
    } else {
      const change = Math.abs(event.notional ?? 0) * (/^(REDUCE|CLOSE)/.test(event.action) ? -1 : 1);
      if (event.direction === "LONG") longDelta = change; else shortDelta = change;
    }
    long += longDelta; short += shortDelta; wallets.add(event.wallet);
  }
  return { long, short, net: long - short, wallets: wallets.size };
}

export function coinParticipants(events: JournalEvent[], snapshots: PositionSnapshot[], now: number, duration = 86_400_000): CoinParticipant[] {
  const rows = new Map<string, CoinParticipant>();
  for (const snapshot of snapshots) {
    if (snapshot.size === 0 || !dataFresh(snapshot.capturedAt, now, 30_000)) continue;
    const direction = snapshot.size > 0 ? "LONG" : "SHORT";
    rows.set(snapshot.wallet, { wallet: snapshot.wallet, direction, notional: Math.abs(snapshot.positionValue), lastTime: snapshot.capturedAt, events: 0, kind: "position", unrealizedPnl: snapshot.unrealizedPnl });
  }
  for (const event of events) {
    if (event.time > now || now - event.time > duration || !["LONG", "SHORT"].includes(event.direction ?? "") || !["OPEN", "ADD", "FLIP"].includes(event.action)) continue;
    const current = rows.get(event.wallet);
    if (current?.kind === "position") { current.walletName ??= event.walletName; continue; }
    const direction = event.direction as "LONG" | "SHORT";
    const notional = Math.abs(event.notional ?? (event.price ?? 0) * (event.size ?? 0));
    const key = event.wallet;
    if (current && current.direction !== direction && current.lastTime >= event.time) continue;
    if (current && current.direction === direction) {
      current.notional += notional; current.events += 1; current.lastTime = Math.max(current.lastTime, event.time);
    } else rows.set(key, { wallet: event.wallet, walletName: event.walletName, direction, notional, lastTime: event.time, events: 1, kind: "activity" });
  }
  return [...rows.values()].sort((left, right) => Number(right.kind === "position") - Number(left.kind === "position") || right.notional - left.notional);
}
