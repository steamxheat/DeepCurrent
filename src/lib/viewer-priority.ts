export function createViewerPriority(dueTimes: Map<string, number>[]) {
  let previous = new Set<string>();
  return (wallets: Iterable<string>) => {
    const active = new Set(wallets);
    const entered = [...active].filter(wallet => !previous.has(wallet));
    const exited = [...previous].filter(wallet => !active.has(wallet));
    for (const wallet of entered) for (const due of dueTimes) due.delete(wallet);
    previous = active;
    return { active, entered, exited };
  };
}

export function nextDueWallet(wallets: Iterable<string>, inFlight: Set<string>, due: Map<string, number>, now = Date.now()) {
  return [...wallets].filter(wallet => !inFlight.has(wallet) && (due.get(wallet) ?? 0) <= now)
    .sort((a, b) => (due.get(a) ?? 0) - (due.get(b) ?? 0))[0];
}
