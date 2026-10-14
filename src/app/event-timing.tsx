import type { PulseFill } from "@/lib/hyperliquid";
import { walletTime, eventDelay } from "@/lib/wallet-format";
import type { UserLanguage } from "@/lib/user-preferences";

export function EventTiming({ fill, language = "ru", compact = false }: { fill: PulseFill; language?: UserLanguage; compact?: boolean }) {
  const t = (ru: string, en: string) => language === "en" ? en : ru;
  const timestamp = (value: number | null | undefined) => value == null || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000 ? t("Время неизвестно", "Time unknown") : <time dateTime={new Date(value).toISOString()}>{walletTime(value, language)}.{String(value % 1000).padStart(3, "0")} MSK</time>;
  const details = <div className="mt-2 space-y-1 text-xs leading-relaxed text-[var(--muted)]">
    <p>{t("Исполнено на бирже", "Executed on exchange")}: <span className="mono text-white">{timestamp(fill.time)}</span></p>
    <p>{t("Получено нами", "Received by us")}: <span className="mono">{timestamp(fill.receivedAt)}</span></p>
    <p>{t("Подтверждено журналом", "Confirmed by journal")}: <span className="mono">{fill.confirmedAt == null ? fill.source === "user" ? t("Время неизвестно", "Time unknown") : t("Не подтверждено", "Not confirmed") : timestamp(fill.confirmedAt)}</span></p>
    <p>{t("Биржа → получение", "Exchange → receipt")}: <span className="mono">{eventDelay(fill.time, fill.receivedAt, language)}</span> · {t("Получение → подтверждение", "Receipt → confirmation")}: <span className="mono">{eventDelay(fill.receivedAt, fill.confirmedAt, language)}</span></p>
    <p>{t("Полная задержка подтверждения", "Total confirmation delay")}: <span className="mono">{eventDelay(fill.time, fill.confirmedAt, language)}</span></p>
    {(fill.receivedAt != null && fill.receivedAt < fill.time || fill.confirmedAt != null && fill.confirmedAt < (fill.receivedAt ?? fill.time)) && <p className="text-[var(--warn)]">{t("Порядок времён нарушен; проверьте часы сервера", "Timestamp order invalid; check server clock")}</p>}
  </div>;
  return compact ? <details className="mt-1"><summary className="cursor-pointer text-xs text-[var(--muted)]">{t("Время и задержки", "Times and delays")}</summary>{details}</details> : details;
}
