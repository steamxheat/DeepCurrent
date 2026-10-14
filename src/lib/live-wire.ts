import type { PulseFill, FillEvidence } from "./hyperliquid";

export type LiveWireFill = [string, string, number, number | null, string, string, string, string, string, string, string, string | null, number, string | null, FillEvidence?];
export function encodeLiveFills(rows: Array<FillEvidence & { wallet: string; coin: string; time: number; tid?: number; px: string; sz: string; side: string; hash: string; dir: string; fee?: string; feeToken?: string; closedPnl?: string; startPosition?: string; source?: string }>): LiveWireFill[] {
  return rows.map((row) => [row.wallet, row.coin, row.time, row.tid ?? null, row.px, row.sz, row.side, row.hash,
    row.dir, row.fee ?? "0", row.closedPnl ?? "0", row.startPosition ?? null, row.source === "user" ? 1 : 0, row.feeToken ?? null,
    row.positionStatus || row.receivedAt !== undefined || row.confirmedAt !== undefined ? { action: row.action, direction: row.direction, receivedAt: row.receivedAt, confirmedAt: row.confirmedAt, positionStatus: row.positionStatus, openedAt: row.openedAt, closedAt: row.closedAt, netPnl: row.netPnl, leverage: row.leverage, checkedAt: row.checkedAt, reason: row.reason } : undefined]);
}
export function decodeLiveFills(rows: LiveWireFill[]): PulseFill[] {
  return rows.map(([wallet, coin, time, tid, px, sz, side, hash, dir, fee, closedPnl, startPosition, exact, feeToken, evidence]) => ({
    wallet, walletName: wallet, coin, time, tid: tid ?? undefined, px, sz, side: side === "B" ? "B" : "A", hash, dir, fee, closedPnl,
    startPosition: exact ? startPosition ?? undefined : undefined, source: exact ? "user" : "market", feeToken: feeToken ?? undefined,
    ...(evidence ?? {}),
  }));
}
