const belowPrecision = (value: number) => Math.abs(value) > 0 && Math.abs(value) < 1e-20;
const tiny = (value: number) => `${value < 0 ? "-" : ""}<$0.00000000000000000001`;
export const fillSourceUrl = (hash: string) => /^0x[a-fA-F0-9]{64}$/.test(hash) && !/^0x0{64}$/.test(hash) ? `https://app.hyperliquid.xyz/explorer/tx/${hash}` : null;
export const walletMoney = (value: number | null, compact = false) => value === null || !Number.isFinite(value) ? "—" : belowPrecision(value) ? tiny(value) : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: compact && Math.abs(value) >= 1 ? "compact" : "standard", maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 1 ? Math.min(20, Math.max(6, Math.ceil(-Math.log10(Math.abs(value))) + 3)) : compact ? 1 : 2,
}).format(value);
export const walletPrice = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : belowPrecision(value) ? tiny(value) : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: Math.abs(value) < 1 ? 20 : 8 }).format(value);
export const walletTime = (value: number, language = "ru") => new Intl.DateTimeFormat(language === "en" ? "en-GB" : "ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
export const eventDelay = (from: number | null | undefined, to: number | null | undefined, language = "ru") => from == null || to == null || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from ? "—" : `${new Intl.NumberFormat(language === "en" ? "en-GB" : "ru-RU", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format((to - from) / 1000)} ${language === "en" ? "s" : "с"}`;
export const walletDuration = (milliseconds: number, language = "ru") => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000)); const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const rest = minutes % 60;
  const [d, h, m, s] = language === "en" ? ["d", "h", "m", "s"] : ["д", "ч", "м", "с"];
  return days ? `${days}${d} ${hours}${h} ${rest}${m}` : hours ? `${hours}${h} ${rest}${m}` : minutes ? `${rest}${m} ${seconds % 60}${s}` : `${seconds}${s}`;
};
