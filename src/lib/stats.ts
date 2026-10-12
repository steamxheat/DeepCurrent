export type Fill = {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B";
  time: number;
  dir: string;
  closedPnl: string;
  fee: string;
  hash: string;
  tid?: number;
  startPosition?: string;
  wallet?: string;
};

export type ClosedTrade = {
  coin: string;
  direction: "LONG" | "SHORT";
  openedAt: number | null;
  closedAt: number;
  entryPx: number | null;
  exitPx: number;
  size: number;
  netPnl: number;
};

const fillKey = (fill: Fill) => fill.tid === undefined
  ? `${fill.hash}:${fill.coin}:${fill.time}:${fill.side}:${fill.px}:${fill.sz}`
  : `${fill.time}:${fill.coin}:${fill.tid}`;

export function mergeFills(...groups: Fill[][]) {
  return [...new Map(groups.flat().map((fill) => [fillKey(fill), fill])).values()]
    .sort((a, b) => b.time - a.time).slice(0, 10_000);
}

export function netClosedPnl(fill: Pick<Fill, "closedPnl" | "fee">) {
  return Number(fill.closedPnl || 0) + Number(fill.fee || 0);
}

export function computeFillStats(fills: Fill[]) {
  const closed = fills.filter((fill) => Number(fill.closedPnl) !== 0);
  const nets = closed.map(netClosedPnl);
  const profit = nets.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const loss = Math.abs(nets.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const wins = nets.filter((value) => value > 0).length;
  return {
    closed: closed.length,
    wins,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    profitFactor: loss ? profit / loss : profit ? Infinity : 0,
    netPnl: nets.reduce((sum, value) => sum + value, 0),
  };
}

export function positionOpenedAt(currentSize: number, coin: string, fills: Fill[]) {
  let size = currentSize;
  for (const fill of fills.filter((item) => item.coin === coin).sort((a, b) => b.time - a.time)) {
    const before = size - Number(fill.sz) * (fill.side === "B" ? 1 : -1);
    const tolerance = Math.max(1, Math.abs(size), Math.abs(before)) * 1e-9;
    if (Math.abs(before) <= tolerance || Math.sign(before) !== Math.sign(size)) return fill.time;
    size = before;
  }
  return null;
}

export function closedTrades(fills: Fill[]) {
  type State = { direction: "LONG" | "SHORT"; openedAt: number | null; entrySize: number; entryNotional: number; exitSize: number; exitNotional: number; netPnl: number };
  const states = new Map<string, State>();
  const trades: ClosedTrade[] = [];
  const tolerance = 1e-9;
  for (const fill of [...fills].sort((a, b) => a.time - b.time)) {
    const quantity = Math.abs(Number(fill.sz)); const price = Number(fill.px);
    if (!quantity || !Number.isFinite(price)) continue;
    const delta = quantity * (fill.side === "B" ? 1 : -1);
    const explicitBefore = Number(fill.startPosition);
    const prior = states.get(fill.coin);
    const before = Number.isFinite(explicitBefore) ? explicitBefore : (prior?.direction === "LONG" ? prior.entrySize - prior.exitSize : -(prior?.entrySize ?? 0) + (prior?.exitSize ?? 0));
    const after = Math.abs(before + delta) <= tolerance ? 0 : before + delta;
    const beforeDirection = before >= 0 ? "LONG" as const : "SHORT" as const;
    let state = prior;
    if (!state || Math.abs(before) <= tolerance || state.direction !== beforeDirection) {
      state = { direction: after < 0 ? "SHORT" : beforeDirection, openedAt: Math.abs(before) <= tolerance ? fill.time : null, entrySize: Math.abs(before), entryNotional: 0, exitSize: 0, exitNotional: 0, netPnl: 0 };
      states.set(fill.coin, state);
    }
    const increases = after !== 0 && (before === 0 || Math.sign(after) === Math.sign(before)) && Math.abs(after) > Math.abs(before);
    const closedSize = before !== 0 && (after === 0 || Math.sign(after) !== Math.sign(before)) ? Math.abs(before) : Math.max(0, Math.abs(before) - Math.abs(after));
    if (increases) {
      const added = Math.abs(after) - Math.abs(before);
      state.entrySize += added; state.entryNotional += added * price; state.netPnl += Number(fill.fee || 0);
    }
    if (closedSize) {
      state.exitSize += closedSize; state.exitNotional += closedSize * price; state.netPnl += Number(fill.closedPnl || 0) + Number(fill.fee || 0);
    }
    if (after === 0 || (before !== 0 && Math.sign(after) !== Math.sign(before))) {
      trades.push({ coin: fill.coin, direction: beforeDirection, openedAt: state.openedAt, closedAt: fill.time, entryPx: state.entryNotional && state.entrySize ? state.entryNotional / state.entrySize : null, exitPx: state.exitNotional / Math.max(state.exitSize, tolerance), size: state.exitSize, netPnl: state.netPnl });
      states.delete(fill.coin);
      if (after !== 0) states.set(fill.coin, { direction: after > 0 ? "LONG" : "SHORT", openedAt: fill.time, entrySize: Math.abs(after), entryNotional: Math.abs(after) * price, exitSize: 0, exitNotional: 0, netPnl: 0 });
    }
  }
  return trades.sort((a, b) => b.closedAt - a.closedAt);
}

export function findConfluences(fills: Fill[], now = Date.now(), windowMs = 30 * 60 * 1000) {
  const groups = new Map<string, { coin: string; direction: "LONG" | "SHORT"; wallets: Set<string>; latest: number }>();
  for (const fill of fills) {
    if (!fill.wallet || now - fill.time > windowMs || !fill.dir.toLowerCase().includes("open")) continue;
    const direction = fill.dir.toLowerCase().includes("short") ? "SHORT" : "LONG";
    const key = `${fill.coin}:${direction}`;
    const group = groups.get(key) ?? { coin: fill.coin, direction, wallets: new Set<string>(), latest: 0 };
    group.wallets.add(fill.wallet);
    group.latest = Math.max(group.latest, fill.time);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.wallets.size >= 2)
    .map((group) => ({ ...group, wallets: [...group.wallets] }))
    .sort((a, b) => b.wallets.length - a.wallets.length || b.latest - a.latest);
}
