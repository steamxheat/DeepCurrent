import { getFillJournal, validWalletAddress } from "./fill-journal.ts";
import { findConfluences, type ConfluenceWalletContext } from "./stats.ts";
import { dataFresh } from "./data-freshness.ts";

// One shared bounded read, not a history scan for every connected user.
let cached: { until: number; fills: ReturnType<ReturnType<typeof getFillJournal>["evidence"]>; context: ConfluenceWalletContext; capped: boolean; groups: Map<string, ReturnType<typeof findConfluences>> } | undefined;
export function readConfluences(minutes: number, options: Parameters<typeof findConfluences>[4] = {}, now = Date.now()) {
  const store = getFillJournal();
  if (!cached || now >= cached.until) {
    const targets = store.status("targets")?.payload?.wallets as { address: string; name: string; quality?: number }[] | undefined;
    const names = new Map((targets ?? []).map((row) => [row.address.toLowerCase(), row]));
    const raw = store.events(now - 86_400_000, 20_001);
    const rows = raw.slice(0, 20_000).filter((row) => row.precision === "exact" && names.has(row.wallet));
    const fills = store.evidence(rows.slice(0, 20_000), now).map((row) => ({ ...row, walletName: names.get(row.wallet)?.name }));
    const context: ConfluenceWalletContext = {};
    for (const wallet of new Set(fills.map((row) => row.wallet))) {
      const model = store.resource(wallet, "copyability");
      const score = model && dataFresh(model.updatedAt, now, 300_000) && model.payload.confidence !== "low" && Number.isFinite(model.payload.score) ? model.payload.score : undefined;
      context[wallet] = { quality: names.get(wallet)?.quality, copyability: score };
    }
    const relationships = store.db.prepare("SELECT payload FROM wallet_resources WHERE kind='subAccounts'").all() as { payload: string }[];
    for (const row of relationships) for (const account of (Array.isArray(JSON.parse(row.payload)) ? JSON.parse(row.payload) : [])) {
      if (typeof account.master !== "string" || typeof account.subAccountUser !== "string" || !validWalletAddress(account.master) || !validWalletAddress(account.subAccountUser)) continue;
      for (const wallet of [account.master.toLowerCase(), account.subAccountUser.toLowerCase()]) if (context[wallet]) context[wallet].cluster = `master:${account.master.toLowerCase()}`;
    }
    cached = { until: now + 10_000, fills, context, capped: raw.length > 20_000, groups: new Map() };
  }
  const key = JSON.stringify([minutes, options.minWallets ?? 2, options.minQuality ?? 0, options.minCopyability ?? 0, options.onlyOpen ?? false, Math.floor(now / 1000)]);
  let groups = cached.groups.get(key);
  if (!groups) {
    groups = findConfluences(cached.fills, now, minutes * 60_000, cached.context, options);
    if (cached.groups.size >= 100) cached.groups.delete(cached.groups.keys().next().value!);
    cached.groups.set(key, groups);
  }
  return { groups, updatedAt: cached.until - 10_000,
    capped: cached.capped, independence: "correlation_heuristic_not_ownership_proof" };
}
