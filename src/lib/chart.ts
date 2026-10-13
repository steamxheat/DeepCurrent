import { isClosingFill, netClosedPnl, type Fill } from "./stats.ts";
import { fillTransition } from "./position-reducer.ts";

export type ChartPoint = [number, number];

export function realizedSeries(fills: Fill[], start: number, end: number): ChartPoint[] {
  const closed = fills
    .filter((fill) => fill.time >= start && fill.time <= end && Number.isFinite(netClosedPnl(fill)) && netClosedPnl(fill) !== 0)
    .sort((a, b) => a.time - b.time);
  let cumulative = 0;
  return [[start, 0], ...closed.map((fill) => [fill.time, cumulative += netClosedPnl(fill)] as ChartPoint), [end, cumulative]];
}

export function eventSummary(fills: Fill[], start: number, end: number) {
  const events = fills.filter((fill) => fill.time >= start && fill.time <= end);
  const closed = events.filter(isClosingFill);
  return {
    total: events.length,
    opens: events.filter((fill) => { const action = fillTransition(fill)?.action; return action ? ["OPEN", "FLIP"].includes(action) : /^open\b/i.test(fill.dir); }).length,
    closes: events.filter((fill) => { const action = fillTransition(fill)?.action; return action ? ["CLOSE", "FLIP"].includes(action) : /^close\b/i.test(fill.dir); }).length,
    wins: closed.filter((fill) => netClosedPnl(fill) > 0).length,
    losses: closed.filter((fill) => netClosedPnl(fill) < 0).length,
  };
}

export function groupFillMarkers(fills: Fill[], start: number, end: number, buckets: number) {
  const span = Math.max(1, end - start);
  const groups = new Map<number, Fill[]>();
  for (const fill of fills) {
    if (fill.time < start || fill.time > end) continue;
    const bucket = Math.min(buckets - 1, Math.floor(((fill.time - start) / span) * buckets));
    groups.set(bucket, [...(groups.get(bucket) ?? []), fill]);
  }
  return [...groups.entries()].map(([bucket, events]) => ({
    time: start + ((bucket + 0.5) / buckets) * span,
    count: events.length,
    events,
  })).sort((a, b) => a.time - b.time);
}
