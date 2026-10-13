import { writeFileSync } from "node:fs";
import { walletScreenings } from "../src/lib/event-store.ts";

const rows = walletScreenings(true, 5_000);
if (rows.length < 1_000) throw new Error(`Need at least 1000 fresh verified wallets, found ${rows.length}`);
const compact = rows.map(({ address, trades, wins, winRate, netPnl, volume, lastActive, score, screenedAt }) =>
  [address, trades, wins, winRate, netPnl, volume, lastActive, score, screenedAt]);
writeFileSync(new URL("../src/lib/wallet-registry.json", import.meta.url), `${JSON.stringify(compact)}\n`);
console.log(`Exported ${compact.length} verified wallets.`);
