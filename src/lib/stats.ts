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
  wallet?: string;
};

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
