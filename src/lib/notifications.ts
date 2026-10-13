export type NotificationAction = "OPEN" | "ADD" | "REDUCE" | "CLOSE" | "FLIP" | "BUY" | "SELL";
export type NotificationDirection = "LONG" | "SHORT" | "BUY" | "SELL";

export type NotificationSettings = {
  enabled: boolean;
  inAppEnabled: boolean;
  webPushEnabled: boolean;
  telegramEnabled: boolean;
  openCloseOnly: boolean;
  includeAdds: boolean;
  includeReductions: boolean;
  minNotional: number;
  coins: string[];
  quietStart: string;
  quietEnd: string;
  confluenceOnly: boolean;
  timezone: string;
  includeOpens: boolean; includeCloses: boolean;
  direction: "all" | "LONG" | "SHORT";
  minLeverage: number; maxLeverage: number; minCopyability: number;
  confluenceMinutes: number; minWallets: number;
};

export type PositionChange = {
  action: NotificationAction;
  direction: NotificationDirection;
  before: number;
  after: number;
};

export const defaultNotificationSettings: NotificationSettings = {
  enabled: true,
  inAppEnabled: true,
  webPushEnabled: true,
  telegramEnabled: true,
  openCloseOnly: false,
  includeAdds: true,
  includeReductions: true,
  minNotional: 5_000,
  coins: [],
  quietStart: "",
  quietEnd: "",
  confluenceOnly: false,
  timezone: "Europe/Moscow",
  includeOpens: true, includeCloses: true, direction: "all", minLeverage: 0, maxLeverage: 0, minCopyability: 0,
  confluenceMinutes: 15, minWallets: 2,
};

const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;
const amount = (value: unknown, fallback: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
export const notificationCoin = (coin: string) => coin.toUpperCase().split(":").at(-1)!.split("/")[0];

export function normalizeNotificationSettings(value: unknown): NotificationSettings {
  const input = value && typeof value === "object" ? value as Partial<NotificationSettings> : {};
  const coins = Array.isArray(input.coins)
    ? [...new Set(input.coins.filter((coin) => typeof coin === "string").map((coin) => coin.trim().toUpperCase()).filter((coin) => /^[\w#@:/.+-]{1,128}$/.test(coin)))].slice(0, 100)
    : [];
  const timezone = String(input.timezone ?? defaultNotificationSettings.timezone);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { return { ...normalizeNotificationSettings({ ...input, timezone: defaultNotificationSettings.timezone }), coins }; }
  return {
    enabled: input.enabled !== false,
    inAppEnabled: input.inAppEnabled !== false,
    webPushEnabled: input.webPushEnabled !== false,
    telegramEnabled: input.telegramEnabled !== false,
    openCloseOnly: input.openCloseOnly === true,
    includeAdds: input.includeAdds !== false,
    includeReductions: input.includeReductions !== false,
    minNotional: amount(input.minNotional, defaultNotificationSettings.minNotional, 100_000_000),
    coins,
    quietStart: clock.test(String(input.quietStart ?? "")) ? String(input.quietStart) : "",
    quietEnd: clock.test(String(input.quietEnd ?? "")) ? String(input.quietEnd) : "",
    confluenceOnly: input.confluenceOnly === true,
    timezone,
    includeOpens: input.includeOpens !== false, includeCloses: input.includeCloses !== false,
    direction: input.direction === "LONG" || input.direction === "SHORT" ? input.direction : "all",
    minLeverage: amount(input.minLeverage, 0, 1000), maxLeverage: amount(input.maxLeverage, 0, 1000), minCopyability: amount(input.minCopyability, 0, 100),
    confluenceMinutes: [1, 5, 15, 60, 240, 1440].includes(input.confluenceMinutes!) ? input.confluenceMinutes! : 15,
    minWallets: Math.max(2, Math.floor(amount(input.minWallets, 2, 1000))),
  };
}

export function classifyPositionChange(before: number, after: number): PositionChange | null {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  if (before === 0) return { action: "OPEN", direction: after > 0 ? "LONG" : "SHORT", before, after };
  if (after === 0) return { action: "CLOSE", direction: before > 0 ? "LONG" : "SHORT", before, after };
  if (Math.sign(before) !== Math.sign(after)) return { action: "FLIP", direction: after > 0 ? "LONG" : "SHORT", before, after };
  return {
    action: Math.abs(after) > Math.abs(before) ? "ADD" : "REDUCE",
    direction: after > 0 ? "LONG" : "SHORT",
    before,
    after,
  };
}

export function isQuietTime(settings: NotificationSettings, time: number) {
  if (!settings.quietStart || !settings.quietEnd || settings.quietStart === settings.quietEnd) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(time);
  const current = Number(parts.find((part) => part.type === "hour")?.value) * 60 + Number(parts.find((part) => part.type === "minute")?.value);
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minutes(settings.quietStart); const end = minutes(settings.quietEnd);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function shouldNotify(settings: NotificationSettings, event: { action: NotificationAction; coin: string; notional: number; time: number; direction?: string; leverage?: number; copyability?: number; positionStatus?: string }, confluenceCount = 1, now = event.time) {
  if (!["OPEN", "ADD", "REDUCE", "CLOSE", "FLIP"].includes(event.action)) return false;
  if (["OPEN", "ADD", "FLIP"].includes(event.action) && ["closed", "absent"].includes(event.positionStatus ?? "")) return false;
  if (!settings.enabled || !Number.isFinite(event.notional) || event.notional < settings.minNotional || isQuietTime(settings, now)) return false;
  if (settings.coins.length && !settings.coins.some((coin) => coin.includes(":") || coin.includes("/") ? coin === event.coin.toUpperCase() : coin === notificationCoin(event.coin))) return false;
  if (!settings.includeOpens && ["OPEN", "FLIP"].includes(event.action)) return false;
  if (!settings.includeCloses && ["CLOSE", "FLIP"].includes(event.action)) return false;
  if (settings.direction !== "all" && event.direction !== settings.direction) return false;
  if ((settings.minLeverage > 0 || settings.maxLeverage > 0) && (!Number.isFinite(event.leverage) || event.leverage! < settings.minLeverage || settings.maxLeverage > 0 && event.leverage! > settings.maxLeverage)) return false;
  if (settings.minCopyability > 0 && (!Number.isFinite(event.copyability) || event.copyability! < settings.minCopyability)) return false;
  if (settings.openCloseOnly && !["OPEN", "CLOSE", "FLIP"].includes(event.action)) return false;
  if (!settings.includeAdds && event.action === "ADD") return false;
  if (!settings.includeReductions && event.action === "REDUCE") return false;
  if (settings.confluenceOnly && confluenceCount < settings.minWallets) return false;
  return true;
}
