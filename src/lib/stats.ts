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
  crossed?: boolean;
  feeToken?: string;
  wallet?: string;
  walletName?: string;
  source?: "user" | "market";
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

export function mergeFillHistoryPage(current: Fill[], page: Fill[]) {
  const previousOldest = current.length ? Math.min(...current.map((fill) => fill.time)) : Infinity;
  const fills = mergeFills(current, page);
  const oldest = fills.length ? Math.min(...fills.map((fill) => fill.time)) : Infinity;
  return { fills, complete: page.length < 2_000, progressed: oldest < previousOldest, oldest };
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

export type ConfluenceWalletContext = Record<string, { quality?: number; copyability?: number; accountValue?: number }>;

function relatedWallets(fills: Fill[]) {
  const signatures = new Map<string, Set<string>>();
  for (const fill of fills) {
    if (!fill.wallet || fill.source === "market") continue;
    const direction = fill.side === "B" ? "B" : "S";
    const signature = `${fill.coin}:${direction}:${Math.floor(fill.time / 30_000)}`;
    const wallet = fill.wallet.toLowerCase(); const set = signatures.get(wallet) ?? new Set<string>(); set.add(signature); signatures.set(wallet, set);
  }
  const parent = new Map([...signatures.keys()].map((wallet) => [wallet, wallet]));
  const root = (wallet: string): string => { const next = parent.get(wallet) ?? wallet; if (next === wallet) return wallet; const resolved = root(next); parent.set(wallet, resolved); return resolved; };
  const wallets = [...signatures.keys()];
  for (let index = 0; index < wallets.length; index++) for (let other = index + 1; other < wallets.length; other++) {
    const left = signatures.get(wallets[index])!; const right = signatures.get(wallets[other])!;
    const overlap = [...left].filter((value) => right.has(value)).length;
    if (overlap >= 3 && overlap / Math.min(left.size, right.size) >= .7) parent.set(root(wallets[other]), root(wallets[index]));
  }
  return new Map(wallets.map((wallet) => [wallet, root(wallet)]));
}

export function findConfluences(fills: Fill[], now = Date.now(), windowMs = 30 * 60 * 1000, context: ConfluenceWalletContext = {}) {
  type Entry = { wallet: string; walletName?: string; time: number; notional: number; coin: string; direction: "LONG" | "SHORT"; quality: number; copyability: number | null; positionChangePct: number | null; cluster: string };
  const clusters = relatedWallets(fills);
  const latestByWallet = new Map<string, Entry>();
  for (const fill of [...fills].sort((a, b) => a.time - b.time)) {
    if (!fill.wallet || fill.source === "market" || fill.time > now || now - fill.time > windowMs) continue;
    const key = `${fill.coin}:${fill.wallet.toLowerCase()}`;
    const before = Number(fill.startPosition);
    const after = before + Number(fill.sz) * (fill.side === "B" ? 1 : -1);
    const label = fill.dir.toLowerCase();
    if ((Number.isFinite(before) && Math.abs(after) < 1e-9) || (!Number.isFinite(before) && label.includes("close"))) {
      latestByWallet.delete(key); continue;
    }
    const direction = Number.isFinite(before)
      ? (Math.abs(before) < 1e-9 || Math.sign(before) !== Math.sign(after)) && Math.abs(after) >= 1e-9 ? (after > 0 ? "LONG" : "SHORT") : null
      : label.includes("open long") || label.includes("short > long") ? "LONG"
        : label.includes("open short") || label.includes("long > short") ? "SHORT" : null;
    if (!direction) continue;
    latestByWallet.set(key, {
      wallet: fill.wallet.toLowerCase(), walletName: fill.walletName, time: fill.time,
      notional: Math.abs(Number(fill.px) * Number(fill.sz)), coin: fill.coin, direction,
      quality: context[fill.wallet.toLowerCase()]?.quality ?? 50,
      copyability: context[fill.wallet.toLowerCase()]?.copyability ?? null,
      positionChangePct: Number.isFinite(before) && before !== 0 ? Math.abs(after - before) / Math.abs(before) * 100 : null,
      cluster: clusters.get(fill.wallet.toLowerCase()) ?? fill.wallet.toLowerCase(),
    });
  }
  const groups = new Map<string, { coin: string; direction: "LONG" | "SHORT"; entries: Entry[] }>();
  for (const entry of latestByWallet.values()) {
    const key = `${entry.coin}:${entry.direction}`;
    const group = groups.get(key) ?? { coin: entry.coin, direction: entry.direction, entries: [] };
    group.entries.push(entry); groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const byCluster = new Map<string, Entry>();
    for (const entry of group.entries) { const current = byCluster.get(entry.cluster); if (!current || entry.quality > current.quality || entry.time > current.time) byCluster.set(entry.cluster, entry); }
    const entries = [...byCluster.values()].sort((a, b) => b.time - a.time);
    const latest = entries[0].time; const earliest = entries.at(-1)?.time ?? latest;
    const averageQuality = entries.reduce((sum, entry) => sum + entry.quality, 0) / entries.length;
    const totalNotional = entries.reduce((sum, entry) => sum + entry.notional, 0);
    const timing = Math.max(0, 1 - (latest - earliest) / Math.max(1, windowMs));
    const score = Math.round(Math.min(100, 18 + entries.length * 13 + averageQuality * .35 + Math.log10(1 + totalNotional) * 2 + timing * 10));
    return { ...group, entries, wallets: entries.map((entry) => entry.wallet), relatedWallets: group.entries.length - entries.length,
      independentWallets: entries.length, averageQuality, score, stillOpen: true, latest, earliest, spanMs: latest - earliest, totalNotional };
  }).filter((group) => group.independentWallets >= 2).sort((a, b) => b.score - a.score || b.latest - a.latest);
}
