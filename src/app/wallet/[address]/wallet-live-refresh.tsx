"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { WalletSnapshot } from "@/lib/wallet-snapshot";
import { walletMoney, walletTime } from "@/lib/wallet-format";
import type { UserLanguage } from "@/lib/user-preferences";
import { walletText } from "@/lib/wallet-language";
import { dataFresh, marketNumber } from "@/lib/data-freshness";

const LiveWallet = createContext<{ snapshot: WalletSnapshot; healthy: boolean; now: number; language: UserLanguage } | null>(null);
export function useWalletSnapshot() {
  const value = useContext(LiveWallet);
  if (!value) throw new Error("Wallet live provider missing");
  return value;
}

export function WalletLiveProvider({ initial, children, language = "ru" }: { initial: WalletSnapshot; children: ReactNode; language?: UserLanguage }) {
  const [snapshot, setSnapshot] = useState(initial); const [healthy, setHealthy] = useState(false);
  const [now, setNow] = useState(initial.updatedAt);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    let stopped = false; let pending = false; const abort = new AbortController();
    const update = async () => {
      if (document.visibilityState !== "visible" || pending) return;
      pending = true;
      try {
        const response = await fetch(`/api/wallet/${initial.address}/watch`, { method: "POST", signal: abort.signal });
        if (!response.ok) throw new Error("Wallet refresh unavailable");
        const status = await response.json();
        if (stopped) return;
        setSnapshot(status.snapshot); setHealthy(status.healthy && !status.stale && !status.pending);
      } catch { if (!stopped) setHealthy(false); }
      finally { pending = false; }
    };
    void update(); const fallback = window.setInterval(() => void update(), 10_000);
    document.addEventListener("visibilitychange", update);
    return () => { stopped = true; abort.abort(); window.clearInterval(clock); window.clearInterval(fallback); document.removeEventListener("visibilitychange", update); };
  }, [initial.address]);
  return <LiveWallet.Provider value={{ snapshot, healthy: healthy && dataFresh(snapshot.updatedAt, now, 30_000) && !snapshot.unavailableScopes.length, now, language }}>{children}</LiveWallet.Provider>;
}

export function WalletLiveRefresh() {
  const { snapshot, healthy, now, language } = useWalletSnapshot(); const t = (value: string) => walletText(language, value);
  const age = snapshot.updatedAt ? Math.max(0, Math.round((now - snapshot.updatedAt) / 1000)) : null;
  return <span role="status" className={`flex items-center gap-2 rounded-full border border-white/[.08] bg-white/[.035] px-3 py-2 text-[10px] ${healthy ? "text-[var(--cyan)]" : "text-[var(--muted)]"}`} title={snapshot.updatedAt ? `${t("Обновлено")} ${walletTime(snapshot.updatedAt, language)} MSK` : t("Ожидаем снимок сервера")}><i className={`size-1.5 rounded-full ${healthy ? "live-dot bg-[var(--cyan)]" : "bg-[var(--loss)]"}`}/>{healthy ? "LIVE" : snapshot.pending ? t("ЗАГРУЗКА") : t("СОХРАНЁННЫЕ")} · {age === null ? t("нет снимка") : `${age}${language === "en" ? "s" : "с"}`}</span>;
}

export function WalletLiveValue({ field }: { field: "accountValue" | "positionValue" | "totalMarginUsed" | "withdrawable" | "openPnl" | "risk" | "bias" | "updatedAt" | "source" }) {
  const { snapshot, now, language } = useWalletSnapshot(); const t = (value: string) => walletText(language, value);
  const stale = !dataFresh(snapshot.updatedAt, now, 30_000) || snapshot.unavailableScopes.length > 0;
  if (field === "source") return <>{snapshot.pending ? t("Ожидаем снимок сервера") : stale ? t("Серверный журнал · часть рынков устарела") : t("Серверный журнал Hyperliquid")}</>;
  if (field === "updatedAt") return <>{snapshot.updatedAt ? `${walletTime(snapshot.updatedAt, language)} MSK${stale ? ` · ${t("часть рынков устарела")}` : ` · ${t("серверный снимок")}`}` : t("Ожидаем первый снимок")}</>;
  if (snapshot.pending || snapshot.unavailableScopes.some((scope) => scope !== "spot")) return <>—</>;
  const value = snapshot.positions.reduce((sum, position) => sum + Math.abs(marketNumber(position.positionValue)), 0);
  if (field === "bias") {
    if (!Number.isFinite(value)) return <>—</>;
    const long = snapshot.positions.filter((position) => position.size > 0).reduce((sum, position) => sum + Math.abs(marketNumber(position.positionValue)), 0);
    return <>{value ? `${long >= value / 2 ? "Long" : "Short"} ${Math.round(Math.max(long, value - long) / value * 100)}%` : t("Нет позиций")}</>;
  }
  if (field === "risk") return <>{Number.isFinite(snapshot.accountValue) && snapshot.accountValue > 0 && Number.isFinite(snapshot.totalMarginUsed) ? `${(snapshot.totalMarginUsed / snapshot.accountValue * 100).toFixed(1)}%` : "—"}</>;
  const amount = field === "positionValue" ? value : field === "openPnl" ? snapshot.positions.reduce((sum, position) => sum + marketNumber(position.unrealizedPnl), 0) : snapshot[field];
  return <span className={field === "openPnl" ? amount >= 0 ? "text-[var(--cyan)]" : "text-[var(--loss)]" : undefined}>{walletMoney(amount, true)}</span>;
}

export function RefreshWalletHistory() {
  const { language } = useWalletSnapshot(); const t = (value: string) => walletText(language, value);
  const router = useRouter();
  return <button type="button" className="control-field text-xs" onClick={() => router.refresh()}>{t("Обновить график и историю")}</button>;
}
