"use client";

import { useMemo, useState, type PointerEvent } from "react";
import type { CoinDetail } from "@/lib/hyperliquid";

const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 10 ? 4 : 2 }).format(value);

export function MarketChart({ candles, events }: Pick<CoinDetail, "candles" | "events">) {
  const rows = useMemo(() => candles.slice(-192), [candles]);
  const [hovered, setHovered] = useState<number | null>(null);
  if (rows.length < 2) return <div className="flex h-[360px] items-center justify-center text-sm text-[var(--muted)]">Свечная история пока недоступна</div>;
  const min = Math.min(...rows.map((row) => row.low)); const max = Math.max(...rows.map((row) => row.high)); const span = Math.max(1e-9, max - min);
  const x = (index: number) => index / Math.max(1, rows.length - 1) * 1000;
  const y = (value: number) => 300 - (value - min) / span * 280 - 10;
  const width = Math.max(1.5, 760 / rows.length); const active = hovered === null ? rows.at(-1)! : rows[hovered];
  const visibleEvents = events.filter((event) => ["LONG", "SHORT"].includes(event.direction ?? "") && event.time >= rows[0].time && event.time <= rows.at(-1)!.time).slice(0, 120);
  const eventX = (time: number) => (time - rows[0].time) / Math.max(1, rows.at(-1)!.time - rows[0].time) * 1000;
  const move = (event: PointerEvent<SVGSVGElement>) => { const rect = event.currentTarget.getBoundingClientRect(); setHovered(Math.min(rows.length - 1, Math.max(0, Math.round((event.clientX - rect.left) / rect.width * (rows.length - 1))))); };
  return <section className="relative overflow-hidden border-t border-[var(--line)] bg-[#020202] p-3 sm:p-5">
    <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[10px] text-[var(--muted)]"><span>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(active.time)}</span><span>O <b className="mono text-white">{money(active.open)}</b></span><span>H <b className="mono text-white">{money(active.high)}</b></span><span>L <b className="mono text-white">{money(active.low)}</b></span><span>C <b className="mono text-white">{money(active.close)}</b></span></div>
    <svg viewBox="0 0 1000 300" preserveAspectRatio="none" className="h-[330px] w-full touch-none" onPointerMove={move} onPointerLeave={() => setHovered(null)} aria-label="Свечной график за 48 часов">
      {[0, .25, .5, .75, 1].map((part) => <line key={part} x1="0" x2="1000" y1={part * 300} y2={part * 300} stroke="rgba(148,163,184,.09)" vectorEffect="non-scaling-stroke"/>)}
      {rows.map((row, index) => { const gain = row.close >= row.open; const color = gain ? "#5ee3dc" : "#ff6888"; return <g key={row.time}><line x1={x(index)} x2={x(index)} y1={y(row.high)} y2={y(row.low)} stroke={color} vectorEffect="non-scaling-stroke"/><rect x={x(index) - width / 2} y={Math.min(y(row.open), y(row.close))} width={width} height={Math.max(1, Math.abs(y(row.open) - y(row.close)))} fill={color}/></g>; })}
      {visibleEvents.map((event) => <circle key={event.eventKey} cx={eventX(event.time)} cy={event.direction === "LONG" ? 276 : 24} r="3.5" fill={event.direction === "LONG" ? "#5ee3dc" : "#ff6888"} stroke="#000" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>)}
      {hovered !== null && <line x1={x(hovered)} x2={x(hovered)} y1="0" y2="300" stroke="rgba(255,255,255,.45)" strokeDasharray="4 5" vectorEffect="non-scaling-stroke"/>}
    </svg>
    <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-[var(--muted)]"><span><i className="mr-1 inline-block size-2 rounded-full bg-[var(--cyan)]"/>Long entry</span><span><i className="mr-1 inline-block size-2 rounded-full bg-[var(--loss)]"/>Short entry</span><span>15m candles · smart-wallet events from Deep Current journal</span></div>
  </section>;
}
