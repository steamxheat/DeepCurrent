import type { ActivityFilters, WalletFilters, WalletSort } from "./workspace.ts";

export type UserLanguage = "ru" | "en";
export type UserPreferences = {
  language: UserLanguage;
  startTab: "overview" | "wallets" | "pulse" | "favorites" | "account";
  timeZone: "local" | "Europe/Moscow" | "UTC";
  dateFormat: "short" | "full" | "iso";
  timeFormat: "24h" | "12h";
  density: "compact" | "comfortable";
  compactNumbers: boolean;
  moneyDecimals: 0 | 2 | 4;
  privacy: boolean;
  absoluteTime: boolean;
  fontScale: "small" | "normal" | "large";
  highContrast: boolean;
  reducedMotion: boolean;
  largeTargets: boolean;
  showWarnings: boolean;
  stickyHeader: boolean;
  showTicker: boolean;
  tickerPaused: boolean;
  showMarketStrip: boolean;
  showSummary: boolean;
  showConfluences: boolean;
  showRecent: boolean;
  showLatest: boolean;
  showQuality: boolean;
  showRisk: boolean;
  showAddresses: boolean;
  rowHover: boolean;
  zebraRows: boolean;
  walletSort: WalletSort;
  sortDirection: "asc" | "desc";
  pageSize: 10 | 25 | 50 | 100;
  favoritesFirst: boolean;
  showAccountColumn: boolean;
  showDayPnlColumn: boolean;
  showMonthPnlColumn: boolean;
  showRoiColumn: boolean;
  showVolumeColumn: boolean;
  walletPerformance: WalletFilters["performance"];
  minAccount: number;
  minMonthPnl: number;
  minRoi: number;
  minVolume: number;
  namedOnly: boolean;
  favoritesOnly: boolean;
  riskFreeOnly: boolean;
  activityCoin: string;
  activityAction: ActivityFilters["action"];
  activityFavoritesOnly: boolean;
  activityMinNotional: number;
  activitySort: ActivityFilters["sort"];
  activityLimit: 25 | 50 | 100 | 250;
  showMarketTrades: boolean;
  showExactTrades: boolean;
  signalThreshold: number;
  confluenceMinutes: number;
  hiddenMarkets: string[];
};

export const defaultUserPreferences: UserPreferences = {
  language: "ru", startTab: "overview", timeZone: "local", dateFormat: "short", timeFormat: "24h",
  density: "compact", compactNumbers: true, moneyDecimals: 2, privacy: false, absoluteTime: false,
  fontScale: "normal", highContrast: false, reducedMotion: false, largeTargets: false, showWarnings: true,
  stickyHeader: true, showTicker: true, tickerPaused: false, showMarketStrip: true, showSummary: true,
  showConfluences: true, showRecent: true, showLatest: true, showQuality: true, showRisk: true,
  showAddresses: true, rowHover: true, zebraRows: false, walletSort: "rank", sortDirection: "asc",
  pageSize: 25, favoritesFirst: false, showAccountColumn: true, showDayPnlColumn: true,
  showMonthPnlColumn: true, showRoiColumn: true, showVolumeColumn: true, walletPerformance: "all",
  minAccount: 0, minMonthPnl: 0, minRoi: 0, minVolume: 0, namedOnly: false, favoritesOnly: false,
  riskFreeOnly: false, activityCoin: "all", activityAction: "all", activityFavoritesOnly: false,
  activityMinNotional: 0, activitySort: "newest", activityLimit: 50, showMarketTrades: true,
  showExactTrades: true, signalThreshold: 10_000, confluenceMinutes: 30, hiddenMarkets: [],
};

const options = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T) => allowed.includes(value as T) ? value as T : fallback;
const flag = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
const amount = (value: unknown, fallback: number, max = 1_000_000_000) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;

export function normalizeUserPreferences(value: unknown): UserPreferences {
  const source = value && typeof value === "object" ? value as Partial<UserPreferences> : {};
  const defaults = defaultUserPreferences;
  return {
    language: options(source.language, ["ru", "en"], defaults.language),
    startTab: options(source.startTab, ["overview", "wallets", "pulse", "favorites", "account"], defaults.startTab),
    timeZone: options(source.timeZone, ["local", "Europe/Moscow", "UTC"], defaults.timeZone),
    dateFormat: options(source.dateFormat, ["short", "full", "iso"], defaults.dateFormat),
    timeFormat: options(source.timeFormat, ["24h", "12h"], defaults.timeFormat),
    density: options(source.density, ["compact", "comfortable"], defaults.density),
    compactNumbers: flag(source.compactNumbers, defaults.compactNumbers),
    moneyDecimals: options(source.moneyDecimals, [0, 2, 4], defaults.moneyDecimals),
    privacy: flag(source.privacy, defaults.privacy), absoluteTime: flag(source.absoluteTime, defaults.absoluteTime),
    fontScale: options(source.fontScale, ["small", "normal", "large"], defaults.fontScale),
    highContrast: flag(source.highContrast, defaults.highContrast), reducedMotion: flag(source.reducedMotion, defaults.reducedMotion),
    largeTargets: flag(source.largeTargets, defaults.largeTargets), showWarnings: flag(source.showWarnings, defaults.showWarnings),
    stickyHeader: flag(source.stickyHeader, defaults.stickyHeader), showTicker: flag(source.showTicker, defaults.showTicker),
    tickerPaused: flag(source.tickerPaused, defaults.tickerPaused), showMarketStrip: flag(source.showMarketStrip, defaults.showMarketStrip),
    showSummary: flag(source.showSummary, defaults.showSummary), showConfluences: flag(source.showConfluences, defaults.showConfluences),
    showRecent: flag(source.showRecent, defaults.showRecent), showLatest: flag(source.showLatest, defaults.showLatest),
    showQuality: flag(source.showQuality, defaults.showQuality), showRisk: flag(source.showRisk, defaults.showRisk),
    showAddresses: flag(source.showAddresses, defaults.showAddresses), rowHover: flag(source.rowHover, defaults.rowHover),
    zebraRows: flag(source.zebraRows, defaults.zebraRows), walletSort: options(source.walletSort, ["rank", "accountValue", "dayPnl", "monthPnl", "monthRoi", "dayVolume"], defaults.walletSort),
    sortDirection: options(source.sortDirection, ["asc", "desc"], defaults.sortDirection), pageSize: options(source.pageSize, [10, 25, 50, 100], defaults.pageSize),
    favoritesFirst: flag(source.favoritesFirst, defaults.favoritesFirst), showAccountColumn: flag(source.showAccountColumn, defaults.showAccountColumn),
    showDayPnlColumn: flag(source.showDayPnlColumn, defaults.showDayPnlColumn), showMonthPnlColumn: flag(source.showMonthPnlColumn, defaults.showMonthPnlColumn),
    showRoiColumn: flag(source.showRoiColumn, defaults.showRoiColumn), showVolumeColumn: flag(source.showVolumeColumn, defaults.showVolumeColumn),
    walletPerformance: options(source.walletPerformance, ["all", "winners", "losers"], defaults.walletPerformance),
    minAccount: amount(source.minAccount, defaults.minAccount), minMonthPnl: amount(source.minMonthPnl, defaults.minMonthPnl),
    minRoi: amount(source.minRoi, defaults.minRoi, 1_000_000), minVolume: amount(source.minVolume, defaults.minVolume),
    namedOnly: flag(source.namedOnly, defaults.namedOnly), favoritesOnly: flag(source.favoritesOnly, defaults.favoritesOnly),
    riskFreeOnly: flag(source.riskFreeOnly, defaults.riskFreeOnly),
    activityCoin: typeof source.activityCoin === "string" && source.activityCoin.length <= 30 ? source.activityCoin : defaults.activityCoin,
    activityAction: options(source.activityAction, ["all", "long", "short", "reduced"], defaults.activityAction),
    activityFavoritesOnly: flag(source.activityFavoritesOnly, defaults.activityFavoritesOnly),
    activityMinNotional: amount(source.activityMinNotional, defaults.activityMinNotional), activitySort: options(source.activitySort, ["newest", "largest"], defaults.activitySort),
    activityLimit: options(source.activityLimit, [25, 50, 100, 250], defaults.activityLimit),
    showMarketTrades: flag(source.showMarketTrades, defaults.showMarketTrades), showExactTrades: flag(source.showExactTrades, defaults.showExactTrades),
    signalThreshold: amount(source.signalThreshold, defaults.signalThreshold), confluenceMinutes: amount(source.confluenceMinutes, defaults.confluenceMinutes, 1_440),
    hiddenMarkets: Array.isArray(source.hiddenMarkets) ? [...new Set(source.hiddenMarkets.filter((coin): coin is string => typeof coin === "string" && coin.length <= 30).map((coin) => coin.toUpperCase()))].slice(0, 100) : [...defaults.hiddenMarkets],
  };
}
