"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminConfig } from "@/lib/admin-config";

type User = { id: string; firstName: string; lastName: string; username: string; isAdmin: boolean; firstSeen: number; lastSeen: number; visits: number };
type Snapshot = { users: User[]; config: AdminConfig; updatedAt: number };

const download = (name: string, content: string) => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
};

export function AdminPanel({ initData, liveWallets, exactLiveWallets, marketCoverage, live, events, updatedAt }: {
  initData: string;
  liveWallets: number;
  exactLiveWallets: number;
  marketCoverage: number;
  live: boolean;
  events: number;
  updatedAt: number;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"all" | "admin" | "user">("all");
  const [sort, setSort] = useState<"recent" | "visits" | "name">("recent");
  const headers = { "content-type": "application/json", "x-telegram-init-data": initData };
  const load = useCallback(async () => {
    const response = await fetch("/api/admin", { headers: { "x-telegram-init-data": initData }, cache: "no-store" });
    if (!response.ok) throw new Error("Админ-данные недоступны");
    setSnapshot(await response.json() as Snapshot);
  }, [initData]);

  useEffect(() => { queueMicrotask(() => load().catch((reason: Error) => setError(reason.message))); }, [load]);

  const update = async (body: Record<string, unknown>, key: string) => {
    setBusy(key); setError("");
    try {
      const response = await fetch("/api/admin", { method: "POST", headers, body: JSON.stringify(body) });
      const payload = await response.json() as Snapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error === "SELF_DEMOTION" ? "Нельзя снять роль с самого себя" : "Изменение не сохранено");
      setSnapshot(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка запроса"); }
    finally { setBusy(""); }
  };

  const users = useMemo(() => (snapshot?.users ?? []).filter((user) => {
    const matches = `${user.firstName} ${user.lastName} ${user.username} ${user.id}`.toLowerCase().includes(query.toLowerCase());
    return matches && (role === "all" || (role === "admin" ? user.isAdmin : !user.isAdmin));
  }).sort((a, b) => sort === "visits" ? b.visits - a.visits : sort === "name" ? `${a.firstName}${a.lastName}`.localeCompare(`${b.firstName}${b.lastName}`) : b.lastSeen - a.lastSeen), [snapshot, query, role, sort]);
  const now = snapshot?.updatedAt ?? updatedAt;
  const activeToday = snapshot?.users.filter((user) => now - user.lastSeen < 86_400_000).length ?? 0;
  const newThisWeek = snapshot?.users.filter((user) => now - user.firstSeen < 7 * 86_400_000).length ?? 0;

  if (!snapshot && !error) return <div className="surface h-96 animate-pulse bg-white/[.025]"/>;

  const setConfig = (key: keyof AdminConfig, value: number) => update({ action: "setConfig", key, value }, key);
  const exportUsers = () => download("dc-pulse-users.csv", ["id,name,username,role,visits,first_seen,last_seen", ...(snapshot?.users ?? []).map((user) => [user.id, `${user.firstName} ${user.lastName}`.trim(), user.username, user.isAdmin ? "admin" : "user", user.visits, new Date(user.firstSeen).toISOString(), new Date(user.lastSeen).toISOString()].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\n"));

  return <div className="space-y-4">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-xl font-semibold">Админ-панель</h1><p className="mt-1 text-xs text-[var(--muted)]">Пользователи, роли и состояние конвейера данных</p></div>
      <div className="flex gap-2"><button onClick={exportUsers} className="compact-action border border-[var(--line)]">Экспорт CSV</button><button onClick={() => load().catch((reason: Error) => setError(reason.message))} className="compact-action border border-[var(--line)]">Обновить</button></div>
    </header>
    {error && <div role="alert" className="border border-[#ff688855] bg-[#ff68880b] px-4 py-3 text-xs text-[var(--loss)]">{error}</div>}
    <section className="surface overflow-hidden">
      <div className="grid grid-cols-2 border-b border-[var(--line)] sm:grid-cols-4 xl:grid-cols-8">
        <Metric label="Пользователи" value={String(snapshot?.users.length ?? 0)}/><Metric label="Админы" value={String(snapshot?.users.filter((user) => user.isAdmin).length ?? 0)}/><Metric label="Активны 24H" value={String(activeToday)}/><Metric label="Новые 7D" value={String(newThisWeek)}/><Metric label="Live wallets" value={String(liveWallets)} accent/><Metric label="Exact events" value={String(exactLiveWallets)}/><Metric label="Рынки" value={String(marketCoverage)}/><Metric label="События" value={String(events)}/>
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="border-b border-[var(--line)] lg:border-b-0 lg:border-r">
          <SectionHead title="Пользователи и роли" note={`${users.length} из ${snapshot?.users.length ?? 0} пользователей`}/>
          <div className="grid gap-2 border-b border-[var(--line)] p-3 sm:grid-cols-[minmax(0,1fr)_120px_130px]">
            <input aria-label="Поиск пользователя" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Имя, username или ID" className="control-field"/>
            <select aria-label="Фильтр роли" value={role} onChange={(event) => setRole(event.target.value as typeof role)} className="control-field"><option value="all">Все роли</option><option value="admin">Админы</option><option value="user">Пользователи</option></select>
            <select aria-label="Сортировка пользователей" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="control-field"><option value="recent">Недавние</option><option value="visits">По визитам</option><option value="name">По имени</option></select>
          </div>
          {users.length ? <div className="divide-y divide-[var(--line)]">{users.map((user) => <div key={user.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_70px_90px_auto] sm:items-center"><button onClick={() => navigator.clipboard.writeText(user.id)} title="Скопировать Telegram ID" className="min-w-0 text-left"><p className="truncate text-sm font-medium">{[user.firstName, user.lastName].filter(Boolean).join(" ") || `User ${user.id}`}</p><p className="mono mt-0.5 truncate text-[10px] text-[var(--muted)]">{user.username ? `@${user.username}` : user.id}</p></button><div><p className="text-[9px] uppercase text-[var(--muted)]">Визиты</p><p className="mono mt-1 text-xs">{user.visits}</p></div><div><p className="text-[9px] uppercase text-[var(--muted)]">Последний вход</p><p className="mono mt-1 text-[10px]">{relative(user.lastSeen)}</p></div><button disabled={busy === user.id} onClick={() => update({ action: "setAdmin", userId: user.id, isAdmin: !user.isAdmin }, user.id)} className={`h-9 rounded-md border px-3 text-[10px] font-medium transition-colors disabled:cursor-wait disabled:opacity-50 ${user.isAdmin ? "border-[#5ee3dc44] bg-[#5ee3dc0c] text-[var(--cyan)]" : "border-[var(--line)] text-[var(--muted)] hover:text-white"}`}>{user.isAdmin ? "Администратор" : "Назначить"}</button></div>)}</div> : <p className="px-4 py-12 text-center text-xs text-[var(--muted)]">По текущим фильтрам пользователей нет.</p>}
        </div>
        <aside>
          <SectionHead title="Парсер" note="Лимиты и фактическое состояние"/>
          <div className="space-y-4 p-4">
            <ConfigSelect label="Размер рейтинга" value={snapshot?.config.trackedWallets ?? 1_000} disabled={Boolean(busy)} onChange={(value) => setConfig("trackedWallets", value)} options={[[100, "100"], [300, "300"], [500, "500"], [750, "750"], [1000, "1000"]]}/>
            <ConfigSelect label="Минимум сигнала" value={snapshot?.config.signalThreshold ?? 5000} disabled={Boolean(busy)} onChange={(value) => setConfig("signalThreshold", value)} options={[[1000, "$1K"], [5000, "$5K"], [10000, "$10K"], [25000, "$25K"], [50000, "$50K"]]}/>
            <ConfigSelect label="Live-рынки" value={snapshot?.config.liveMarkets ?? 900} disabled={Boolean(busy)} onChange={(value) => setConfig("liveMarkets", value)} options={[[100, "100"], [300, "300"], [600, "600"], [900, "Все доступные"]]}/>
            <ConfigSelect label="Окно совпадений" value={snapshot?.config.confluenceMinutes ?? 30} disabled={Boolean(busy)} onChange={(value) => setConfig("confluenceMinutes", value)} options={[[5, "5 мин"], [15, "15 мин"], [30, "30 мин"], [60, "60 мин"], [120, "120 мин"]]}/>
            <p className="text-[10px] leading-4 text-[var(--muted)]">Все кошельки отслеживаются через публичные market trades. Для {exactLiveWallets} самых активных дополнительно доступны точные Open/Close и PnL — это лимит API на один IP. Настройки применяются после обновления.</p>
            <dl className="space-y-3 border-t border-[var(--line)] pt-4"><Row label="WebSocket" value={live ? "Подключён" : "Переподключение"} tone={live ? "gain" : "loss"}/><Row label="Leaderboard" value="Hyperliquid"/><Row label="Цены" value="allMids live"/><Row label="Сделки" value="userFills + trades"/><Row label="Обновлено" value={new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(updatedAt)}/></dl>
            <button onClick={() => location.reload()} className="h-10 w-full rounded-md bg-[var(--cyan)] text-xs font-semibold text-[#041110] transition-opacity hover:opacity-90">Применить и обновить</button>
          </div>
        </aside>
      </div>
    </section>
  </div>;
}

const relative = (time: number) => { const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000)); return minutes < 1 ? "сейчас" : minutes < 60 ? `${minutes} мин` : `${Math.round(minutes / 60)} ч`; };
function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) { return <div className="border-b border-r border-[var(--line)] px-4 py-3"><p className="text-[9px] uppercase tracking-[.06em] text-[var(--muted)]">{label}</p><p className={`mono mt-1 text-base font-semibold ${accent ? "text-[var(--cyan)]" : "text-white"}`}>{value}</p></div>; }
function SectionHead({ title, note }: { title: string; note: string }) { return <div className="border-b border-[var(--line)] px-4 py-3"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-[10px] text-[var(--muted)]">{note}</p></div>; }
function Row({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) { return <div className="flex items-center justify-between gap-3"><dt className="text-[11px] text-[var(--muted)]">{label}</dt><dd className={`mono text-[11px] ${tone === "gain" ? "text-[var(--cyan)]" : tone === "loss" ? "text-[var(--loss)]" : "text-white"}`}>{value}</dd></div>; }
function ConfigSelect({ label, value, disabled, onChange, options }: { label: string; value: number; disabled: boolean; onChange(value: number): void; options: [number, string][] }) { return <label className="block text-[10px] font-medium text-[var(--muted)]">{label}<select value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} className="control-field mt-2 w-full">{options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}</select></label>; }
