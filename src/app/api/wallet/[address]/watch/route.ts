import { getFillJournal, validWalletAddress } from "@/lib/fill-journal";
import { readWalletSnapshot } from "@/lib/wallet-snapshot";
import { isSameOrigin } from "@/lib/request-origin";

export async function POST(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!validWalletAddress(address)) return Response.json({ error: "INVALID_WALLET" }, { status: 400 });
  if (!isSameOrigin(request)) return Response.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  const store = getFillJournal();
  try { store.touchWallet(address); } catch (error) {
    const busy = error instanceof Error && /locked|busy/.test(error.message);
    return Response.json({ error: busy ? "COLLECTOR_BUSY" : "CAPACITY_REACHED" }, { status: busy ? 503 : 429, headers: { "Retry-After": "1" } });
  }
  const snapshot = readWalletSnapshot(address.toLowerCase(), store); const collector = store.status("collector");
  return Response.json({ snapshot, updatedAt: snapshot.updatedAt, healthy: Boolean(collector && Date.now() - collector.updatedAt < 5000 && collector.payload.connected),
    pending: snapshot.pending, stale: snapshot.unavailableScopes.length > 0 }, { headers: { "Cache-Control": "no-store" } });
}
