// Leave headroom below Hyperliquid's 2000 client messages/IP/minute.
export function createSocketBudget() {
  const sent: number[] = [];
  return (now = Date.now()) => {
    while (sent.length && sent[0] <= now - 60_000) sent.shift();
    if (sent.length >= 1800) return false;
    sent.push(now); return true;
  };
}
