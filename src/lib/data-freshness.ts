export function dataFresh(at: unknown, now: number, ttl: number) {
  return typeof at === "number" && Number.isSafeInteger(at) && at > 0 && Number.isFinite(now) && now >= at && now - at < ttl;
}

export function marketNumber(value: unknown) {
  return (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : NaN;
}

export function midsSnapshot(state: { prices?: Record<string, unknown>; receivedAt?: number } | undefined, now: number) {
  const fresh = dataFresh(state?.receivedAt, now, 30_000);
  return { pricesAt: state?.receivedAt ?? 0, prices: Object.fromEntries(["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"].map((coin) => {
    const price = marketNumber(state?.prices?.[coin]);
    return [coin, fresh && price > 0 ? price : NaN];
  })) };
}
