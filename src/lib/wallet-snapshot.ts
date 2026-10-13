import { getFillJournal, type ScopeSnapshot } from "./fill-journal.ts";
import { decimalEqual, validDecimal } from "./position-reducer.ts";
import { displayCoin } from "./live.ts";
import type { Position } from "./hyperliquid";

export type WalletSnapshot = {
  address: string; positions: Position[]; updatedAt: number; accountValue: number;
  totalMarginUsed: number; withdrawable: number; positionHistoryStart: number | null;
  pending: boolean; unavailableScopes: string[];
};

export function streamScopeSnapshots(wallet: string, value: unknown, receivedAt: number): ScopeSnapshot[] {
  if (!value || typeof value !== "object") throw new Error("Invalid all-DEX scope payload");
  const entries = Array.isArray(value) ? value : Object.entries(value);
  return entries.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[1] || !Array.isArray(entry[1].assetPositions)) throw new Error("Invalid streamed clearinghouse scope");
    return { wallet, scope: entry[0], requestedAt: receivedAt, receivedAt, payload: entry[1] };
  });
}

export function snapshotRefreshScopes(scopes: ScopeSnapshot[], dexNames: string[], streaming: boolean, now = Date.now()) {
  return [...dexNames.filter((name) => {
    const scope = scopes.find((row) => row.scope === name);
    return !streaming || !scope?.payload || scope.error || now - scope.receivedAt >= 20_000;
  }), "spot"];
}

export function readWalletSnapshot(address: string, store = getFillJournal(), now = Date.now()): WalletSnapshot {
  const scopes = store.scopes(address); const catalog = store.status("catalog")?.payload;
  const coverage = store.getCoverage(address); const states = scopes.filter((scope) => scope.scope !== "spot" && scope.payload);
  const unavailableScopes = [...(catalog?.dexNames ?? [""]), "spot"].filter((name) => {
    const scope = scopes.find((row) => row.scope === name);
    return !scope?.payload || scope.error || now - scope.receivedAt > 30_000;
  });
  const positions = states.flatMap((scope) => {
    const members = scope.payload!.assetPositions as { position: { coin: string; szi: string; entryPx: string; positionValue: string; unrealizedPnl: string; marginUsed?: string; leverage?: { value?: number }; liquidationPx?: string | null } }[];
    return members.flatMap(({ position }) => {
      const state = store.getState(address, position.coin);
      if (state && !state.reason && state.lastTime > scope.receivedAt && !decimalEqual(state.size, position.szi)) {
        if (!unavailableScopes.includes(scope.scope)) unavailableScopes.push(scope.scope);
        if (decimalEqual(state.size, "0")) return [];
      }
      const covered = state?.openedAt !== null && state?.openedAt !== undefined && coverage?.status === "covered_interval" && coverage.from_time <= state.openedAt && coverage.through_time >= state.lastTime;
      const aligned = state && !state.reason && state.lastTime <= scope.receivedAt && decimalEqual(state.size, position.szi);
      const openedAt = aligned && covered && !scope.error && now - scope.receivedAt < 30_000 ? state.openedAt : null;
      const opening = openedAt === null ? undefined : store.opening(address, position.coin, openedAt);
      const lastEvent = state ? store.queryEvents({ wallet: address, coin: position.coin, from: state.lastTime, to: state.lastTime, limit: 1 }).events[0] : undefined;
      return [{ coin: displayCoin(position.coin, catalog?.coinNames ?? {}), size: Number(position.szi), entryPx: Number(position.entryPx),
        positionValue: Number(position.positionValue), unrealizedPnl: Number(position.unrealizedPnl),
        marginUsed: position.marginUsed === undefined ? undefined : Number(position.marginUsed),
        leverage: Number(position.leverage?.value ?? 1), liquidationPx: position.liquidationPx ? Number(position.liquidationPx) : null,
        openedAt, openedAtPrecision: openedAt === null ? "unknown" as const : "reconstructed" as const,
        initialSize: opening ? Math.abs(Number(opening.afterSize)) : null, lastChangedAt: aligned ? state.lastTime : null,
        updatedAt: scope.receivedAt, source: "Hyperliquid · scoped snapshot + fill journal",
        lastAction: aligned && lastEvent?.precision === "exact" ? lastEvent.action : undefined,
        reason: scope.error ? "Ошибка сверки рынка" : now - scope.receivedAt >= 30_000 ? "Снимок устарел" : !aligned ? "Позиция ещё не согласована с журналом" : !covered ? "История открытия неполная" : undefined }];
    });
  }).filter((position) => position.size);
  const total = (section: string, field: string) => states.length ? states.reduce((sum, scope) => {
    const source = section ? scope.payload![section] as Record<string, unknown> | undefined : scope.payload;
    return sum + (validDecimal(source?.[field]) ? Number(source![field]) : NaN);
  }, 0) : NaN;
  return { address, positions, updatedAt: states.length ? Math.min(...states.map((scope) => scope.receivedAt)) : 0,
    accountValue: total("marginSummary", "accountValue"), totalMarginUsed: total("marginSummary", "totalMarginUsed"), withdrawable: total("", "withdrawable"),
    positionHistoryStart: coverage?.from_time ?? null, pending: states.length === 0, unavailableScopes };
}
