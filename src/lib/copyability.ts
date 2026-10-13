import type { ClosedTrade, Fill } from "./stats.ts";
import type { ChartPoint } from "./chart.ts";

export type CopyDelay = 1 | 3 | 10 | 30;
export type CopySample = { delay: CopyDelay; adverseBps: number };
export type CopyVerdict = "copyable" | "observe" | "avoid";

export type CopyabilityAnalysis = {
  score: number;
  verdict: CopyVerdict;
  confidence: "low" | "medium" | "high";
  averageHoldMs: number | null;
  medianHoldMs: number | null;
  makerShare: number | null;
  averageLiquidityShare: number | null;
  tradesPerDay: number;
  maxDrawdown: number | null;
  estimatedSlippageBps: number;
  grossPnl: number;
  fees: number;
  delayResults: Array<{ delay: CopyDelay; netPnl: number; retained: number; costBps: number; measured: boolean }>;
  completedTrades: number;
  fillCount: number;
  reasons: string[];
};

const delays: CopyDelay[] = [1, 3, 10, 30];
const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function maximumDrawdown(points: ChartPoint[]) {
  const values = points.map((point) => point[1]).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 2) return null;
  let peak = values[0]; let drawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) drawdown = Math.max(drawdown, ((peak - value) / peak) * 100);
  }
  return drawdown;
}

export function copyabilityScore(input: {
  fills: Fill[];
  closedTrades: ClosedTrade[];
  accountValue: ChartPoint[];
  marketVolumes?: Record<string, number>;
  samples?: CopySample[];
}): CopyabilityAnalysis {
  const fills = input.fills.filter((fill) => Number.isFinite(Number(fill.px)) && Number.isFinite(Number(fill.sz)));
  const holds = input.closedTrades.flatMap((trade) => trade.openedAt === null ? [] : [Math.max(0, trade.closedAt - trade.openedAt)]);
  const averageHoldMs = holds.length ? average(holds) : null;
  const medianHoldMs = median(holds);
  const tagged = fills.filter((fill) => typeof fill.crossed === "boolean");
  const makerShare = tagged.length ? tagged.filter((fill) => fill.crossed === false).length / tagged.length * 100 : null;
  const liquidityShares = fills.flatMap((fill) => {
    const volume = input.marketVolumes?.[fill.coin] ?? 0;
    return volume > 0 ? [Math.abs(Number(fill.px) * Number(fill.sz)) / volume * 100] : [];
  });
  const averageLiquidityShare = liquidityShares.length ? average(liquidityShares) : null;
  const times = fills.map((fill) => fill.time).filter(Number.isFinite);
  const observedDays = times.length > 1 ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86_400_000) : 1;
  const tradesPerDay = fills.length / observedDays;
  const maxDrawdown = maximumDrawdown(input.accountValue);
  const grossPnl = fills.reduce((sum, fill) => sum + Number(fill.closedPnl || 0), 0);
  const fees = fills.reduce((sum, fill) => sum + Number(fill.fee || 0), 0);
  const closedNotional = fills.filter((fill) => Number(fill.closedPnl || 0) !== 0)
    .reduce((sum, fill) => sum + Math.abs(Number(fill.px) * Number(fill.sz)), 0);
  const feeBps = closedNotional ? clamp(Math.abs(fees) / closedNotional * 10_000, 0, 100) : 2.5;
  const liquidityPenalty = averageLiquidityShare === null ? 3 : Math.sqrt(Math.max(0, averageLiquidityShare)) * 12;
  const takerPenalty = makerShare === null ? 1.5 : (100 - makerShare) / 100 * 2.5;
  const speedPenalty = medianHoldMs !== null && medianHoldMs < 300_000 ? 3 : medianHoldMs !== null && medianHoldMs < 3_600_000 ? 1.5 : .5;
  const estimatedSlippageBps = clamp(.5 + liquidityPenalty + takerPenalty + speedPenalty, .5, 75);
  const sampleGroups = new Map<CopyDelay, number[]>();
  for (const sample of input.samples ?? []) sampleGroups.set(sample.delay, [...(sampleGroups.get(sample.delay) ?? []), sample.adverseBps]);
  const delayResults = delays.map((delay) => {
    const measuredRows = sampleGroups.get(delay) ?? [];
    const measured = measuredRows.length >= 3;
    const slippage = measured ? Math.max(0, average(measuredRows)) : estimatedSlippageBps * Math.sqrt(delay);
    const costBps = slippage + feeBps;
    const netPnl = grossPnl + fees - closedNotional * costBps / 10_000;
    const retained = grossPnl > 0 ? netPnl / grossPnl * 100 : 0;
    return { delay, netPnl, retained, costBps, measured };
  });

  const holdScore = medianHoldMs === null ? 20 : clamp((Math.log10(Math.max(60_000, medianHoldMs) / 60_000) / Math.log10(1_440)) * 100);
  const makerScore = makerShare ?? 45;
  const liquidityScore = averageLiquidityShare === null ? 45 : clamp(100 - Math.log10(1 + averageLiquidityShare * 100) * 45);
  const frequencyScore = clamp(110 - Math.log10(1 + tradesPerDay) * 42);
  const drawdownScore = maxDrawdown === null ? 45 : clamp(100 - maxDrawdown * 1.7);
  const delayedScore = clamp(delayResults.find((result) => result.delay === 10)?.retained ?? 0);
  let score = Math.round(holdScore * .25 + liquidityScore * .2 + drawdownScore * .2 + delayedScore * .15 + makerScore * .1 + frequencyScore * .1);
  if (grossPnl <= 0 || input.closedTrades.length < 3) score = Math.min(score, 44);
  const confidence = input.closedTrades.length >= 30 && observedDays >= 30 && tagged.length >= 30 ? "high"
    : input.closedTrades.length >= 10 && observedDays >= 7 ? "medium" : "low";
  const verdict: CopyVerdict = score >= 70 && confidence !== "low" ? "copyable" : score >= 45 ? "observe" : "avoid";
  const reasons = [
    medianHoldMs !== null && medianHoldMs < 300_000 ? "Слишком короткое удержание для надёжного повторения" : "Время удержания допускает задержку исполнения",
    averageLiquidityShare !== null && averageLiquidityShare > .25 ? "Размеры сделок заметны относительно ликвидности" : "Размеры сделок умеренны относительно ликвидности",
    maxDrawdown !== null && maxDrawdown > 35 ? "Высокая историческая просадка" : "Просадка не доминирует над результатом",
    confidence === "low" ? "Недостаточно полной истории для уверенного вывода" : "Истории достаточно для сравнительной оценки",
  ];
  return { score, verdict, confidence, averageHoldMs, medianHoldMs, makerShare, averageLiquidityShare, tradesPerDay, maxDrawdown, estimatedSlippageBps, grossPnl, fees, delayResults, completedTrades: input.closedTrades.length, fillCount: fills.length, reasons };
}
