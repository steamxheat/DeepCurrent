import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { computeFillStats, netClosedPnl } from "@/lib/stats";
import { getWalletDetail } from "@/lib/hyperliquid";
import { PerformanceChart } from "./performance-chart";

const money = (value: number, compact = false) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 2,
}).format(value);
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;

export default function WalletPage({ params }: PageProps<"/wallet/[address]">) {
  return <Suspense fallback={<WalletSkeleton/>}><LiveWallet params={params}/></Suspense>;
}

async function LiveWallet({ params }: { params: Promise<{ address: string }> }) {
  await connection();
  const { address } = await params;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) notFound();
  const wallet = await getWalletDetail(address);
  const stats = computeFillStats(wallet.fills);
  const openPnl = wallet.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const positionValue = wallet.positions.reduce((sum, position) => sum + Math.abs(position.positionValue), 0);
  const longValue = wallet.positions.filter((position) => position.size > 0).reduce((sum, position) => sum + Math.abs(position.positionValue), 0);
  const bias = positionValue ? Math.round((longValue / positionValue) * 100) : 50;
  const monthPnl = wallet.portfolio.month.pnl.at(-1)?.[1] ?? 0;
  const risk = wallet.accountValue ? (wallet.totalMarginUsed / wallet.accountValue) * 100 : 0;

  return <main className="mx-auto min-h-dvh w-full max-w-[1540px] px-3 py-3 pb-12 sm:px-6 sm:py-6">
    <header className="mb-4 flex items-center justify-between px-1">
      <Link href="/" aria-label="Вернуться в DC Pulse" className="inline-flex min-h-11 items-center gap-2.5 rounded-lg pr-3 text-sm text-[var(--muted)] transition-colors hover:bg-white/[.04] hover:text-white">
        <span className="flex size-11 items-center justify-center" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 18-6-6 6-6"/></svg></span>
        <span className="relative size-9 shrink-0 overflow-hidden rounded-lg border border-white/[.08] bg-[#02060c]"><Image src="/dc-pulse-mark.png" fill sizes="36px" alt="" className="object-cover" priority/></span>
        <span className="hidden font-medium text-white sm:inline">DC Pulse</span>
      </Link>
      <span className="flex items-center gap-2 rounded-full border border-white/[.08] bg-white/[.035] px-3 py-2 text-[11px] text-[var(--cyan)]"><i className="live-dot size-1.5 rounded-full bg-[var(--cyan)]"/>LIVE DATA</span>
    </header>

    <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex flex-col gap-5 border-b border-white/[.07] p-5 sm:p-7 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0"><h1 className="text-xl font-semibold tracking-[-.025em] sm:text-2xl">Wallet <span className="mono text-[var(--muted)]">{short(wallet.address)}</span></h1><p className="mono mt-2 truncate text-xs text-[var(--muted)]" title={wallet.address}>{wallet.address}</p><div className="mt-4 flex flex-wrap items-center gap-2"><Chip label="Account" value={money(wallet.accountValue, true)}/><Chip label="30D PnL" value={`${monthPnl >= 0 ? "+" : ""}${money(monthPnl, true)}`} tone={monthPnl >= 0 ? "gain" : "loss"}/><Chip label="Win rate*" value={`${stats.winRate.toFixed(1)}%`}/><Chip label="Bias" value={`${bias >= 50 ? "Long" : "Short"} ${Math.max(bias, 100 - bias)}%`} tone={bias >= 50 ? "gain" : "loss"}/></div></div>
        <a href={`https://app.hyperliquid.xyz/explorer/address/${wallet.address}`} target="_blank" rel="noreferrer" className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-[var(--line)] bg-white/[.025] px-3 text-xs font-medium transition-colors hover:border-[#62ddd866] hover:text-[var(--cyan)]">Открыть в Explorer<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 5h5v5M10 14 19 5M19 14v5H5V5h5"/></svg></a>
      </div>

      <div className="grid xl:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="order-2 border-t border-white/[.07] xl:order-1 xl:border-b-0 xl:border-r xl:border-t-0">
          <div className="border-b border-white/[.07] px-5 py-4"><h2 className="font-semibold">Wallet stats</h2><p className="mt-1 text-xs text-[var(--muted)]">Снимок текущего состояния</p></div>
          <StatSection title="Капитал"><StatRow label="Account value" value={money(wallet.accountValue, true)}/><StatRow label="Position value" value={money(positionValue, true)}/><StatRow label="Margin in use" value={money(wallet.totalMarginUsed, true)}/><StatRow label="Withdrawable" value={money(wallet.withdrawable, true)}/><StatRow label="Positions P&L" value={money(openPnl, true)} tone={openPnl >= 0 ? "gain" : "loss"}/></StatSection>
          <StatSection title="Риск и история"><StatRow label="Margin / account" value={`${risk.toFixed(1)}%`}/><StatRow label="Profit factor*" value={Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞"}/><StatRow label="Closed fills*" value={stats.closed.toLocaleString("en-US")}/><StatRow label="30D volume" value={money(wallet.portfolio.month.volume, true)}/></StatSection>
        </aside>
        <div className="order-1 min-w-0 p-2 sm:p-4 lg:p-5 xl:order-2"><PerformanceChart portfolio={wallet.portfolio} fills={wallet.fills}/></div>
      </div>
    </section>

    <section className="mt-4 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <SectionHead title="Открытые позиции" note={`${wallet.positions.length} активных · маржа и ликвидация в реальном времени`}/>
      {wallet.positions.length ? <><div className="divide-y divide-white/[.06] sm:hidden">{wallet.positions.map((position) => {
        const mark = position.size ? position.entryPx + position.unrealizedPnl / position.size : position.entryPx;
        return <article key={position.coin} className="p-4"><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-2"><span className="text-lg font-semibold">{position.coin}</span><span className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${position.size >= 0 ? "bg-[#62ddd818] text-[var(--cyan)]" : "bg-[#ff668a18] text-[var(--loss)]"}`}>{position.size >= 0 ? "LONG" : "SHORT"}</span></div><div className="text-right"><p className={`mono text-sm font-semibold ${position.unrealizedPnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{position.unrealizedPnl >= 0 ? "+" : ""}{money(position.unrealizedPnl, true)}</p><p className="mt-1 text-[10px] text-[var(--muted)]">Open P&L</p></div></div><dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><PositionStat label="Notional" value={money(Math.abs(position.positionValue), true)}/><PositionStat label="Leverage" value={`${position.leverage}×`}/><PositionStat label="Entry / Mark" value={`${money(position.entryPx)} / ${money(mark)}`}/><PositionStat label="Liquidation" value={position.liquidationPx ? money(position.liquidationPx) : "—"}/></dl></article>;
      })}</div><div className="hidden overflow-x-auto thin-scrollbar sm:block"><table className="w-full min-w-[900px] border-collapse text-left"><thead><tr className="border-b border-white/[.07] text-[11px] uppercase tracking-[.08em] text-[var(--muted)]"><Th>Asset</Th><Th>Side</Th><Th align="right">Notional</Th><Th align="right">Margin</Th><Th align="right">Entry</Th><Th align="right">Mark</Th><Th align="right">Liq.</Th><Th align="right">Lev.</Th><Th align="right">Open P&L</Th></tr></thead><tbody>{wallet.positions.map((position) => {
        const mark = position.size ? position.entryPx + position.unrealizedPnl / position.size : position.entryPx;
        return <tr key={position.coin} className="border-b border-white/[.055] last:border-0"><Td><span className="font-semibold">{position.coin}</span></Td><Td><span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${position.size >= 0 ? "bg-[#62ddd818] text-[var(--cyan)]" : "bg-[#ff668a18] text-[var(--loss)]"}`}>{position.size >= 0 ? "LONG" : "SHORT"}</span></Td><Td align="right">{money(Math.abs(position.positionValue), true)}</Td><Td align="right">{money(Math.abs(position.positionValue) / Math.max(1, position.leverage), true)}</Td><Td align="right">{money(position.entryPx)}</Td><Td align="right">{money(mark)}</Td><Td align="right">{position.liquidationPx ? money(position.liquidationPx) : "—"}</Td><Td align="right"><span className="text-[var(--warn)]">{position.leverage}×</span></Td><Td align="right"><span className={position.unrealizedPnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{position.unrealizedPnl >= 0 ? "+" : ""}{money(position.unrealizedPnl, true)}</span></Td></tr>;
      })}</tbody></table></div></> : <Empty text="У этого кошелька сейчас нет открытых позиций."/>}
    </section>

    <section className="mt-4 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <SectionHead title="Последние закрытия" note="Результат сделки с учётом signed fee"/>
      <div className="overflow-x-auto thin-scrollbar"><table className="w-full min-w-[720px] border-collapse text-left"><thead><tr className="border-b border-white/[.07] text-[11px] uppercase tracking-[.08em] text-[var(--muted)]"><Th>Asset</Th><Th>Action</Th><Th align="right">Size</Th><Th align="right">Exit price</Th><Th align="right">Time</Th><Th align="right">Realized P&L</Th></tr></thead><tbody>{wallet.fills.filter((fill) => Number(fill.closedPnl) !== 0).slice(0, 25).map((fill, index) => { const pnl = netClosedPnl(fill); return <tr key={`${fill.hash}-${index}`} className="border-b border-white/[.055] last:border-0"><Td><span className="font-semibold">{fill.coin}</span></Td><Td><span className="text-[var(--muted)]">{fill.dir}</span></Td><Td align="right">{Number(fill.sz).toLocaleString("en-US", { maximumFractionDigits: 4 })}</Td><Td align="right">{money(Number(fill.px))}</Td><Td align="right">{new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(fill.time)}</Td><Td align="right"><span className={pnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{pnl >= 0 ? "+" : ""}{money(pnl)}</span></Td></tr>; })}</tbody></table></div>
    </section>
    <p className="mt-5 px-2 text-xs leading-5 text-[var(--muted)]">* Win rate, profit factor и Realized PnL посчитаны по последним 1 000 fills, доступным через публичный API. Это аналитика истории, а не торговая рекомендация.</p>
  </main>;
}

function WalletSkeleton() {
  return <main className="mx-auto min-h-dvh w-full max-w-[1540px] animate-pulse px-4 py-6"><div className="mb-5 h-12 w-44 rounded-xl bg-white/[.05]"/><div className="h-[660px] rounded-[26px] bg-white/[.05]"/><div className="mt-5 h-72 rounded-[24px] bg-white/[.05]"/></main>;
}

function Chip({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) {
  return <span className="rounded-full border border-white/[.08] bg-white/[.035] px-3 py-1.5 text-xs text-[var(--muted)]">{label} <b className={`mono ml-1 font-medium ${tone === "gain" ? "text-[var(--cyan)]" : tone === "loss" ? "text-[var(--loss)]" : "text-white"}`}>{value}</b></span>;
}

function StatSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="border-b border-white/[.07] px-5 py-5 last:border-0"><h3 className="mb-3 text-xs font-medium text-[var(--muted)]">{title}</h3><dl className="space-y-3">{children}</dl></div>;
}

function StatRow({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) {
  return <div className="flex items-center justify-between gap-3"><dt className="text-xs text-[var(--muted)]">{label}</dt><dd className={`mono text-xs font-medium ${tone === "gain" ? "text-[var(--cyan)]" : tone === "loss" ? "text-[var(--loss)]" : "text-white"}`}>{value}</dd></div>;
}

function PositionStat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[10px] text-[var(--muted)]">{label}</dt><dd className="mono mt-1 truncate text-[11px] text-white">{value}</dd></div>;
}

function SectionHead({ title, note }: { title: string; note: string }) {
  return <div className="border-b border-white/[.07] px-4 py-4 sm:px-6"><h2 className="font-semibold">{title}</h2><p className="mt-1 text-xs text-[var(--muted)]">{note}</p></div>;
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th className={`px-5 py-3 font-medium ${align === "right" ? "text-right" : ""}`}>{children}</th>;
}

function Td({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td className={`mono px-5 py-4 text-xs ${align === "right" ? "text-right" : ""}`}>{children}</td>;
}

function Empty({ text }: { text: string }) {
  return <p className="px-5 py-16 text-center text-sm text-[var(--muted)]">{text}</p>;
}
