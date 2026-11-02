import { lighterFill, screenLighterAccount } from "./lighter-screening.ts";
import { decimalAdd, decimalEqual, decimalSign, fillTransition, orderFillChain, validDecimal } from "./position-reducer.ts";
import { closedTrades } from "./stats.ts";

export const copySelectionCriteria = { revision: "2026-10-15-quality-v3", activeDays: 60, minimumTradeActions: 5,
  winRateScope: "entire_available_history", minimumWinRate: 60, positivePnlScope: "official_all_time",
  minimumVolume30dUsd: 300000, minimumNetPnl30dUsd: 50000, maximumDrawdownPct: 20,
  excludeScalpers: true, receiveLimitMs: 5000, receiveEndpoint: "fully_displayed_in_application",
  firstMilestone: 10, target: 20 } as const;

export type CopyQualityEvidence = {
  officialNetPnl30dUsd: string | null;
  maximumDrawdownPct: number | null;
  drawdownVerified: boolean;
  nonScalpingVerified: boolean | null;
};

// No equity/flow history means unknown risk, not zero drawdown. Closed-cycle PnL is not account PnL30d.
export function copyQualityDecision(evidence?: CopyQualityEvidence) {
  const pnl = evidence?.officialNetPnl30dUsd;
  const knownPnl = validDecimal(pnl) && Number.isFinite(Number(pnl));
  const dd = evidence?.maximumDrawdownPct;
  const knownDrawdown = evidence?.drawdownVerified === true && typeof dd === "number" && Number.isFinite(dd) && dd >= 0;
  const reasons: string[] = [];
  if (knownPnl && decimalSign(decimalAdd(pnl, String(-copySelectionCriteria.minimumNetPnl30dUsd))) < 0) reasons.push("net_pnl30d_below_50000");
  if (knownDrawdown && dd > copySelectionCriteria.maximumDrawdownPct) reasons.push("drawdown_above_20_percent");
  if (evidence?.nonScalpingVerified === false) reasons.push("scalping_not_copyable");
  if (reasons.length) return { status: "rejected" as const, reasons };
  if (!knownPnl) reasons.push("official_net_pnl30d_unverified");
  if (!knownDrawdown) reasons.push("drawdown_unverified");
  if (evidence?.nonScalpingVerified !== true) reasons.push("non_scalping_unverified");
  return { status: reasons.length ? "needs_review" as const : "quality_passed_pending_history_live" as const, reasons };
}

export function lifetimeLighterAccount(trades: Record<string, unknown>[], account: number, positions: Record<string, unknown>[], apiEndReached: boolean, now: number) {
  const ids = new Map<string, Record<string, unknown>>();
  for (const trade of trades) {
    if (typeof trade.trade_id_str !== "string" || !trade.trade_id_str) throw Error("missing_trade_id");
    const prior = ids.get(trade.trade_id_str);
    if (prior && JSON.stringify(prior) !== JSON.stringify(trade)) throw Error("conflicting_trade");
    ids.set(trade.trade_id_str, trade);
  }
  const unique = [...ids.values()]; const fills = unique.map(t => lighterFill(t, account));
  if (fills.some(f => f.time > now || f.time <= 0 || !f.hash)) throw Error("invalid_trade_time_or_hash");
  const check = screenLighterAccount(unique, account, positions, apiEndReached, now);
  let continuousFromFlat = apiEndReached;
  for (const coin of new Set(fills.map(f => f.coin))) {
    const chain = orderFillChain(fills.filter(f => f.coin === coin));
    continuousFromFlat &&= !chain.ambiguous && decimalEqual(chain.fills[0].startPosition!, "0");
    for (let n = 1; n < chain.fills.length; n++) continuousFromFlat &&= decimalEqual(fillTransition(chain.fills[n - 1])!.after, chain.fills[n].startPosition!);
  }
  const cycles = closedTrades(fills);
  const unknownCycles = cycles.filter(c => c.openedAt === null || !Number.isFinite(c.netPnl)).length;
  const wins = cycles.filter(c => c.openedAt !== null && c.netPnl > .000001).length;
  const actions = new Set(fills.filter(f => now - f.time <= 60 * 86400000).map(f => f.hash));
  let volume30d = "0";
  for (const t of unique) if (now - Number(t.timestamp) <= 30 * 86400000) volume30d = decimalAdd(volume30d, String(t.usd_amount));
  return { account, apiEndReached, continuousFromFlat, closedPositionsLifetime: cycles.length, winsLifetime: wins,
    winRateLifetime: cycles.length ? wins * 100 / cycles.length : null, unknownCycles,
    tradeActions60d: actions.size, actionHashes60d: [...actions], volume30dUsd: volume30d,
    positionsVerified: check.positionsVerified, openings: check.openings,
    feeBasis: "Trading commissions included; funding is not allocated per closed cycle", sampleWarning: cycles.length < 20 ? "Small lifetime sample; no artificial 20-cycle eligibility threshold" : null };
}

export function lifetimeWalletDecision(accounts: Array<ReturnType<typeof lifetimeLighterAccount>>, officialPnlAll: number, officialVolume30d: number, qualityEvidence?: CopyQualityEvidence) {
  const total = accounts.reduce((n, a) => n + a.closedPositionsLifetime, 0);
  const wins = accounts.reduce((n, a) => n + a.winsLifetime, 0);
  const actions = new Set(accounts.flatMap(a => a.actionHashes60d)).size;
  const volume30d = accounts.reduce((n, a) => decimalAdd(n, a.volume30dUsd), "0");
  const winRate = total ? wins * 100 / total : null;
  const complete = accounts.length > 0 && accounts.every(a => a.apiEndReached && a.continuousFromFlat && !a.unknownCycles && a.positionsVerified);
  const knownMoney = Number.isFinite(officialPnlAll) && Number.isFinite(officialVolume30d);
  const passes = complete && knownMoney && actions >= 5 && winRate !== null && winRate >= 60 && officialPnlAll > 0 && Number(volume30d) >= 300000 && officialVolume30d >= 300000;
  const quality = copyQualityDecision(qualityEvidence);
  return { status: !complete || !knownMoney ? "needs_review" : !passes ? "rejected" : quality.status === "quality_passed_pending_history_live" ? "historical_candidate_pending_live" : quality.status,
    criteriaRevision: copySelectionCriteria.revision, quality,
    closedPositionsLifetime: total, winsLifetime: wins, winRateLifetime: winRate, tradeActions60d: actions,
    observedVolume30dUsd: volume30d, officialVolume30dUsd: officialVolume30d, officialPnlAll,
    fullyAccepted: false, liveVerified: false, limitations: ["API pagination end plus flat-start continuity is not an independent archive proof", "Funding not allocated to each lifecycle", "Source-to-app latency/reconnect and cross-exchange execution not yet accepted"] };
}
