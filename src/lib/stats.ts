import { decimalEqual, fillTransition, orderFillChain, validDecimal } from "./position-reducer.ts";
import { dataFresh } from "./data-freshness.ts";

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
  oid?: number;
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

export function feeInUsd(fill: Pick<Fill, "fee" | "feeToken">) {
  return fill.feeToken && fill.feeToken.trim() !== "USDC" && Number(fill.fee) !== 0 ? NaN : Number(fill.fee || 0);
}

export function netClosedPnl(fill: Pick<Fill, "closedPnl" | "fee" | "feeToken">) {
  return Number(fill.closedPnl || 0) - feeInUsd(fill);
}

export function isClosingFill(fill: Fill) {
  const action = fillTransition(fill)?.action;
  return action ? ["REDUCE", "CLOSE", "FLIP"].includes(action) : Number(fill.closedPnl) !== 0 || /^(close|reduce)\b/i.test(fill.dir);
}

export function computeFillStats(fills: Fill[]) {
  const closed = fills.filter((fill) => !fill.coin.startsWith("@") && !fill.coin.startsWith("#") && !fill.coin.includes("/") && isClosingFill(fill) && Number.isFinite(netClosedPnl(fill)));
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
  if (!Number.isFinite(currentSize) || currentSize === 0 || !validDecimal(String(currentSize))) return null;
  const { state } = orderFillChain(fills.filter((fill) => fill.coin === coin));
  return state && state.reason === null && decimalEqual(state.size, String(currentSize)) ? state.openedAt : null;
}

export function closedTrades(fills: Fill[]) {
  type State = { direction: "LONG" | "SHORT"; size: string; openedAt: number | null; entrySize: number; entryNotional: number; exitSize: number; exitNotional: number; netPnl: number; basisKnown: boolean };
  const states = new Map<string, State>();
  const trades: ClosedTrade[] = [];
  const chains = [...new Set(fills.map((fill) => fill.coin))].map((coin) => ({ coin, ...orderFillChain(fills.filter((fill) => fill.coin === coin)) }));
  const ambiguous = new Set(chains.flatMap((chain) => [...chain.ambiguousTimes].map((time) => `${chain.coin}:${time}`)));
  const ordered = chains.flatMap((chain) => chain.fills);
  for (const fill of ordered) {
    if (ambiguous.has(`${fill.coin}:${fill.time}`)) { states.delete(fill.coin); continue; }
    if (fill.coin.startsWith("@") || fill.coin.startsWith("#") || fill.coin.includes("/")) continue;
    const change = fillTransition(fill);
    if (!change) { states.delete(fill.coin); continue; }
    const quantity = Math.abs(Number(fill.sz)); const price = Number(fill.px);
    if (!quantity || !Number.isFinite(price)) continue;
    const prior = states.get(fill.coin);
    const before = Number(change.before); const after = Number(change.after);
    const beforeDirection = before >= 0 ? "LONG" as const : "SHORT" as const;
    let state = prior;
    if (!state || before === 0 || state.direction !== beforeDirection || !decimalEqual(state.size, change.before)) {
      state = { direction: before === 0 ? after > 0 ? "LONG" : "SHORT" : beforeDirection, size: change.before, openedAt: before === 0 ? fill.time : null, entrySize: Math.abs(before), entryNotional: 0, exitSize: 0, exitNotional: 0, netPnl: 0, basisKnown: before === 0 };
      states.set(fill.coin, state);
    }
    const increases = change.action === "OPEN" || change.action === "ADD";
    const closedSize = change.action === "CLOSE" || change.action === "FLIP" ? Math.abs(before) : change.action === "REDUCE" ? quantity : 0;
    if (increases) {
      const added = quantity;
      state.entrySize += added; state.entryNotional += added * price; state.netPnl -= feeInUsd(fill);
    }
    if (closedSize) {
      const closedFee = feeInUsd(fill) * closedSize / quantity;
      state.exitSize += closedSize; state.exitNotional += closedSize * price; state.netPnl += Number(fill.closedPnl || 0) - closedFee;
    }
    state.size = change.after;
    if (after === 0 || (before !== 0 && Math.sign(after) !== Math.sign(before))) {
      trades.push({ coin: fill.coin, direction: beforeDirection, openedAt: state.openedAt, closedAt: fill.time, entryPx: state.basisKnown && state.entrySize ? state.entryNotional / state.entrySize : null, exitPx: state.exitNotional / state.exitSize, size: state.exitSize, netPnl: state.netPnl });
      states.delete(fill.coin);
      if (after !== 0) states.set(fill.coin, { direction: after > 0 ? "LONG" : "SHORT", size: change.after, openedAt: fill.time, entrySize: Math.abs(after), entryNotional: Math.abs(after) * price, exitSize: 0, exitNotional: 0, netPnl: -feeInUsd(fill) * Math.abs(after) / quantity, basisKnown: true });
    }
  }
  return trades.sort((a, b) => b.closedAt - a.closedAt);
}

export type ConfluenceWalletContext = Record<string, { quality?: number; copyability?: number; accountValue?: number; cluster?: string }>;

function relatedWallets(fills: Fill[], context: ConfluenceWalletContext) {
  const signatures = new Map<string, Set<string>>();
  for (const fill of fills) {
    if (!fill.wallet || fill.source === "market" || !Number.isSafeInteger(fill.time)) continue;
    const direction = fill.side === "B" ? "B" : "S";
    const signature = `${fill.coin}:${direction}:${Math.floor(fill.time / 30_000)}`;
    const wallet = fill.wallet.toLowerCase(); const set = signatures.get(wallet) ?? new Set<string>(); set.add(signature); signatures.set(wallet, set);
  }
  const parent = new Map([...signatures.keys()].map((wallet) => [wallet, wallet]));
  const root = (wallet: string): string => { const next = parent.get(wallet) ?? wallet; if (next === wallet) return wallet; const resolved = root(next); parent.set(wallet, resolved); return resolved; };
  const wallets = [...signatures.keys()];
  const owners = new Map<string, string>();
  for (const wallet of wallets) {
    const owner = context[wallet]?.cluster; if (!owner) continue;
    const previous = owners.get(owner); if (previous) parent.set(root(wallet), root(previous)); else owners.set(owner, wallet);
  }
  for (let index = 0; index < wallets.length; index++) for (let other = index + 1; other < wallets.length; other++) {
    const left = signatures.get(wallets[index])!; const right = signatures.get(wallets[other])!;
    const overlap = [...left].filter((value) => right.has(value)).length;
    if (overlap >= 3 && overlap / Math.min(left.size, right.size) >= .7) parent.set(root(wallets[other]), root(wallets[index]));
  }
  return new Map(wallets.map((wallet) => [wallet, root(wallet)]));
}

export function findConfluences(fills: Fill[], now = Date.now(), windowMs = 30 * 60 * 1000, context: ConfluenceWalletContext = {}, options: { minWallets?: number; minQuality?: number; minCopyability?: number; onlyOpen?: boolean } = {}) {
  type Entry = { wallet: string; walletName?: string; time: number; notional: number; coin: string; direction: "LONG" | "SHORT"; quality: number | null; copyability: number | null; positionChangePct: number | null; cluster: string; price: number; size: number; stillOpen: boolean | null; closedAt?: number };
  const latestByWallet = new Map<string, Entry>();
  const byPosition = new Map<string, Fill[]>();
  for (const fill of fills) if (fill.wallet && fill.source !== "market" && Number.isSafeInteger(fill.time) && fill.time <= now && now - fill.time <= windowMs) {
    const key = `${fill.wallet.toLowerCase()}:${fill.coin}`;
    const rows = byPosition.get(key) ?? []; rows.push(fill); byPosition.set(key, rows);
  }
  const ordered = [...byPosition.values()].flatMap(rows => {
    const chain = orderFillChain([...new Map(rows.map(fill => [fillKey(fill),fill])).values()]);
    return chain.fills.filter(fill => !chain.ambiguousTimes.has(fill.time));
  });
  const clusters = relatedWallets(ordered, context);
  for (const fill of ordered) {
    if (!fill.wallet || fill.source === "market" || fill.time > now || now - fill.time > windowMs) continue;
    const key = `${fill.coin}:${fill.wallet.toLowerCase()}`;
    const change = fillTransition(fill);
    if (!change || ["BUY", "SELL"].includes(change.action)) continue;
    if (change.action === "CLOSE") {
      latestByWallet.delete(key); continue;
    }
    const before = Number(change.before); const after = Number(change.after);
    const direction = ["OPEN", "FLIP", "ADD"].includes(change.action) ? change.direction as "LONG" | "SHORT" : null;
    if (!direction) continue;
    const existing = latestByWallet.get(key);
    const evidence = fill as Fill & { positionStatus?: string; closedAt?: number; checkedAt?: number; precision?: string };
    if (evidence.precision !== undefined && evidence.precision !== "exact") continue;
    const quality = context[fill.wallet.toLowerCase()]?.quality;
    const copyability = context[fill.wallet.toLowerCase()]?.copyability;
    if ((options.minQuality ?? 0) > 0 && (!Number.isFinite(quality) || quality! < options.minQuality!) || (options.minCopyability ?? 0) > 0 && (!Number.isFinite(copyability) || copyability! < options.minCopyability!)) continue;
    const fresh = dataFresh(evidence.checkedAt, now, 30_000);
    const stillOpen = evidence.positionStatus === "open" && fresh ? true : evidence.positionStatus === "closed" || evidence.positionStatus === "absent" && fresh ? false : null;
    if (change.action === "ADD" && existing) { existing.stillOpen = stillOpen; existing.closedAt = evidence.closedAt; continue; }
    latestByWallet.set(key, {
      wallet: fill.wallet.toLowerCase(), walletName: fill.walletName, time: fill.time,
      notional: Math.abs(Number(fill.px) * (change.action === "FLIP" ? after : Number(fill.sz))), coin: fill.coin, direction,
      quality: Number.isFinite(quality) ? quality! : null,
      copyability: Number.isFinite(copyability) ? copyability! : null,
      positionChangePct: Number.isFinite(before) && before !== 0 ? Math.abs(after - before) / Math.abs(before) * 100 : null,
      cluster: clusters.get(fill.wallet.toLowerCase()) ?? fill.wallet.toLowerCase(),
      price: Number(fill.px), size: Math.abs(["OPEN", "FLIP"].includes(change.action) ? after : after - before), stillOpen, closedAt: evidence.closedAt,
    });
  }
  const groups = new Map<string, { coin: string; direction: "LONG" | "SHORT"; entries: Entry[] }>();
  for (const entry of latestByWallet.values()) {
    if (options.onlyOpen && entry.stillOpen !== true) continue;
    const key = `${entry.coin}:${entry.direction}`;
    const group = groups.get(key) ?? { coin: entry.coin, direction: entry.direction, entries: [] };
    group.entries.push(entry); groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const byCluster = new Map<string, Entry>();
    for (const entry of group.entries) { const current = byCluster.get(entry.cluster); if (!current || (entry.quality ?? 0) > (current.quality ?? 0) || entry.quality === current.quality && entry.time > current.time) byCluster.set(entry.cluster, entry); }
    const entries = [...byCluster.values()].sort((a, b) => b.time - a.time);
    const latest = Math.max(...group.entries.map(entry => entry.time)); const earliest = Math.min(...group.entries.map(entry => entry.time));
    const knownQuality = entries.flatMap((entry) => entry.quality === null ? [] : [entry.quality]);
    const averageQuality = knownQuality.length ? knownQuality.reduce((sum, quality) => sum + quality, 0) / knownQuality.length : null;
    const totalNotional = entries.reduce((sum, entry) => sum + entry.notional, 0);
    const timing = Math.max(0, 1 - (latest - earliest) / Math.max(1, windowMs));
    const score = Math.round(Math.min(100, 18 + entries.length * 13 + (averageQuality ?? 50) * .35 + Math.log10(1 + totalNotional) * 2 + timing * 10));
    return { ...group, entries, wallets: entries.map((entry) => entry.wallet), relatedWallets: group.entries.length - entries.length,
      allEntries: group.entries, independentWallets: entries.length, averageQuality, score, stillOpen: entries.every((entry) => entry.stillOpen === true) ? true : entries.some((entry) => entry.stillOpen === false) ? false : null,
      latest, earliest, spanMs: latest - earliest, totalNotional };
  }).filter((group) => group.independentWallets >= Math.max(2, options.minWallets ?? 2)).sort((a, b) => b.score - a.score || b.latest - a.latest);
}
