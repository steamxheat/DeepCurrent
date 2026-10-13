import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getCoinDetail } from "@/lib/hyperliquid";
import { MarketChart } from "./market-chart";

const money = (value: number, compact = false) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : value < 10 ? 4 : 2 }).format(value);
const dateTime = (value: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "medium" }).format(value);

export default function CoinPage({ params }: { params: Promise<{ coin: string }> }) {
  return <Suspense fallback={<div className="min-h-dvh animate-pulse bg-black p-5"><div className="h-[620px] rounded-xl border border-[var(--line)] bg-white/[.025]"/></div>}><LiveCoin params={params}/></Suspense>;
}

async function LiveCoin({ params }: { params: Promise<{ coin: string }> }) {
  await connection(); const { coin } = await params; const data = await getCoinDetail(coin);
  const long = data.snapshots.filter((row) => row.size > 0); const short = data.snapshots.filter((row) => row.size < 0);
  const longValue = long.reduce((sum, row) => sum + Math.abs(row.positionValue), 0); const shortValue = short.reduce((sum, row) => sum + Math.abs(row.positionValue), 0);
  const averageEntry = data.snapshots.reduce((sum, row) => sum + row.entryPx * Math.abs(row.positionValue), 0) / Math.max(1, longValue + shortValue);
  const winners = [...data.snapshots].sort((a, b) => b.unrealizedPnl - a.unrealizedPnl).slice(0, 5);
  const liquidations = [...data.snapshots].filter((row) => row.liquidationPx).sort((a, b) => Math.abs((a.liquidationPx ?? 0) - data.markPx) - Math.abs((b.liquidationPx ?? 0) - data.markPx)).slice(0, 6);
  return <main className="mx-auto min-h-dvh max-w-[1500px] px-3 py-4 pb-16 sm:px-6">
    <header className="mb-4 flex items-center justify-between"><Link href="/" className="inline-flex min-h-10 items-center gap-2 rounded-md px-2 text-xs text-[var(--muted)] hover:bg-white/[.04] hover:text-white">← Deep Current</Link><span className="mono text-[10px] text-[var(--muted)]">Live · {dateTime(data.updatedAt)} MSK</span></header>
    <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[10px] uppercase tracking-[.12em] text-[var(--muted)]">Market intelligence</p><h1 className="mt-1 text-3xl font-semibold tracking-[-.04em]">{data.coin}</h1><p className="mt-2 text-xs text-[var(--muted)]">{data.source}</p></div><div className="sm:text-right"><p className="mono text-2xl font-semibold">{money(data.markPx)}</p><p className={`mono mt-1 text-xs ${data.change24h >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{data.change24h >= 0 ? "+" : ""}{data.change24h.toFixed(2)}% 24H</p></div></div>
      <div className="grid grid-cols-2 border-t border-[var(--line)] sm:grid-cols-4"><Metric label="24H volume" value={money(data.volume24h, true)}/><Metric label="Open interest" value={money(data.openInterest * data.markPx, true)}/><Metric label="Funding" value={`${(data.funding * 100).toFixed(4)}%`}/><Metric label="Smart avg entry" value={data.snapshots.length ? money(averageEntry) : "—"}/></div>
      <MarketChart candles={data.candles} events={data.events}/>
    </section>

    <section className="mt-4 grid overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] sm:grid-cols-4">{Object.entries(data.changes).map(([label, row]) => <div key={label} className="border-b border-r border-[var(--line)] p-4 last:border-r-0 sm:border-b-0"><p className="mono text-[10px] text-[var(--muted)]">{label}</p><p className={`mono mt-2 text-sm font-semibold ${row.net >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{row.net >= 0 ? "+" : ""}{money(row.net, true)}</p><p className="mt-1 text-[10px] text-[var(--muted)]">Long Δ {money(row.long, true)} · Short Δ {money(row.short, true)} · {row.wallets} wallets</p></div>)}</section>

    <div className="mt-4 grid gap-4 xl:grid-cols-3">
      <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]"><Head title="Smart-money exposure" note={`${data.snapshots.length} последних снимков`}/><div className="grid grid-cols-2"><Metric label={`Long · ${long.length}`} value={money(longValue, true)} tone="gain"/><Metric label={`Short · ${short.length}`} value={money(shortValue, true)} tone="loss"/></div>{data.snapshots.length ? <Rows rows={data.snapshots.slice(0, 8).map((row) => [row.wallet.slice(0, 8), `${row.size > 0 ? "LONG" : "SHORT"} · ${money(Math.abs(row.positionValue), true)}`, row.size > 0 ? "gain" : "loss"] as const)}/> : <Empty text="Снимки появятся после открытия страниц кошельков."/>}</section>
      <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]"><Head title="PnL leaders" note="Текущий нереализованный результат"/>{winners.length ? <Rows rows={winners.map((row) => [row.wallet.slice(0, 8), money(row.unrealizedPnl, true), row.unrealizedPnl >= 0 ? "gain" : "loss"] as const)}/> : <Empty text="Недостаточно снимков для сравнения."/>}</section>
      <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]"><Head title="Ближайшие ликвидации" note="Зоны из наблюдаемых открытых позиций"/>{liquidations.length ? <Rows rows={liquidations.map((row) => [row.wallet.slice(0, 8), money(row.liquidationPx ?? 0), row.size > 0 ? "gain" : "loss"] as const)}/> : <Empty text="Ликвидационные уровни не найдены."/>}</section>
    </div>
    <p className="mt-5 text-xs leading-5 text-[var(--muted)]">Точки сделок и потоки строятся только из накопленного журнала Deep Current. Пустой блок означает отсутствие сохранённых данных, а не отсутствие активности рынка.</p>
  </main>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) { return <div className="border-r border-[var(--line)] p-4 last:border-r-0"><p className="text-[10px] text-[var(--muted)]">{label}</p><p className={`mono mt-1 text-sm font-semibold ${tone === "gain" ? "text-[var(--cyan)]" : tone === "loss" ? "text-[var(--loss)]" : "text-white"}`}>{value}</p></div>; }
function Head({ title, note }: { title: string; note: string }) { return <div className="border-b border-[var(--line)] p-4"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-[10px] text-[var(--muted)]">{note}</p></div>; }
function Rows({ rows }: { rows: ReadonlyArray<readonly [string, string, "gain" | "loss"]> }) { return <div>{rows.map((row, index) => <div key={`${row[0]}-${index}`} className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3 text-xs last:border-0"><span className="mono text-[var(--muted)]">{row[0]}…</span><b className={`mono ${row[2] === "gain" ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{row[1]}</b></div>)}</div>; }
function Empty({ text }: { text: string }) { return <p className="px-4 py-12 text-center text-xs text-[var(--muted)]">{text}</p>; }
