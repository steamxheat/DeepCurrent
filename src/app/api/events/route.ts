import { getFillJournal, validWalletAddress } from "@/lib/fill-journal";
import { publicJson } from "@/lib/public-json";

const cache = new Map<string, { expires: number; payload: object }>();

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const wallet = params.get("wallet") ?? undefined; const coin = params.get("coin") ?? undefined;
  const action = params.get("action") ?? undefined; const order = params.get("order") ?? "newest";
  const direction = params.get("direction") ?? undefined; const precision = params.get("precision") ?? undefined;
  const query = params.get("query") ?? undefined; const minNotional = Number(params.get("minNotional") ?? 0);
  const favorites = params.has("wallets") ? params.get("wallets")!.split(",").filter(Boolean) : undefined;
  const actions = params.has("actions") ? params.get("actions")!.split(",") : undefined;
  const number = (name: string, fallback: number) => params.has(name) ? Number(params.get(name)) : fallback;
  const from = number("from", 0); const to = number("to", Date.now()); const offset = number("offset", 0); const limit = number("limit", 50);
  if (wallet && !validWalletAddress(wallet) || coin && coin.length > 128 || action && !["OPEN", "ADD", "REDUCE", "CLOSE", "FLIP", "BUY", "SELL"].includes(action)
    || direction && !["LONG", "SHORT", "BUY", "SELL"].includes(direction) || precision && !["exact", "observed"].includes(precision)
    || query && query.length > 128 || !Number.isFinite(minNotional) || minNotional < 0 || favorites && (favorites.length > 500 || favorites.some((wallet) => !validWalletAddress(wallet)))
    || actions && (actions.length > 7 || actions.some((action) => !["OPEN", "ADD", "REDUCE", "CLOSE", "FLIP", "BUY", "SELL"].includes(action)))
    || !["newest", "oldest", "largest", "price", "price-asc"].includes(order) || ![from, to, offset, limit].every(Number.isSafeInteger)
    || from < 0 || to < from || offset < 0 || offset > 100_000 || limit < 1 || limit > 100) return Response.json({ error: "INVALID_QUERY" }, { status: 400 });
  const key = params.toString(); const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return publicJson(request, previous.payload);
  const store = getFillJournal();
  const names = new Map<string, string>((store.status("targets")?.payload.wallets ?? []).map((row: { address: string; name: string }) => [row.address, row.name]));
  const coinNames = store.status("catalog")?.payload.coinNames ?? {};
  const rawCoin = coin && (Object.entries(coinNames).find(([, value]) => value === coin)?.[0] ?? coin);
  const matching = query ? [...names].filter(([address, name]) => `${address} ${name}`.toLowerCase().includes(query.toLowerCase())).map(([address]) => address) : [];
  const candidates = favorites ?? [...names.keys()];
  const result = store.queryEvents({ wallet, wallets: wallet ? favorites : matching.length ? candidates.filter((address) => matching.includes(address)) : candidates, coin: rawCoin, action, actions, direction, precision, query: matching.length ? undefined : query,
    minNotional, from, to, offset, limit, order: order as "newest" | "oldest" | "largest" | "price" | "price-asc" });
  const events = store.evidence(result.events).map((event) => ({ ...event, walletName: names.get(event.wallet) ?? event.wallet,
    coin: coinNames[event.coin] ?? event.coin, source: event.precision === "exact" ? "user" : "market", startPosition: event.precision === "exact" ? event.startPosition : undefined }));
  const payload = { ...result, events, to, updatedAt: Date.now() };
  cache.set(key, { expires: Date.now() + 500, payload });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return publicJson(request, payload);
}
