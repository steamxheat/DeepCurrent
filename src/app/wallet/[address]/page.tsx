import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { computeFillStats, netClosedPnl } from "@/lib/stats";
import { getWalletDetail } from "@/lib/hyperliquid";
import { marketIdentity } from "@/lib/live";
import { PerformanceChart } from "./performance-chart";
import { WalletLiveRefresh } from "./wallet-live-refresh";
import { sortClosedTrades, sortFills, sortPositions, type ClosedSort, type FillSort, type PositionSort } from "@/lib/wallet-sort";

const money = (value: number, compact = false) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 2,
}).format(value);
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;
const dateTime = (value: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
const duration = (milliseconds: number) => { const minutes = Math.max(0, Math.floor(milliseconds / 60_000)); const days = Math.floor(minutes / 1_440); const hours = Math.floor((minutes % 1_440) / 60); const rest = minutes % 60; return days ? `${days}д ${hours}ч` : hours ? `${hours}ч ${rest}м` : `${rest}м`; };

type WalletQuery = { open?: string | string[]; closed?: string | string[]; fills?: string | string[] };
const positionSorts: { value: PositionSort; label: string }[] = [{ value: "notional-desc", label: "Размер: сначала крупные" }, { value: "notional-asc", label: "Размер: сначала малые" }, { value: "time-desc", label: "Открыты недавно" }, { value: "time-asc", label: "Открыты давно" }, { value: "pnl-desc", label: "P&L: больше → меньше" }, { value: "pnl-asc", label: "P&L: меньше → больше" }, { value: "entry-desc", label: "Цена входа: выше → ниже" }, { value: "entry-asc", label: "Цена входа: ниже → выше" }];
const closedSorts: { value: ClosedSort; label: string }[] = [{ value: "time-desc", label: "Закрыты недавно" }, { value: "time-asc", label: "Закрыты давно" }, { value: "duration-desc", label: "Сначала долгие" }, { value: "duration-asc", label: "Сначала короткие" }, { value: "pnl-desc", label: "P&L: больше → меньше" }, { value: "pnl-asc", label: "P&L: меньше → больше" }, { value: "exit-desc", label: "Цена выхода: выше → ниже" }, { value: "exit-asc", label: "Цена выхода: ниже → выше" }];
const fillSorts: { value: FillSort; label: string }[] = [{ value: "time-desc", label: "Сначала новые" }, { value: "time-asc", label: "Сначала старые" }, { value: "notional-desc", label: "Сумма: больше → меньше" }, { value: "notional-asc", label: "Сумма: меньше → больше" }, { value: "price-desc", label: "Цена: выше → ниже" }, { value: "price-asc", label: "Цена: ниже → выше" }];
const one = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;
const allowed = <T extends string>(value: string | undefined, options: { value: T }[], fallback: T) => options.some((option) => option.value === value) ? value as T : fallback;

export default function WalletPage({ params, searchParams }: { params: Promise<{ address: string }>; searchParams: Promise<WalletQuery> }) {
  return <Suspense fallback={<WalletSkeleton/>}><LiveWallet params={params} searchParams={searchParams}/></Suspense>;
}

async function LiveWallet({ params, searchParams }: { params: Promise<{ address: string }>; searchParams: Promise<WalletQuery> }) {
  await connection();
  const { address } = await params;
  const query = await searchParams;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) notFound();
  const wallet = await getWalletDetail(address);
  const stats = computeFillStats(wallet.fills);
  const openPnl = wallet.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const positionValue = wallet.positions.reduce((sum, position) => sum + Math.abs(position.positionValue), 0);
  const longValue = wallet.positions.filter((position) => position.size > 0).reduce((sum, position) => sum + Math.abs(position.positionValue), 0);
  const bias = positionValue ? Math.round((longValue / positionValue) * 100) : 50;
  const monthPnl = wallet.portfolio.month.pnl.at(-1)?.[1] ?? 0;
  const risk = wallet.accountValue ? (wallet.totalMarginUsed / wallet.accountValue) * 100 : 0;
  const openSort = allowed(one(query.open), positionSorts, "notional-desc");
  const closedSort = allowed(one(query.closed), closedSorts, "time-desc");
  const fillSort = allowed(one(query.fills), fillSorts, "time-desc");
  const positions = sortPositions(wallet.positions, openSort);
  const completed = sortClosedTrades(wallet.closedTrades, closedSort);
  const fills = sortFills(wallet.fills.slice(0, 1_000), fillSort);
  const exactOpenings = wallet.positions.filter((position) => position.openedAt !== null).length;
  const historyStatus = exactOpenings === wallet.positions.length ? "время открытия восстановлено для всех позиций" : `${exactOpenings} из ${wallet.positions.length} с точным временем · для остальных показан минимум`;
  const sortState = { open: openSort, closed: closedSort, fills: fillSort };
  const verdict = wallet.copyability.verdict === "copyable" ? "Можно копировать" : wallet.copyability.verdict === "observe" ? "Только наблюдать" : "Не копируется";
  const hold = (value: number | null) => value === null ? "—" : duration(value);
  const opened = (value: number | null) => value ? dateTime(value) : "Раньше доступной истории";
  const held = (value: number | null) => value ? duration(wallet.updatedAt - value) : wallet.positionHistoryStart ? `≥ ${duration(wallet.updatedAt - wallet.positionHistoryStart)}` : "Неизвестно";

  return <main className="mx-auto min-h-dvh w-full max-w-[1540px] px-3 py-3 pb-12 sm:px-6 sm:py-6">
    <header className="mb-4 flex items-center justify-between px-1">
      <Link href="/" aria-label="Вернуться в Deep Current" className="inline-flex min-h-11 items-center gap-2.5 rounded-lg pr-3 text-sm text-[var(--muted)] transition-colors hover:bg-white/[.04] hover:text-white">
        <span className="flex size-11 items-center justify-center" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 18-6-6 6-6"/></svg></span>
        <span className="relative size-9 shrink-0 overflow-hidden rounded-lg border border-white/[.08] bg-[#02060c]"><Image src="/dc-pulse-mark.png" fill sizes="36px" alt="" className="object-cover" priority/></span>
        <span className="hidden font-medium text-white sm:inline">Deep Current</span>
      </Link>
      <WalletLiveRefresh address={wallet.address} updatedAt={wallet.updatedAt}/>
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

    <section className="mt-4 grid overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
      <div className="border-b border-[var(--line)] lg:border-b-0 lg:border-r">
        <SectionHead title="Copyability Score" note="Можно ли повторить результат после задержки, проскальзывания и комиссий"/>
        <div className="grid grid-cols-[110px_1fr] gap-4 p-5 sm:grid-cols-[140px_1fr]">
          <div><p className={`mono text-4xl font-semibold ${wallet.copyability.score >= 70 ? "text-[var(--cyan)]" : wallet.copyability.score >= 45 ? "text-[var(--warn)]" : "text-[var(--loss)]"}`}>{wallet.copyability.score}</p><p className="mt-1 text-xs font-medium">{verdict}</p><p className="mt-1 text-[10px] text-[var(--muted)]">confidence: {wallet.copyability.confidence}</p></div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-3"><CopyStat label="Среднее удержание" value={hold(wallet.copyability.averageHoldMs)}/><CopyStat label="Медиана" value={hold(wallet.copyability.medianHoldMs)}/><CopyStat label="Maker" value={wallet.copyability.makerShare === null ? "—" : `${wallet.copyability.makerShare.toFixed(1)}%`}/><CopyStat label="Сделок / день" value={wallet.copyability.tradesPerDay.toFixed(1)}/><CopyStat label="30D max drawdown" value={wallet.copyability.maxDrawdown === null ? "—" : `${wallet.copyability.maxDrawdown.toFixed(1)}%`}/><CopyStat label="Slippage model" value={`${wallet.copyability.estimatedSlippageBps.toFixed(1)} bps`}/></dl>
        </div>
        <div className="grid grid-cols-2 border-t border-[var(--line)] sm:grid-cols-4">{wallet.copyability.delayResults.map((row) => <div key={row.delay} className="border-b border-r border-[var(--line)] p-3 last:border-r-0 sm:border-b-0"><p className="mono text-[10px] text-[var(--muted)]">Delay {row.delay}s · {row.measured ? "measured" : "model"}</p><p className={`mono mt-1 text-sm ${row.retained >= 70 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{row.retained.toFixed(1)}% retained</p><p className="mt-1 text-[9px] text-[var(--muted)]">{row.costBps.toFixed(1)} bps total cost</p></div>)}</div>
      </div>
      <div><SectionHead title="Доверие к данным" note="Происхождение и полнота текущего расчёта"/><dl className="p-5 text-xs"><TrustRow label="Состояние" value={`${wallet.dataQuality.source.includes("резерв") ? "Кеш до 5 минут" : "Live"} · ${dateTime(wallet.dataQuality.updatedAt)} MSK`} tone={wallet.dataQuality.source.includes("резерв") ? undefined : "gain"}/><TrustRow label="Источник" value={wallet.dataQuality.source}/><TrustRow label="Fills" value={`${wallet.dataQuality.exactFills} точных · ${wallet.dataQuality.historyComplete ? "история полная" : "до 10 000 последних"}`}/><TrustRow label="Журнал" value={`${wallet.dataQuality.journalEvents} событий сохранено`}/><TrustRow label="Ордера / funding" value={`${wallet.dataQuality.ordersCaptured} / ${wallet.dataQuality.fundingCaptured}`}/><TrustRow label="Открытие позиций" value="Точное по startPosition; иначе показывается честная нижняя граница"/></dl></div>
    </section>

    <section id="open-positions" className="mt-4 scroll-mt-20 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <SectionHead title="Открытые позиции" note={`${wallet.positions.length} активных · ${historyStatus} · обновление каждые 10 секунд`} action={<SortMenu name="open" value={openSort} options={positionSorts} state={sortState} anchor="open-positions"/>}/>
      {wallet.positions.length ? <><div className="divide-y divide-white/[.06] sm:hidden">{positions.map((position) => {
        const mark = position.size ? position.entryPx + position.unrealizedPnl / position.size : position.entryPx; const market = marketIdentity(position.coin);
        return <article key={position.coin} className="p-4"><div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Link href={`/coin/${encodeURIComponent(position.coin)}`} className="text-lg font-semibold hover:text-[var(--cyan)]">{market.symbol}</Link><span className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${position.size >= 0 ? "bg-[#62ddd818] text-[var(--cyan)]" : "bg-[#ff668a18] text-[var(--loss)]"}`}>{position.size >= 0 ? "LONG" : "SHORT"}</span></div><p className="mt-1 text-[10px] text-[var(--muted)]">{market.venue}</p></div><div className="text-right"><p className={`mono text-sm font-semibold ${position.unrealizedPnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{position.unrealizedPnl >= 0 ? "+" : ""}{money(position.unrealizedPnl, true)}</p><p className="mt-1 text-[10px] text-[var(--muted)]">Open P&L</p></div></div><dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><PositionStat label="Открыта · MSK" value={position.openedAt ? `${opened(position.openedAt)} · восстановлено` : opened(null)}/><PositionStat label="В позиции" value={held(position.openedAt)}/><PositionStat label="Notional" value={money(Math.abs(position.positionValue), true)}/><PositionStat label="Leverage" value={`${position.leverage}×`}/><PositionStat label="Entry / Mark" value={`${money(position.entryPx)} / ${money(mark)}`}/><PositionStat label="Liquidation" value={position.liquidationPx ? money(position.liquidationPx) : "—"}/></dl></article>;
      })}</div><div className="hidden overflow-x-auto thin-scrollbar sm:block"><table className="w-full min-w-[1160px] border-collapse text-left"><thead><tr className="border-b border-white/[.07] text-[11px] uppercase tracking-[.08em] text-[var(--muted)]"><Th>Asset</Th><Th>Side</Th><Th>Открыта · MSK</Th><Th>В позиции</Th><Th align="right">Notional</Th><Th align="right">Margin</Th><Th align="right">Entry</Th><Th align="right">Mark</Th><Th align="right">Liq.</Th><Th align="right">Lev.</Th><Th align="right">Open P&L</Th></tr></thead><tbody>{positions.map((position) => {
        const mark = position.size ? position.entryPx + position.unrealizedPnl / position.size : position.entryPx;
        const market = marketIdentity(position.coin);
        return <tr key={position.coin} className="border-b border-white/[.055] last:border-0"><Td><Link href={`/coin/${encodeURIComponent(position.coin)}`} className="font-semibold hover:text-[var(--cyan)]">{market.symbol}</Link><small className="mt-1 block text-[9px] text-[var(--muted)]">{market.venue}</small></Td><Td><span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${position.size >= 0 ? "bg-[#62ddd818] text-[var(--cyan)]" : "bg-[#ff668a18] text-[var(--loss)]"}`}>{position.size >= 0 ? "LONG" : "SHORT"}</span></Td><Td><span className="whitespace-nowrap">{opened(position.openedAt)}</span><small className="mt-1 block text-[9px] text-[var(--muted)]">{position.openedAtPrecision === "reconstructed" ? "восстановлено по fill" : wallet.positionHistoryStart ? `история с ${dateTime(wallet.positionHistoryStart)}` : "история недоступна"}</small></Td><Td><span className="whitespace-nowrap">{held(position.openedAt)}</span></Td><Td align="right">{money(Math.abs(position.positionValue), true)}</Td><Td align="right">{money(Math.abs(position.positionValue) / Math.max(1, position.leverage), true)}</Td><Td align="right">{money(position.entryPx)}</Td><Td align="right">{money(mark)}</Td><Td align="right">{position.liquidationPx ? money(position.liquidationPx) : "—"}</Td><Td align="right"><span className="text-[var(--warn)]">{position.leverage}×</span></Td><Td align="right"><span className={position.unrealizedPnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{position.unrealizedPnl >= 0 ? "+" : ""}{money(position.unrealizedPnl, true)}</span></Td></tr>;
      })}</tbody></table></div></> : <Empty text="У этого кошелька сейчас нет открытых позиций."/>}
    </section>

    {wallet.spotBalances.length > 0 && <section className="mt-4 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]"><SectionHead title="Spot-балансы" note={`${wallet.spotBalances.length} активов в spot-кошельке`}/><div className="grid divide-y divide-[var(--line)] sm:grid-cols-2 sm:divide-y-0">{wallet.spotBalances.map((balance) => <div key={balance.coin} className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3 text-xs"><b>{balance.coin}</b><span className="mono">{balance.total.toLocaleString("en-US", { maximumFractionDigits: 6 })}{balance.hold ? <small className="ml-2 text-[var(--muted)]">locked {balance.hold.toLocaleString("en-US", { maximumFractionDigits: 6 })}</small> : null}</span></div>)}</div></section>}

    <section id="closed-positions" className="mt-4 scroll-mt-20 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <SectionHead title="Завершённые позиции" note="Частичные исполнения одной позиции объединены" action={<SortMenu name="closed" value={closedSort} options={closedSorts} state={sortState} anchor="closed-positions"/>}/>
      {completed.length ? <div className="overflow-x-auto thin-scrollbar"><table className="w-full min-w-[1120px] border-collapse text-left"><thead><tr className="border-b border-white/[.07] text-[11px] uppercase tracking-[.08em] text-[var(--muted)]"><Th>Asset</Th><Th>Side</Th><Th>Открыта · MSK</Th><Th>Закрыта · MSK</Th><Th>Длительность</Th><Th align="right">Entry</Th><Th align="right">Exit</Th><Th align="right">Size</Th><Th align="right">Realized P&L</Th></tr></thead><tbody>{completed.map((trade, index) => { const market = marketIdentity(trade.coin); return <tr key={`${trade.coin}-${trade.closedAt}-${index}`} className="border-b border-white/[.055] last:border-0"><Td><b>{market.symbol}</b><small className="mt-1 block text-[9px] text-[var(--muted)]">{market.venue}</small></Td><Td><span className={trade.direction === "LONG" ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{trade.direction}</span></Td><Td><span className="whitespace-nowrap">{trade.openedAt ? dateTime(trade.openedAt) : "Точное время неизвестно"}</span></Td><Td><span className="whitespace-nowrap">{dateTime(trade.closedAt)}</span></Td><Td>{trade.openedAt ? duration(trade.closedAt - trade.openedAt) : "—"}</Td><Td align="right">{trade.entryPx ? money(trade.entryPx) : "—"}</Td><Td align="right">{money(trade.exitPx)}</Td><Td align="right">{trade.size.toLocaleString("en-US", { maximumFractionDigits: 6 })}</Td><Td align="right"><span className={trade.netPnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{trade.netPnl >= 0 ? "+" : ""}{money(trade.netPnl)}</span></Td></tr>; })}</tbody></table></div> : <Empty text="В доступной истории нет полностью закрытых позиций."/>}
    </section>

    <section id="fills" className="mt-4 scroll-mt-20 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <SectionHead title="Последние исполнения" note="Точная хронология каждого fill с временем до секунды" action={<SortMenu name="fills" value={fillSort} options={fillSorts} state={sortState} anchor="fills"/>}/>
      <div className="overflow-x-auto thin-scrollbar"><table className="w-full min-w-[1040px] border-collapse text-left"><thead><tr className="border-b border-white/[.07] text-[11px] uppercase tracking-[.08em] text-[var(--muted)]"><Th>Asset</Th><Th>Action</Th><Th align="right">Size</Th><Th align="right">Price</Th><Th align="right">Time, MSK</Th><Th>Trust</Th><Th align="right">Realized P&L</Th></tr></thead><tbody>{fills.slice(0, 50).map((fill, index) => { const pnl = netClosedPnl(fill); const market = marketIdentity(fill.coin); return <tr key={`${fill.hash}-${index}`} className="border-b border-white/[.055] last:border-0"><Td><Link href={`/coin/${encodeURIComponent(fill.coin)}`} className="font-semibold hover:text-[var(--cyan)]">{market.symbol}</Link><small className="mt-1 block text-[9px] text-[var(--muted)]">{market.venue}</small></Td><Td><span className="text-[var(--muted)]">{fill.dir}</span></Td><Td align="right">{Number(fill.sz).toLocaleString("en-US", { maximumFractionDigits: 6 })}</Td><Td align="right">{money(Number(fill.px))}</Td><Td align="right"><span className="whitespace-nowrap">{dateTime(fill.time)}</span></Td><Td><a href={`https://app.hyperliquid.xyz/explorer/tx/${fill.hash}`} target="_blank" rel="noreferrer" className="text-[10px] text-[var(--cyan)] hover:underline">Exact · source ↗</a></Td><Td align="right">{Number(fill.closedPnl) !== 0 ? <span className={pnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{pnl >= 0 ? "+" : ""}{money(pnl)}</span> : "—"}</Td></tr>; })}</tbody></table></div>
    </section>

    <section className="mt-4 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]"><SectionHead title="Собственный журнал событий" note={`${wallet.journal.length} сохранённых событий · fills, изменения позиции, ордера, funding`}/>{wallet.journal.length ? <div className="overflow-x-auto thin-scrollbar"><table className="w-full min-w-[920px]"><thead><tr className="border-b border-[var(--line)] text-left text-[10px] uppercase tracking-[.08em] text-[var(--muted)]"><Th>Time</Th><Th>Asset</Th><Th>Event</Th><Th>Position</Th><Th align="right">Notional</Th><Th>Data</Th></tr></thead><tbody>{wallet.journal.slice(0, 60).map((event) => <tr key={event.eventKey} className="border-b border-[var(--line)] last:border-0"><Td>{dateTime(event.time)}</Td><Td><Link href={`/coin/${encodeURIComponent(event.coin)}`} className="font-semibold hover:text-[var(--cyan)]">{event.coin}</Link></Td><Td><span className={event.direction === "LONG" ? "text-[var(--cyan)]" : event.direction === "SHORT" ? "text-[var(--loss)]" : "text-white"}>{event.action} {event.direction}</span></Td><Td>{event.beforeSize === undefined ? "—" : `${event.beforeSize.toLocaleString("en-US", { maximumFractionDigits: 6 })} → ${event.afterSize?.toLocaleString("en-US", { maximumFractionDigits: 6 }) ?? "?"}`}</Td><Td align="right">{event.notional ? money(event.notional, true) : event.realizedPnl ? money(event.realizedPnl) : "—"}</Td><Td><span className="text-[10px] text-[var(--muted)]">{event.precision} · {event.source}</span></Td></tr>)}</tbody></table></div> : <Empty text="Журнал начнёт пополняться при первом точном событии."/>}</section>
    <p className="mt-5 px-2 text-xs leading-5 text-[var(--muted)]">* Время открытия восстанавливается по startPosition из доступной истории fills. Общая граница истории{wallet.positionHistoryStart ? ` — ${dateTime(wallet.positionHistoryStart)} MSK` : " недоступна"}; она не является временем открытия конкретной позиции. Если открытие восстановить нельзя, Deep Current прямо показывает «Точное время неизвестно». Это аналитика, а не торговая рекомендация.</p>
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
  return <div className="min-w-0"><dt className="text-[10px] text-[var(--muted)]">{label}</dt><dd className="mono mt-1 break-words text-xs leading-4 text-white">{value}</dd></div>;
}

function CopyStat({ label, value }: { label: string; value: string }) { return <div><dt className="text-[10px] text-[var(--muted)]">{label}</dt><dd className="mono mt-1 text-xs text-white">{value}</dd></div>; }
function TrustRow({ label, value, tone }: { label: string; value: string; tone?: "gain" }) { return <div className="grid grid-cols-[105px_1fr] gap-3 border-b border-[var(--line)] py-2.5 last:border-0"><dt className="text-[var(--muted)]">{label}</dt><dd className={`mono text-[11px] leading-4 ${tone === "gain" ? "text-[var(--cyan)]" : "text-white"}`}>{value}</dd></div>; }

function SectionHead({ title, note, action }: { title: string; note: string; action?: React.ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[.07] px-4 py-4 sm:px-6"><div><h2 className="font-semibold">{title}</h2><p className="mt-1 text-xs leading-5 text-[var(--muted)]">{note}</p></div>{action}</div>;
}

function SortMenu<T extends string>({ name, value, options, state, anchor }: { name: "open" | "closed" | "fills"; value: T; options: { value: T; label: string }[]; state: { open: PositionSort; closed: ClosedSort; fills: FillSort }; anchor: string }) {
  const selected = options.find((option) => option.value === value)?.label ?? "Сортировка";
  return <details className="relative"><summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-[var(--line)] bg-white/[.025] px-3 text-xs text-[var(--muted)] hover:text-white">{selected}<span aria-hidden="true">↕</span></summary><div className="absolute left-0 z-20 mt-1 min-w-56 overflow-hidden rounded-lg border border-[var(--line)] bg-[#080808] p-1 shadow-2xl sm:left-auto sm:right-0">{options.map((option) => { const next = { ...state, [name]: option.value }; return <Link key={option.value} href={`?open=${next.open}&closed=${next.closed}&fills=${next.fills}#${anchor}`} scroll={false} className={`block rounded-md px-3 py-2 text-xs hover:bg-white/[.05] ${option.value === value ? "text-[var(--cyan)]" : "text-[var(--muted)]"}`}>{option.label}</Link>; })}</div></details>;
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
