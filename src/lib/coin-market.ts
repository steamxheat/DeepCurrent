export type RawMeta = { universe?: { name?: string }[] };
export type RawAssetContext = { dayNtlVlm?: string; markPx?: string; oraclePx?: string; openInterest?: string; funding?: string; prevDayPx?: string };
import { marketNumber } from "./data-freshness.ts";

export function coinMarketNumbers(market: RawAssetContext, spot?: { price: number; change: number; volume: number }) {
  const markPx = marketNumber(market.markPx ?? spot?.price), previous = marketNumber(market.prevDayPx);
  return { markPx, oraclePx: marketNumber(market.oraclePx),
    change24h: spot?.change ?? (previous > 0 && markPx > 0 ? (markPx - previous) / previous * 100 : NaN),
    volume24h: marketNumber(market.dayNtlVlm ?? spot?.volume), openInterest: marketNumber(market.openInterest), funding: marketNumber(market.funding) };
}
type Info = <T>(body: Record<string, unknown>, revalidate: number) => Promise<T>;

export async function findCoinMarket(coin: string, info: Info) {
  const raw = coin.split(":").at(-1)!;
  async function read(dex: string) {
    const [meta, contexts] = await info<[RawMeta, RawAssetContext[]]>({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) }, 15);
    const index = (meta.universe ?? []).findIndex((asset) => asset.name === coin || (!coin.includes(":") && asset.name?.split(":").at(-1) === raw));
    return index < 0 ? null : { name: meta.universe![index].name!, dex, market: contexts[index] ?? {} };
  }
  // Explicit DEX assets must not resolve to a similarly named main-market asset.
  if (coin.includes(":")) return read(coin.slice(0, coin.indexOf(":"))).catch(() => null);
  const main = await read("").catch(() => null);
  if (main) return main;
  const dexes = await info<Array<{ name?: string } | null>>({ type: "perpDexs" }, 300).catch(() => []);
  const results = await Promise.all(dexes.flatMap((dex) => dex?.name ? [read(dex.name).catch(() => null)] : []));
  return results.find(Boolean) ?? null;
}

export function coinCandleRequest(coin: string, now: number) {
  // Match the 15-second cache lifetime instead of creating a new POST cache key every millisecond.
  const endTime = Math.floor(now / 15000) * 15000;
  return { type: "candleSnapshot", req: { coin, interval: "15m", startTime: endTime - 7 * 86400000, endTime } };
}
