import type { PulseFill } from "./hyperliquid";

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
      wallet, walletName, source: "market",
    }];
  }));
}

export function activityKind(fill: Pick<PulseFill, "dir" | "side">) {
  const direction = fill.dir.toLowerCase();
  if (direction.includes("close") || direction.includes("reduce")) return { label: "REDUCE", kind: "neutral" as const };
  if (direction.includes("buy")) return { label: "BUY", kind: "gain" as const };
  if (direction.includes("sell")) return { label: "SELL", kind: "loss" as const };
  if (direction.includes("long") || (fill.side === "B" && !direction.includes("short"))) return { label: "LONG", kind: "gain" as const };
  return { label: "SHORT", kind: "loss" as const };
}
