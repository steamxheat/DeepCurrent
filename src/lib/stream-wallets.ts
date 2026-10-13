export function missingUserSubscriptions(wallets: Iterable<string>, acknowledged: Set<string>, fillsOnly = false) {
  return [...wallets].flatMap((user) => (fillsOnly ? ["userFills"] : ["userFills", "allDexsClearinghouseState", "userFundings"]).map((type) => ({
    type, user, ...(type === "userFills" ? { aggregateByTime: false } : {}),
  }))).filter((subscription) => !acknowledged.has(JSON.stringify(subscription)));
}

export function selectStreamWallets(input: { active: string[]; favorites: string[]; ranked: string[];
  subscribedAt: Map<string, number>; lastTrade: Map<string, number>; now: number }) {
  const byActivity = (a: string, b: string) => (input.lastTrade.get(b) ?? 0) - (input.lastTrade.get(a) ?? 0);
  const candidates = new Set([...input.active, ...input.favorites, ...input.ranked]);
  const held = [...input.subscribedAt].filter(([wallet, since]) => candidates.has(wallet) && input.now - since < 60_000).map(([wallet]) => wallet);
  const available = [...new Set(input.ranked)].sort(byActivity);
  return [...new Set([...input.active, ...[...input.favorites].sort(byActivity), ...held, ...available])].slice(0, 10);
}
