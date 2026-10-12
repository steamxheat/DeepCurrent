export type AdminConfig = { trackedWallets: number; signalThreshold: number; liveMarkets: number; confluenceMinutes: number };
export const defaultAdminConfig: AdminConfig = { trackedWallets: 200, signalThreshold: 5_000, liveMarkets: 24, confluenceMinutes: 30 };

export function normalizeAdminConfigValue(key: keyof AdminConfig, value: number) {
  const ranges: Record<keyof AdminConfig, [number, number, number]> = { trackedWallets: [100, 500, 50], signalThreshold: [1_000, 100_000, 1_000], liveMarkets: [8, 40, 1], confluenceMinutes: [5, 120, 5] };
  const [minimum, maximum, step] = ranges[key];
  return Math.max(minimum, Math.min(maximum, Math.round(value / step) * step));
}
