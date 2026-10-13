import type { JournalEvent } from "./event-store.ts";

export type FlowChange = { long: number; short: number; net: number; wallets: number };

export function coinFlowChange(events: JournalEvent[], now: number, duration: number): FlowChange {
  let long = 0; let short = 0; const wallets = new Set<string>();
  for (const event of events) {
    if (event.time > now || now - event.time > duration || !["LONG", "SHORT"].includes(event.direction ?? "")) continue;
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
