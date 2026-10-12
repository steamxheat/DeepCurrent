"use client";

import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { eventSummary, groupFillMarkers, realizedSeries, type ChartPoint } from "@/lib/chart";
import { netClosedPnl, type Fill } from "@/lib/stats";
import type { PortfolioRange, PortfolioSeries } from "@/lib/portfolio";

type Metric = "pnl" | "equity" | "realized";
type Range = "day" | "week" | "month" | "threeMonths" | "year" | "allTime";
type MarkerMode = "summary" | "all" | "hidden";

const metrics: { id: Metric; label: string }[] = [
  { id: "pnl", label: "Period PnL" },
  { id: "equity", label: "Account value" },
  { id: "realized", label: "Realized PnL" },
];
const ranges: { id: Range; label: string }[] = [
  { id: "day", label: "24H" }, { id: "week", label: "7D" }, { id: "month", label: "30D" },
  { id: "threeMonths", label: "3M" }, { id: "year", label: "1Y" }, { id: "allTime", label: "MAX" },
];
const metricLabels: Record<Metric, string> = { pnl: "Period P&L", equity: "Account change", realized: "Realized P&L*" };

const money = (value: number, compact = true) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 2,
}).format(value);
const date = (time: number, range: Range) => new Intl.DateTimeFormat("ru-RU", range === "day"
  ? { hour: "2-digit", minute: "2-digit" }
  : { day: "2-digit", month: "short" }).format(time).replace(".", "");

function sourceRange(range: Range): PortfolioRange {
  if (range === "threeMonths" || range === "year") return "allTime";
  return range;
}

function visibleSeries(series: PortfolioSeries, range: Range, metric: Metric, fills: Fill[]) {
  const base = metric === "equity" ? series.accountValue : series.pnl;
  if (!base.length) return { points: [] as ChartPoint[], start: 0, end: 0 };
  const end = base.at(-1)![0];
  const start = range === "threeMonths" ? end - 90 * 86_400_000
    : range === "year" ? end - 365 * 86_400_000
      : base[0][0];
  const points = metric === "realized" ? realizedSeries(fills, start, end) : base.filter(([time]) => time >= start);
  return { points, start, end };
}

function closest(points: ChartPoint[], time: number) {
  let best = 0;
  for (let index = 1; index < points.length; index++) {
    if (Math.abs(points[index][0] - time) < Math.abs(points[best][0] - time)) best = index;
  }
  return best;
}

export function PerformanceChart({ portfolio, fills }: {
  portfolio: Record<PortfolioRange, PortfolioSeries>;
  fills: Fill[];
}) {
  const [metric, setMetric] = useState<Metric>("pnl");
  const [range, setRange] = useState<Range>("month");
  const [markers, setMarkers] = useState<MarkerMode>("summary");
  const [hovered, setHovered] = useState<number | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<ReturnType<typeof groupFillMarkers>[number] | null>(null);
  const gradientId = useId().replaceAll(":", "");
  const source = portfolio[sourceRange(range)];
  const { points: rawPoints, start, end } = useMemo(() => visibleSeries(source, range, metric, fills), [source, range, metric, fills]);
  const points = useMemo(() => {
    if (rawPoints.length <= 260) return rawPoints;
    const step = Math.ceil(rawPoints.length / 260);
    const sampled = rawPoints.filter((_, index) => index % step === 0);
    if (sampled.at(-1)?.[0] !== rawPoints.at(-1)?.[0]) sampled.push(rawPoints.at(-1)!);
    return sampled;
  }, [rawPoints]);
  const summary = useMemo(() => eventSummary(fills, start, end), [fills, start, end]);
  const markerGroups = useMemo(() => markers === "hidden" ? [] : groupFillMarkers(fills, start, end, markers === "summary" ? 12 : 30), [fills, start, end, markers]);
  const controls = <div className="border-b border-[var(--line)] px-3 py-3 sm:px-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1 overflow-x-auto thin-scrollbar" aria-label="Метрика графика">
        {metrics.map((item) => <button key={item.id} onClick={() => { setMetric(item.id); setHovered(null); setSelectedMarker(null); }} aria-pressed={metric === item.id} className={`h-8 shrink-0 rounded-md border px-3 text-[11px] font-medium transition-colors ${metric === item.id ? "border-[#5ee3dc38] bg-[#5ee3dc0d] text-[var(--cyan)]" : "border-transparent text-[var(--muted)] hover:bg-white/[.035] hover:text-white"}`}>{item.label}</button>)}
      </div>
      <div className="flex gap-0.5 overflow-x-auto thin-scrollbar" aria-label="Период графика">
        {ranges.map((item) => <button key={item.id} onClick={() => { setRange(item.id); setHovered(null); setSelectedMarker(null); }} aria-pressed={range === item.id} className={`h-8 min-w-10 shrink-0 rounded-md px-2.5 text-[10px] font-semibold transition-colors ${range === item.id ? "bg-white/[.09] text-white" : "text-[var(--muted)] hover:text-white"}`}>{item.label}</button>)}
      </div>
    </div>
  </div>;

  if (points.length < 2) return <section className="overflow-hidden rounded-lg border border-[var(--line)] bg-[#080d15]">{controls}<div className="flex h-[360px] items-center justify-center px-6 text-center text-sm text-[var(--muted)]">Недостаточно данных для выбранной метрики и периода</div></section>;

  const values = points.map(([, value]) => value);
  const includeZero = metric !== "equity";
  let min = Math.min(...values, includeZero ? 0 : Infinity);
  let max = Math.max(...values, includeZero ? 0 : -Infinity);
  const padding = Math.max((max - min) * .12, Math.abs(max || 1) * .03);
  min -= padding;
  max += padding;
  const span = max - min || 1;
  const x = (time: number) => ((time - start) / Math.max(1, end - start)) * 1000;
  const y = (value: number) => 300 - ((value - min) / span) * 300;
  const line = points.map(([time, value], index) => `${index ? "L" : "M"}${x(time).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const baseline = metric === "equity" ? 300 : Math.max(0, Math.min(300, y(0)));
  const area = `${line} L1000 ${baseline} L0 ${baseline} Z`;
  const current = points.at(-1)![1];
  const periodChange = metric === "equity" ? current - points[0][1] : current;
  const yTicks = Array.from({ length: 5 }, (_, index) => max - ((max - min) / 4) * index);
  const xTicks = Array.from({ length: 5 }, (_, index) => start + ((end - start) / 4) * index);
  const active = hovered === null ? null : points[hovered];
  const truncatedEvents = fills.length === 1_000 && summary.total === fills.length;
  const selectedEvents = selectedMarker ? [...selectedMarker.events].sort((a, b) => b.time - a.time) : [];

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    if (selectedMarker || (event.target as Element).closest("[data-chart-overlay]")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setHovered(closest(points, start + ((event.clientX - bounds.left) / bounds.width) * (end - start)));
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setHovered((currentIndex) => Math.max(0, Math.min(points.length - 1, (currentIndex ?? points.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
  };

  return <section className="overflow-hidden rounded-lg border border-[var(--line)] bg-[#080d15]">
    {controls}

    <div className="grid gap-3 border-b border-[var(--line)] px-3 py-3 sm:px-4 lg:grid-cols-[1fr_auto] lg:items-center">
      <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
        <div><p className="text-[10px] text-[var(--muted)]">{metricLabels[metric]}</p><p className={`mono mt-1 text-xl font-semibold ${periodChange >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{periodChange >= 0 ? "+" : ""}{money(periodChange)}</p></div>
        <div><p className="text-[10px] text-[var(--muted)]">Events</p><p className="mono mt-1 text-xl font-semibold">{summary.total}{truncatedEvents ? "+" : ""}</p></div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 pb-0.5 text-[10px] text-[var(--muted)]"><span><i className="mr-1.5 inline-block size-1.5 rounded-full bg-[#6d8dff]"/>{summary.opens} opens</span><span>{summary.closes} closes</span><span className="text-[var(--cyan)]">{summary.wins} wins</span><span className="text-[var(--loss)]">{summary.losses} losses</span></div>
      </div>
      <div className="flex w-fit gap-0.5 rounded-md border border-[var(--line)] bg-white/[.02] p-0.5" aria-label="Плотность маркеров">
        {([{ id: "summary", label: "Сводные" }, { id: "all", label: "Детально" }, { id: "hidden", label: "Скрыть" }] as const).map((item) => <button key={item.id} onClick={() => { setMarkers(item.id); setSelectedMarker(null); }} aria-pressed={markers === item.id} className={`h-8 rounded px-2.5 text-[10px] transition-colors ${markers === item.id ? "bg-white/[.09] text-white" : "text-[var(--muted)] hover:text-white"}`}>{item.label}</button>)}
      </div>
    </div>

    <div className="px-2 pb-4 pt-2 sm:px-5 sm:pb-6">
      <div className="relative h-[330px] sm:h-[400px]">
        <div className="absolute bottom-12 left-14 right-3 top-12 touch-pan-y" tabIndex={0} role="img" aria-label={`${metricLabels[metric]}, изменение за период ${money(periodChange, false)}. Используйте стрелки влево и вправо для просмотра точек.`} onPointerMove={move} onPointerLeave={() => setHovered(null)} onKeyDown={keyboard}>
          <svg className="size-full overflow-visible" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={`${gradientId}-positive`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#62ddd8" stopOpacity=".3"/><stop offset="1" stopColor="#62ddd8" stopOpacity=".015"/></linearGradient>
              <linearGradient id={`${gradientId}-negative`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#ff668a" stopOpacity=".025"/><stop offset="1" stopColor="#ff668a" stopOpacity=".28"/></linearGradient>
              <clipPath id={`${gradientId}-above`}><rect width="1000" height={baseline}/></clipPath>
              <clipPath id={`${gradientId}-below`}><rect y={baseline} width="1000" height={300 - baseline}/></clipPath>
            </defs>
            {yTicks.map((tick) => <line key={tick} x1="0" x2="1000" y1={y(tick)} y2={y(tick)} stroke="rgba(140,160,190,.11)" vectorEffect="non-scaling-stroke"/>)}
            {xTicks.map((tick) => <line key={tick} x1={x(tick)} x2={x(tick)} y1="0" y2="300" stroke="rgba(140,160,190,.065)" vectorEffect="non-scaling-stroke"/>)}
            {metric !== "equity" && <line x1="0" x2="1000" y1={baseline} y2={baseline} stroke="rgba(200,215,235,.25)" strokeDasharray="5 7" vectorEffect="non-scaling-stroke"/>}
            {markerGroups.map((group) => <line key={group.time} x1={x(group.time)} x2={x(group.time)} y1="0" y2="300" stroke="rgba(132,147,174,.26)" strokeDasharray="3 6" vectorEffect="non-scaling-stroke"/>)}
            {metric === "equity" ? <><path d={area} fill={`url(#${gradientId}-positive)`}/><path d={line} fill="none" stroke="#72d8d3" strokeWidth="2.4" vectorEffect="non-scaling-stroke"/></> : <>
              <g clipPath={`url(#${gradientId}-above)`}><path d={area} fill={`url(#${gradientId}-positive)`}/><path d={line} fill="none" stroke="#72d8d3" strokeWidth="2.4" vectorEffect="non-scaling-stroke"/></g>
              <g clipPath={`url(#${gradientId}-below)`}><path d={area} fill={`url(#${gradientId}-negative)`}/><path d={line} fill="none" stroke="#ff668a" strokeWidth="2.4" vectorEffect="non-scaling-stroke"/></g>
            </>}
            {active && <><line x1={x(active[0])} x2={x(active[0])} y1="0" y2="300" stroke="rgba(255,255,255,.42)" strokeDasharray="4 5" vectorEffect="non-scaling-stroke"/><circle cx={x(active[0])} cy={y(active[1])} r="5" fill="#07101a" stroke={active[1] >= 0 || metric === "equity" ? "#72d8d3" : "#ff668a"} strokeWidth="3" vectorEffect="non-scaling-stroke"/></>}
          </svg>

          {yTicks.map((tick) => <span key={tick} className="mono pointer-events-none absolute -left-14 -translate-y-1/2 text-[10px] text-[var(--muted)]" style={{ top: `${(y(tick) / 300) * 100}%` }}>{money(tick)}</span>)}
          {xTicks.map((tick, index) => <span key={tick} className={`pointer-events-none absolute -bottom-9 text-[10px] text-[var(--muted)] ${index === 0 ? "translate-x-0" : index === xTicks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: `${(x(tick) / 1000) * 100}%` }}>{date(tick, range)}</span>)}
          {markerGroups.map((group, index) => <button key={group.time} onClick={() => { setSelectedMarker(group); setHovered(null); }} className={`absolute flex h-8 min-w-8 -translate-x-1/2 items-center justify-center sm:h-11 sm:min-w-11 ${index % 2 ? "-top-4 sm:-top-8" : "-top-12 sm:-top-11"}`} style={{ left: `${(x(group.time) / 1000) * 100}%` }} aria-label={`${group.count} событий, ${date(group.time, range)}`}><span className="mono rounded-full border border-[#8d9abf66] bg-[#65708d] px-2 py-0.5 text-[10px] font-semibold text-white shadow-[0_4px_16px_rgba(0,0,0,.35)]">{group.count > 99 ? "99+" : group.count}</span></button>)}
          {active && !selectedMarker && <div className={`pointer-events-none absolute top-3 z-10 min-w-36 rounded-xl border border-white/[.12] bg-[#101827f2] px-3 py-2 shadow-[0_12px_30px_rgba(0,0,0,.38)] ${x(active[0]) > 760 ? "-translate-x-full" : x(active[0]) > 240 ? "-translate-x-1/2" : ""}`} style={{ left: `${(x(active[0]) / 1000) * 100}%` }}><p className="text-[10px] text-[var(--muted)]">{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(active[0])}</p><p className={`mono mt-1 text-sm font-semibold ${active[1] >= 0 || metric === "equity" ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{money(active[1], false)}</p></div>}
          {selectedMarker && <div data-chart-overlay className={`absolute left-1/2 top-3 z-20 w-64 -translate-x-1/2 rounded-xl border border-white/[.12] bg-[#101827fa] p-3 shadow-[0_14px_36px_rgba(0,0,0,.46)] sm:left-[var(--marker-left)] ${x(selectedMarker.time) > 720 ? "sm:-translate-x-full" : x(selectedMarker.time) > 280 ? "sm:-translate-x-1/2" : "sm:translate-x-0"}`} style={{ "--marker-left": `${(x(selectedMarker.time) / 1000) * 100}%` } as CSSProperties}><div className="flex items-start justify-between gap-2"><div><p className="text-[10px] text-[var(--muted)]">{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(selectedEvents[0]?.time ?? selectedMarker.time)}</p><p className="mt-0.5 text-xs font-semibold">{selectedMarker.count} событий · прокрути список</p></div><button onClick={() => setSelectedMarker(null)} className="flex size-8 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-white/[.06] hover:text-white" aria-label="Закрыть сведения">×</button></div><div className="mt-2 max-h-64 space-y-2 overflow-y-auto overscroll-contain pr-1 thin-scrollbar">{selectedEvents.map((fill, index) => { const pnl = netClosedPnl(fill); return <div key={`${fill.hash}-${index}`} className="border-t border-white/[.07] pt-2"><div className="flex items-center justify-between gap-3 text-[11px]"><span><b className="text-white">{fill.coin}</b> <span className="text-[var(--muted)]">{fill.dir}</span></span>{Number(fill.closedPnl) !== 0 && <span className={pnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{pnl >= 0 ? "+" : ""}{money(pnl)}</span>}</div><p className="mono mt-1 text-[10px] text-[var(--muted)]">{Number(fill.sz).toLocaleString("en-US", { maximumFractionDigits: 4 })} @ {money(Number(fill.px), false)}</p></div>; })}</div></div>}
          <p className="sr-only" aria-live="polite">{selectedMarker ? `${selectedMarker.count} событий, ${date(selectedMarker.time, range)}` : active ? `${date(active[0], range)}, ${money(active[1], false)}` : ""}</p>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-white/[.06] px-2 pt-4 text-[10px] text-[var(--muted)]"><span>Volume: {money(source.volume)}</span><span>* Realized PnL ограничен доступными fills</span></div>
    </div>
  </section>;
}
