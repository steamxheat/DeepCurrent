import type { PulseFill } from "./hyperliquid";
import { fillTransition } from "./position-reducer.ts";

export type MarketTrade = {
  coin: string;
  px: string;
  sz: string;
  time: number;
  hash?: string;
  tid?: number;
  users?: [string, string];
};

export type SpotMeta = {
  tokens?: { index: number; name?: string }[];
  universe?: { index: number; name?: string; tokens?: number[] }[];
};

export function spotCoinNames(meta: SpotMeta) {
  const tokens = new Map((meta.tokens ?? []).map((token) => [token.index, token.name ?? `Token ${token.index}`]));
  return Object.fromEntries((meta.universe ?? []).map((pair) => {
    const [base, quote] = pair.tokens ?? [];
    const readable = base === undefined ? pair.name ?? `@${pair.index}` : `${tokens.get(base) ?? `Token ${base}`}/${tokens.get(quote) ?? `Token ${quote}`}`;
    return [`@${pair.index}`, readable];
  }));
}

export function displayCoin(coin: string, names: Record<string, string>) {
  return names[coin] ?? coin;
}

export function marketIdentity(coin: string) {
  if (coin.startsWith("#")) return { symbol: coin, venue: "Outcome market", type: "SPOT" as const };
  if (coin.includes("/")) {
    const [symbol, quote = "USDC"] = coin.split("/");
    return { symbol, venue: `${quote} spot`, type: "SPOT" as const };
  }
  if (coin.includes(":")) {
    const [dex, symbol] = coin.split(":", 2);
    return { symbol, venue: `${dex.toUpperCase()} perpetual`, type: "PERP" as const };
  }
  return { symbol: coin, venue: "Hyperliquid perpetual", type: "PERP" as const };
}

export function tradeFills(trades: MarketTrade[], wallets: Map<string, string>, coinNames: Record<string, string>) {
  return trades.flatMap((trade): PulseFill[] => (trade.users ?? []).flatMap((user, index) => {
    const wallet = user.toLowerCase();
    const walletName = wallets.get(wallet);
    if (!walletName) return [];
    return [{
      coin: displayCoin(trade.coin, coinNames), px: trade.px, sz: trade.sz,
      side: index === 0 ? "B" : "A", time: trade.time,
      dir: index === 0 ? "Buy" : "Sell", closedPnl: "0", fee: "0",
      hash: trade.hash ?? String(trade.tid ?? `${trade.coin}:${trade.time}`),
      tid: trade.tid,
      wallet, walletName, source: "market",
    }];
  }));
}

export function mergePulseFills(current: PulseFill[], incoming: PulseFill[]) {
  const rows = new Map<string, PulseFill>();
  for (const fill of [...current, ...incoming]) {
    const key = fill.tid === undefined ? `${fill.wallet}:${fill.hash}:${fill.time}:${fill.coin}:${fill.px}:${fill.sz}` : `${fill.wallet.toLowerCase()}:${fill.coin}:${fill.time}:${fill.tid}`;
    const previous = rows.get(key);
    if (!previous || previous.source === "market" || fill.source !== "market" || fill.positionStatus !== undefined) rows.set(key, fill);
  }
  const sorted = [...rows.values()].sort((a, b) => b.time - a.time);
  const exactCounts = new Map<string, number>();
  const exact = sorted.filter((fill) => {
    if (fill.source === "market") return false;
    const count = exactCounts.get(fill.wallet) ?? 0;
    if (count >= 120) return false;
    exactCounts.set(fill.wallet, count + 1); return true;
  }).slice(0, 1_200);
  const market = sorted.filter((fill) => fill.source === "market").slice(0, 800);
  return [...exact, ...market].sort((a, b) => b.time - a.time);
}

export function activityKind(fill: Pick<PulseFill, "dir" | "side" | "source" | "startPosition" | "sz" | "action" | "direction">) {
  if (fill.source === "market") return { label: fill.side === "B" ? "BUY" : "SELL", direction: fill.side === "B" ? "BUY" as const : "SELL" as const, exact: false, kind: fill.side === "B" ? "gain" as const : "loss" as const };
  if (fill.action && fill.direction && fill.startPosition !== undefined) return { label: fill.action, direction: fill.direction, exact: !["BUY", "SELL"].includes(fill.action), kind: ["REDUCE", "CLOSE"].includes(fill.action) ? "neutral" as const : fill.direction === "LONG" || fill.direction === "BUY" ? "gain" as const : "loss" as const };
  const direction = fill.dir.toLowerCase();
  if (fill.startPosition !== undefined) {
    const change = fillTransition({ ...fill, coin: direction.includes("buy") || direction.includes("sell") ? "@spot" : "perp", time: 0 });
    if (change) return { label: change.action, direction: change.direction, exact: true, kind: ["REDUCE", "CLOSE"].includes(change.action) ? "neutral" as const : change.direction === "LONG" ? "gain" as const : "loss" as const };
  }
  if (direction.includes("close") || direction.includes("reduce")) return { label: direction.includes("close") ? "CLOSE" : "REDUCE", direction: direction.includes("short") ? "SHORT" as const : "LONG" as const, exact: false, kind: "neutral" as const };
  if (direction.includes("buy")) return { label: "BUY", direction: "BUY" as const, exact: false, kind: "gain" as const };
  if (direction.includes("sell")) return { label: "SELL", direction: "SELL" as const, exact: false, kind: "loss" as const };
  return { label: fill.side === "B" ? "BUY" : "SELL", direction: fill.side === "B" ? "BUY" as const : "SELL" as const, exact: false, kind: fill.side === "B" ? "gain" as const : "loss" as const };
}
