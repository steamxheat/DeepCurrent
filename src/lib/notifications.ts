export type NotificationAction = "OPEN" | "ADD" | "REDUCE" | "CLOSE" | "FLIP" | "BUY" | "SELL";
export type NotificationDirection = "LONG" | "SHORT" | "BUY" | "SELL";

export type NotificationSettings = {
  enabled: boolean;
  openCloseOnly: boolean;
  includeAdds: boolean;
  includeReductions: boolean;
  minNotional: number;
  coins: string[];
  quietStart: string;
  quietEnd: string;
  confluenceOnly: boolean;
  timezone: string;
};

export type PositionChange = {
  action: NotificationAction;
  direction: NotificationDirection;
  before: number;
  after: number;
};

export const defaultNotificationSettings: NotificationSettings = {
  enabled: true,
  openCloseOnly: false,
  includeAdds: true,
  includeReductions: true,
  minNotional: 5_000,
  coins: [],
  quietStart: "",
  quietEnd: "",
  confluenceOnly: false,
  timezone: "Europe/Moscow",
};

const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeNotificationSettings(value: unknown): NotificationSettings {
  const input = value && typeof value === "object" ? value as Partial<NotificationSettings> : {};
  const coins = Array.isArray(input.coins)
    ? [...new Set(input.coins.map((coin) => String(coin).trim().toUpperCase()).filter(Boolean))].slice(0, 100)
    : [];
  const timezone = String(input.timezone ?? defaultNotificationSettings.timezone);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { return { ...normalizeNotificationSettings({ ...input, timezone: defaultNotificationSettings.timezone }), coins }; }
  return {
    enabled: input.enabled !== false,
    openCloseOnly: input.openCloseOnly === true,
    includeAdds: input.includeAdds !== false,
    includeReductions: input.includeReductions !== false,
    minNotional: Math.min(100_000_000, Math.max(0, Number(input.minNotional) || 0)),
    coins,
    quietStart: clock.test(String(input.quietStart ?? "")) ? String(input.quietStart) : "",
    quietEnd: clock.test(String(input.quietEnd ?? "")) ? String(input.quietEnd) : "",
    confluenceOnly: input.confluenceOnly === true,
    timezone,
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

export function shouldNotify(settings: NotificationSettings, event: { action: NotificationAction; coin: string; notional: number; time: number }, confluenceCount = 1) {
  if (!settings.enabled || event.notional < settings.minNotional || isQuietTime(settings, event.time)) return false;
  if (settings.coins.length && !settings.coins.includes(event.coin.toUpperCase())) return false;
  if (settings.openCloseOnly && !["OPEN", "CLOSE", "FLIP"].includes(event.action)) return false;
  if (!settings.includeAdds && event.action === "ADD") return false;
  if (!settings.includeReductions && event.action === "REDUCE") return false;
  if (settings.confluenceOnly && confluenceCount < 2) return false;
  return true;
}
