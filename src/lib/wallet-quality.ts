export type WalletQualityInput = { accountValue: number; monthPnl: number; monthVolume: number; weekPnl: number; monthRoi: number; dayPnl: number };

export const hasPositiveMonthPnl = (monthPnl: number) => Number.isFinite(monthPnl) && monthPnl > 0;

export function walletQuality(input: WalletQualityInput) {
  if (input.accountValue < 100_000 || input.monthPnl <= 10_000 || input.monthVolume < 1_000_000 || input.weekPnl <= 0) return null;
  return Math.log10(input.monthPnl) * 20 + Math.log10(input.accountValue) * 4 + Math.min(200, input.monthRoi) * .18 + (input.dayPnl > 0 ? 5 : 0);
}
