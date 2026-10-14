"use client";
import Link from "next/link";
import { useState } from "react";
import { marketIdentity } from "@/lib/live";
import { filterPositions, sortPositions, type PositionSort } from "@/lib/wallet-sort";
import { walletMoney as money, walletPrice as price, walletTime as time, walletDuration as duration } from "@/lib/wallet-format";
import type { Position } from "@/lib/hyperliquid";
import { useWalletSnapshot } from "./wallet-live-refresh";
import { walletText } from "@/lib/wallet-language";
import type { UserLanguage } from "@/lib/user-preferences";
import { dataFresh, marketNumber } from "@/lib/data-freshness";

const sorts: [PositionSort, string][] = [["time-desc", "Открыты недавно"], ["time-asc", "Открыты давно"], ["duration-desc", "Сначала долгие"], ["duration-asc", "Сначала короткие"], ["notional-desc", "Размер USD: больше"], ["notional-asc", "Размер USD: меньше"], ["pnl-desc", "P&L: больше"], ["pnl-asc", "P&L: меньше"], ["roi-desc", "ROI: больше"], ["roi-asc", "ROI: меньше"], ["entry-desc", "Цена входа: выше"], ["entry-asc", "Цена входа: ниже"]];
const quantity = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 8 });
function metrics(p: Position, now: number, language: UserLanguage) {
  const t = (value: string) => walletText(language, value);
  const symbol = marketIdentity(p.coin).symbol;
  return [[t("Открыта · MSK"), p.openedAt === null ? t("Время неизвестно") : time(p.openedAt, language)], [t("В позиции"), p.openedAt === null ? t("Неполная история") : duration(now - p.openedAt, language)],
    [t("Последнее изменение · MSK"), p.lastChangedAt == null ? t("Неизвестно") : time(p.lastChangedAt, language)], [t("Первое исполнение / сейчас"), `${quantity(p.initialSize)} / ${quantity(p.size)} ${symbol}`],
    [t("Размер позиции, USD"), money(Math.abs(marketNumber(p.positionValue)), true)], [t("Маржа, USD"), money(p.marginUsed ?? null, true)],
    [t("Средний вход"), price(p.entryPx)], ["Mark Price", price(marketNumber(p.entryPx) + marketNumber(p.unrealizedPnl) / p.size)], ["P&L", money(p.unrealizedPnl, true)],
    [t("ROI по марже"), p.marginUsed && p.marginUsed > 0 && Number.isFinite(p.unrealizedPnl) ? `${(p.unrealizedPnl / p.marginUsed * 100).toFixed(2)}%` : "—"], [t("Плечо"), Number.isFinite(p.leverage) ? `${p.leverage}×` : "—"], [t("Ликвидация"), price(p.liquidationPx)], [t("Последнее действие"), p.lastAction ?? t("Неизвестно")]];
}
function Evidence({ position: p }: { position: Position }) {
  const { language } = useWalletSnapshot(); const t = (value: string) => walletText(language, value);
  return <p className="break-words text-xs text-[var(--muted)]">{p.reason ? t(p.reason) : t("Открытие восстановлено по связной истории")}<br/>{p.source ?? t("Источник неизвестен")}<br/>{p.updatedAt ? time(p.updatedAt, language) : t("Нет снимка")}</p>;
}
export function WalletPositions({ initialSort }: { initialSort: PositionSort }) {
  const { snapshot, now, language, healthy } = useWalletSnapshot(); const t = (value: string) => walletText(language, value); const [sort, setSort] = useState(initialSort);
  const [filters, setFilters] = useState({ coin: "", side: "all", source: "all", action: "all", exactOnly: false });
  const positions = sortPositions(filterPositions(snapshot.positions, filters), sort); const stale = snapshot.unavailableScopes.length > 0 || !dataFresh(snapshot.updatedAt, now, 30_000);
  return <section id="open-positions" className="mt-4 scroll-mt-20 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
    <header className="border-b border-[var(--line)] p-4"><h2 className="font-semibold">{t("Открытые позиции")}</h2><p className="mt-1 text-xs text-[var(--muted)]">{positions.length} {t("из")} {snapshot.positions.length} · {!healthy ? t("Сборщик не подтверждён · показан сохранённый снимок") : stale ? t("есть устаревшие данные") : t("сверка каждые 10 секунд")} · {t("обновлено")} {snapshot.updatedAt ? time(snapshot.updatedAt, language) : t("ожидается")}</p></header>
    <div className="grid grid-cols-2 gap-2 border-b border-[var(--line)] p-3 lg:grid-cols-6">
      <label className="text-xs text-[var(--muted)]">{t("Монета")}<input value={filters.coin} placeholder="BTC, xyz:…" onChange={(e) => setFilters({ ...filters, coin: e.target.value })} className="control-field mt-1 w-full"/></label>
      <label className="text-xs text-[var(--muted)]">{t("Направление")}<select value={filters.side} onChange={(e) => setFilters({ ...filters, side: e.target.value })} className="control-field mt-1 w-full"><option value="all">{t("Все")}</option><option>LONG</option><option>SHORT</option></select></label>
      <label className="text-xs text-[var(--muted)]">{t("Последнее действие")}<select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} className="control-field mt-1 w-full"><option value="all">{t("Все")}</option>{["OPEN", "ADD", "REDUCE", "CLOSE", "FLIP"].map((action) => <option key={action}>{action}</option>)}</select></label>
      <label className="text-xs text-[var(--muted)]">{t("Источник")}<select value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })} className="control-field mt-1 w-full"><option value="all">{t("Все")}</option>{[...new Set(snapshot.positions.map((p) => p.source).filter(Boolean))].map((source) => <option key={source}>{source}</option>)}</select></label>
      <label className="text-xs text-[var(--muted)]">{t("Сортировка")}<select value={sort} onChange={(e) => setSort(e.target.value as PositionSort)} className="control-field mt-1 w-full">{sorts.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
      <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={filters.exactOnly} onChange={(e) => setFilters({ ...filters, exactOnly: e.target.checked })}/>{t("С подтверждённым открытием")}</label>
    </div>
    <p className="border-b border-[var(--line)] px-4 py-2 text-xs text-[var(--muted)]">{t("Первый размер — первое доказанное исполнение, не вся заявка. ROI = P&L / маржа. Закрытия — в истории ниже.")}</p>
    {positions.length ? <><div className="divide-y divide-[var(--line)] md:hidden">{positions.map((p) => <article key={p.coin} className="p-4"><div className="flex items-start justify-between gap-3"><div><Link href={`/coin/${encodeURIComponent(p.coin)}`} className="text-lg font-semibold hover:text-[var(--cyan)]">{marketIdentity(p.coin).symbol}</Link><span className={`side-badge ml-2 ${p.size > 0 ? "gain" : "loss"}`}>{p.size > 0 ? "LONG" : "SHORT"}</span><p className="mt-1 text-xs text-[var(--muted)]">{marketIdentity(p.coin).venue}</p></div><p className={`mono text-sm ${p.unrealizedPnl >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]"}`}>{money(p.unrealizedPnl, true)}</p></div><dl className="my-4 grid grid-cols-2 gap-3 text-xs">{metrics(p, now, language).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[var(--muted)]">{label}</dt><dd className="mono mt-1 break-words">{value}</dd></div>)}</dl><Evidence position={p}/></article>)}</div>
    <div className="hidden overflow-x-auto thin-scrollbar md:block"><table className="w-full min-w-[1750px] text-left text-xs"><thead><tr className="border-b border-[var(--line)] text-[var(--muted)]">{[t("Монета / Side"), ...metrics(positions[0], now, language).map(([label]) => label), t("Точность / источник / обновление")].map((label) => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{positions.map((p) => <tr key={p.coin} className="border-b border-[var(--line)] last:border-0"><td className="px-3 py-3"><Link href={`/coin/${encodeURIComponent(p.coin)}`} className="font-semibold hover:text-[var(--cyan)]">{marketIdentity(p.coin).symbol}</Link><span className={`side-badge mt-1 ${p.size > 0 ? "gain" : "loss"}`}>{p.size > 0 ? "LONG" : "SHORT"}</span></td>{metrics(p, now, language).map(([label, value]) => <td key={label} className="mono whitespace-nowrap px-3 py-3">{value}</td>)}<td className="min-w-64 px-3 py-3"><Evidence position={p}/></td></tr>)}</tbody></table></div></>
    : <p className="p-6 text-sm text-[var(--muted)]">{snapshot.pending ? t("Сервер загружает позиции. Обновление произойдёт автоматически.") : snapshot.positions.length ? t("Нет позиций по выбранным фильтрам. Измените условия.") : stale ? t("Часть рынков не проверена; отсутствие позиций не подтверждено.") : t("В последнем полном снимке открытых позиций нет.")}</p>}
  </section>;
}
