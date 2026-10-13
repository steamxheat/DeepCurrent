import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { walletText } from "@/lib/wallet-language";
import { computeFillStats, netClosedPnl } from "@/lib/stats";
import { getWalletDetail } from "@/lib/hyperliquid";
import { marketIdentity } from "@/lib/live";
import { PerformanceChart } from "./performance-chart";
import { WalletLiveRefresh, WalletLiveProvider, WalletLiveValue, RefreshWalletHistory } from "./wallet-live-refresh";
import { WalletPositions } from "./wallet-positions";
import { WalletEvents } from "./wallet-events";
import { readWalletSnapshot } from "@/lib/wallet-snapshot";
import { walletMoney as money, walletPrice as price, walletTime, walletDuration } from "@/lib/wallet-format";
import { sortClosedTrades, sortFills, type ClosedSort, type FillSort, type PositionSort } from "@/lib/wallet-sort";

const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;

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
  const language = (await cookies()).get("deep_current_language")?.value === "en" ? "en" : "ru";
  const t = (value: string) => walletText(language, value);
  const dateTime = (value: number) => walletTime(value, language);
  const duration = (value: number) => walletDuration(value, language);
  const { address } = await params;
  const query = await searchParams;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) notFound();
  const wallet = await getWalletDetail(address);
  const stats = computeFillStats(wallet.fills);
  const monthPnl = wallet.portfolio.month.pnl.at(-1)?.[1] ?? NaN;
  const openSort = allowed(one(query.open), positionSorts, "notional-desc");
  const closedSort = allowed(one(query.closed), closedSorts, "time-desc");
  const fillSort = allowed(one(query.fills), fillSorts, "time-desc");
  const completed = sortClosedTrades(wallet.closedTrades, closedSort).slice(0, 50);
  const fills = sortFills(wallet.fills, fillSort);
  const sortState = { open: openSort, closed: closedSort, fills: fillSort };
  const verdict = wallet.copyability.verdict === "copyable" ? t("Можно копировать") : wallet.copyability.verdict === "observe" ? t("Только наблюдать") : t("Не копируется");
  const hold = (value: number | null) => value === null ? "—" : duration(value);

  return <WalletLiveProvider key={wallet.address} language={language} initial={readWalletSnapshot(wallet.address)}><main lang={language} className="mx-auto min-h-dvh w-full max-w-[1540px] px-3 py-3 pb-12 sm:px-6 sm:py-6">
    <header className="mb-4 flex items-center justify-between px-1">
      <Link href="/" aria-label={t("Вернуться в Deep Current")} className="inline-flex min-h-11 items-center gap-2.5 rounded-lg pr-3 text-sm text-[var(--muted)] transition-colors hover:bg-white/[.04] hover:text-white">
        <span className="flex size-11 items-center justify-center" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m15 18-6-6 6-6"/></svg></span>
        <span className="relative size-9 shrink-0 overflow-hidden rounded-lg border border-white/[.08] bg-[#02060c]"><Image src="/dc-pulse-mark.png" fill sizes="36px" alt="" className="object-cover" priority/></span>
        <span className="hidden font-medium text-white sm:inline">Deep Current</span>
      </Link>
      <WalletLiveRefresh/>
    </header>

    <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <div className="flex flex-col gap-5 border-b border-white/[.07] p-5 sm:p-7 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0"><h1 className="text-xl font-semibold tracking-[-.025em] sm:text-2xl">Wallet <span className="mono text-[var(--muted)]">{short(wallet.address)}</span></h1><p className="mono mt-2 truncate text-xs text-[var(--muted)]" title={wallet.address}>{wallet.address}</p><div className="mt-4 flex flex-wrap items-center gap-2"><Chip label="Account" value={<WalletLiveValue field="accountValue"/>}/><Chip label="30D PnL" value={`${monthPnl >= 0 ? "+" : ""}${money(monthPnl, true)}`} tone={monthPnl >= 0 ? "gain" : "loss"}/><Chip label="Win rate*" value={stats.closed ? `${stats.winRate.toFixed(1)}%` : "—"}/><Chip label="Bias" value={<WalletLiveValue field="bias"/>}/></div></div>
        <a href={`https://app.hyperliquid.xyz/explorer/address/${wallet.address}`} target="_blank" rel="noreferrer" className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-[var(--line)] bg-white/[.025] px-3 text-xs font-medium transition-colors hover:border-[#62ddd866] hover:text-[var(--cyan)]">{t("Открыть в Explorer")}<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 5h5v5M10 14 19 5M19 14v5H5V5h5"/></svg></a>
      </div>

      <div className="grid xl:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="order-2 border-t border-white/[.07] xl:order-1 xl:border-b-0 xl:border-r xl:border-t-0">
          <div className="border-b border-white/[.07] px-5 py-4"><h2 className="font-semibold">Wallet stats</h2><p className="mt-1 text-xs text-[var(--muted)]">{t("Снимок текущего состояния")}</p></div>
          <StatSection title={t("Капитал")}><StatRow label="Account value" value={<WalletLiveValue field="accountValue"/>}/><StatRow label="Position value" value={<WalletLiveValue field="positionValue"/>}/><StatRow label="Margin in use" value={<WalletLiveValue field="totalMarginUsed"/>}/><StatRow label="Withdrawable" value={<WalletLiveValue field="withdrawable"/>}/><StatRow label="Positions P&L" value={<WalletLiveValue field="openPnl"/>}/></StatSection>
          <StatSection title={t("Риск и история")}><StatRow label="Margin / account" value={<WalletLiveValue field="risk"/>}/><StatRow label="Profit factor*" value={Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞"}/><StatRow label="Closed fills*" value={stats.closed.toLocaleString("en-US")}/><StatRow label="30D volume" value={money(wallet.portfolio.month.volume, true)}/></StatSection>
        </aside>
        <div className="order-1 min-w-0 p-2 sm:p-4 lg:p-5 xl:order-2"><PerformanceChart language={language} portfolio={wallet.portfolio} fills={wallet.fills.slice(0, 2_000)}/><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className="text-[10px] text-[var(--muted)]">{t("Позиции и суммы обновляются автоматически; график и история — по запросу.")}</p><RefreshWalletHistory/></div></div>
      </div>
    </section>

    <section className="mt-4 grid overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)] lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
      <div className="border-b border-[var(--line)] lg:border-b-0 lg:border-r">
        <SectionHead title="Copyability Score" note={t("Можно ли повторить результат после задержки, проскальзывания и комиссий")}/>
        <div className="grid grid-cols-[110px_1fr] gap-4 p-5 sm:grid-cols-[140px_1fr]">
          <div><p className={`mono text-4xl font-semibold ${wallet.copyability.score >= 70 ? "text-[var(--cyan)]" : wallet.copyability.score >= 45 ? "text-[var(--warn)]" : "text-[var(--loss)]"}`}>{wallet.copyability.score}</p><p className="mt-1 text-xs font-medium">{verdict}</p><p className="mt-1 text-[10px] text-[var(--muted)]">confidence: {wallet.copyability.confidence}</p></div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-3"><CopyStat label={t("Среднее удержание")} value={hold(wallet.copyability.averageHoldMs)}/><CopyStat label={t("Медиана")} value={hold(wallet.copyability.medianHoldMs)}/><CopyStat label="Maker" value={wallet.copyability.makerShare === null ? "—" : `${wallet.copyability.makerShare.toFixed(1)}%`}/><CopyStat label={t("Сделок / день")} value={wallet.copyability.tradesPerDay.toFixed(1)}/><CopyStat label="30D max drawdown" value={wallet.copyability.maxDrawdown === null ? "—" : `${wallet.copyability.maxDrawdown.toFixed(1)}%`}/><CopyStat label="Slippage model" value={`${wallet.copyability.estimatedSlippageBps.toFixed(1)} bps`}/></dl>
        </div>
        <div className="grid grid-cols-2 border-t border-[var(--line)] sm:grid-cols-4">{wallet.copyability.delayResults.map((row) => <div key={row.delay} className="border-b border-r border-[var(--line)] p-3 last:border-r-0 sm:border-b-0"><p className="mono text-[10px] text-[var(--muted)]">Delay {row.delay}s · {row.measured ? "measured" : "model"}</p><p className={`mono mt-1 text-sm ${row.retained >= 70 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{Number.isFinite(row.retained) ? `${row.retained.toFixed(1)}% retained` : t("Недостаточно данных")}</p><p className="mt-1 text-[9px] text-[var(--muted)]">{Number.isFinite(row.costBps) ? `${row.costBps.toFixed(1)} bps total cost` : t("Валюта комиссии не сопоставлена")}</p></div>)}</div>
      </div>
      <div><SectionHead title={t("Доверие к данным")} note={t("Происхождение и полнота текущего расчёта")}/><dl className="p-5 text-xs"><TrustRow label={t("Состояние")} value={<WalletLiveValue field="updatedAt"/>}/><TrustRow label={t("Источник")} value={<WalletLiveValue field="source"/>}/><TrustRow label="Fills" value={`${wallet.dataQuality.exactFills} ${t("точных")} · ${wallet.dataQuality.historyComplete ? "история полная" : t("до 10 000 последних")}`}/><TrustRow label={t("Журнал")} value={`${wallet.dataQuality.journalEvents} ${t("событий сохранено")}`}/><TrustRow label={t("Ордера / funding")} value={`${wallet.dataQuality.ordersCaptured} / ${wallet.dataQuality.fundingCaptured}`}/><TrustRow label={t("Открытие позиций")} value={t("Время подтверждается связной историей; иначе неизвестно")}/></dl></div>
    </section>

    <WalletPositions initialSort={openSort}/>

    {wallet.spotBalances.length > 0 && <section className="mt-4 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]"><SectionHead title={t("Spot-балансы")} note={`${wallet.spotBalances.length} ${t("активов в spot-кошельке")}`}/><div className="grid divide-y divide-[var(--line)] sm:grid-cols-2 sm:divide-y-0">{wallet.spotBalances.map((balance) => <div key={balance.coin} className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3 text-xs"><b>{balance.coin}</b><span className="mono">{balance.total.toLocaleString("en-US", { maximumFractionDigits: 6 })}{balance.hold ? <small className="ml-2 text-[var(--muted)]">locked {balance.hold.toLocaleString("en-US", { maximumFractionDigits: 6 })}</small> : null}</span></div>)}</div></section>}

    <section id="closed-positions" className="mt-4 scroll-mt-20 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <SectionHead title={t("Завершённые позиции")} note={language === "en" ? `Partial fills grouped · ${completed.length} of ${wallet.closedTrades.length} · sorted across the saved sample` : `Частичные исполнения объединены · показаны ${completed.length} из ${wallet.closedTrades.length} · сортировка по всей сохранённой выборке`} action={<SortMenu name="closed" value={closedSort} options={closedSorts.map((option) => ({ ...option, label: t(option.label) }))} state={sortState} anchor="closed-positions"/>}/>
      {completed.length > 0 && <div className="divide-y divide-[var(--line)] md:hidden">{completed.map((trade, index) => <article key={`${trade.coin}:${trade.closedAt}:${index}`} className="p-4"><div className="flex items-center justify-between gap-3"><Link className="font-semibold hover:text-[var(--cyan)]" href={`/coin/${encodeURIComponent(trade.coin)}`}>{trade.coin} · {trade.direction}</Link><span className="mono text-sm">{money(trade.netPnl)}</span></div><dl className="mt-3 grid grid-cols-2 gap-3 text-xs">{[[t("Открыта · MSK"), trade.openedAt === null ? t("Неизвестно") : dateTime(trade.openedAt)], [t("Закрыта · MSK"), dateTime(trade.closedAt)], [t("Длительность"), trade.openedAt === null ? t("Неполная история") : duration(trade.closedAt - trade.openedAt)], [t("Размер"), trade.size.toLocaleString("en-US", { maximumFractionDigits: 8 })], [t("Средний вход"), price(trade.entryPx)], [t("Средний выход"), price(trade.exitPx)]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[var(--muted)]">{label}</dt><dd className="mono mt-1 break-words">{value}</dd></div>)}</dl><p className="mt-3 text-xs text-[var(--muted)]">Журнал user fills · результат после комиссий · {trade.openedAt === null ? "начало неизвестно" : t("восстановлено по истории")}</p></article>)}</div>}
      {completed.length ? <div className="overflow-x-auto thin-scrollbar"><table className="w-full min-w-[1120px] border-collapse text-left"><thead><tr className="border-b border-white/[.07] text-[11px] uppercase tracking-[.08em] text-[var(--muted)]"><Th>Asset</Th><Th>Side</Th><Th>{t("Открыта · MSK")}</Th><Th>{t("Закрыта · MSK")}</Th><Th>{t("Длительность")}</Th><Th align="right">Entry</Th><Th align="right">Exit</Th><Th align="right">Size</Th><Th align="right">Realized P&L</Th></tr></thead><tbody>{completed.map((trade, index) => { const market = marketIdentity(trade.coin); return <tr key={`${trade.coin}-${trade.closedAt}-${index}`} className="border-b border-white/[.055] last:border-0"><Td><b>{market.symbol}</b><small className="mt-1 block text-[9px] text-[var(--muted)]">{market.venue}</small></Td><Td><span className={trade.direction === "LONG" ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{trade.direction}</span></Td><Td><span className="whitespace-nowrap">{trade.openedAt ? dateTime(trade.openedAt) : t("Точное время неизвестно")}</span></Td><Td><span className="whitespace-nowrap">{dateTime(trade.closedAt)}</span></Td><Td>{trade.openedAt ? duration(trade.closedAt - trade.openedAt) : "—"}</Td><Td align="right">{trade.entryPx ? price(trade.entryPx) : "—"}</Td><Td align="right">{price(trade.exitPx)}</Td><Td align="right">{trade.size.toLocaleString("en-US", { maximumFractionDigits: 6 })}</Td><Td align="right"><span className={trade.netPnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{trade.netPnl >= 0 ? "+" : ""}{money(trade.netPnl)}</span></Td></tr>; })}</tbody></table></div> : <Empty text={t("В доступной истории нет полностью закрытых позиций.")}/>}
    </section>

    <section id="fills" className="mt-4 scroll-mt-20 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <SectionHead title={t("Последние исполнения")} note={language === "en" ? `${Math.min(50, fills.length)} of ${fills.length} shown · sorted saved sample · latest 2000 on chart` : `Показаны ${Math.min(50, fills.length)} из ${fills.length} · сортировка по сохранённой выборке · на графике последние 2000`} action={<SortMenu name="fills" value={fillSort} options={fillSorts.map((option) => ({ ...option, label: t(option.label) }))} state={sortState} anchor="fills"/>}/>
      <div className="overflow-x-auto thin-scrollbar"><table className="w-full min-w-[1040px] border-collapse text-left"><thead><tr className="border-b border-white/[.07] text-[11px] uppercase tracking-[.08em] text-[var(--muted)]"><Th>Asset</Th><Th>Action</Th><Th align="right">Size</Th><Th align="right">Price</Th><Th align="right">Time, MSK</Th><Th>Trust</Th><Th align="right">Realized P&L</Th></tr></thead><tbody>{fills.slice(0, 50).map((fill, index) => { const pnl = netClosedPnl(fill); const market = marketIdentity(fill.coin); return <tr key={`${fill.hash}-${index}`} className="border-b border-white/[.055] last:border-0"><Td><Link href={`/coin/${encodeURIComponent(fill.coin)}`} className="font-semibold hover:text-[var(--cyan)]">{market.symbol}</Link><small className="mt-1 block text-[9px] text-[var(--muted)]">{market.venue}</small></Td><Td><span className="text-[var(--muted)]">{fill.dir}</span></Td><Td align="right">{Number(fill.sz).toLocaleString("en-US", { maximumFractionDigits: 6 })}</Td><Td align="right">{price(Number(fill.px))}</Td><Td align="right"><span className="whitespace-nowrap">{dateTime(fill.time)}</span></Td><Td><a href={`https://app.hyperliquid.xyz/explorer/tx/${fill.hash}`} target="_blank" rel="noreferrer" className="text-[10px] text-[var(--cyan)] hover:underline">Exact · source ↗</a></Td><Td align="right">{Number(fill.closedPnl) !== 0 ? <span className={pnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}>{pnl >= 0 ? "+" : ""}{money(pnl)}</span> : "—"}</Td></tr>; })}</tbody></table></div>
    </section>

    <WalletEvents address={wallet.address}/>
    <p className="mt-5 px-2 text-xs leading-5 text-[var(--muted)]">{language === "en" ? "* Opening time is reconstructed from startPosition in available fills. Unknown times are never replaced with snapshot time. History coverage is not the opening time of a specific position. Analytics, not a trading recommendation." : "* Время открытия восстанавливается по startPosition из доступной истории. Неизвестное время не заменяется временем снимка. Граница истории — не время открытия конкретной позиции. Это аналитика, а не торговая рекомендация."}</p>
  </main></WalletLiveProvider>;
}

function WalletSkeleton() {
  return <main className="mx-auto min-h-dvh w-full max-w-[1540px] animate-pulse px-4 py-6"><div className="mb-5 h-12 w-44 rounded-xl bg-white/[.05]"/><div className="h-[660px] rounded-[26px] bg-white/[.05]"/><div className="mt-5 h-72 rounded-[24px] bg-white/[.05]"/></main>;
}

function Chip({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "gain" | "loss" }) {
  return <span className="rounded-full border border-white/[.08] bg-white/[.035] px-3 py-1.5 text-xs text-[var(--muted)]">{label} <b className={`mono ml-1 font-medium ${tone === "gain" ? "text-[var(--cyan)]" : tone === "loss" ? "text-[var(--loss)]" : "text-white"}`}>{value}</b></span>;
}

function StatSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="border-b border-white/[.07] px-5 py-5 last:border-0"><h3 className="mb-3 text-xs font-medium text-[var(--muted)]">{title}</h3><dl className="space-y-3">{children}</dl></div>;
}

function StatRow({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "gain" | "loss" }) {
  return <div className="flex items-center justify-between gap-3"><dt className="text-xs text-[var(--muted)]">{label}</dt><dd className={`mono text-xs font-medium ${tone === "gain" ? "text-[var(--cyan)]" : tone === "loss" ? "text-[var(--loss)]" : "text-white"}`}>{value}</dd></div>;
}


function CopyStat({ label, value }: { label: string; value: string }) { return <div><dt className="text-[10px] text-[var(--muted)]">{label}</dt><dd className="mono mt-1 text-xs text-white">{value}</dd></div>; }
function TrustRow({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "gain" }) { return <div className="grid grid-cols-[105px_1fr] gap-3 border-b border-[var(--line)] py-2.5 last:border-0"><dt className="text-[var(--muted)]">{label}</dt><dd className={`mono text-[11px] leading-4 ${tone === "gain" ? "text-[var(--cyan)]" : "text-white"}`}>{value}</dd></div>; }

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
