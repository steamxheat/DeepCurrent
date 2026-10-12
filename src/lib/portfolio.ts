export type PortfolioSeries = {
  accountValue: [number, number][];
  pnl: [number, number][];
  volume: number;
};

export type PortfolioRange = "day" | "week" | "month" | "allTime";

export type RawPortfolioEntry = [string, {
  accountValueHistory?: [number, string][];
  pnlHistory?: [number, string][];
  vlm?: string;
}];

const sourceNames: Record<PortfolioRange, string> = {
  day: "perpDay",
  week: "perpWeek",
  month: "perpMonth",
  allTime: "perpAllTime",
};

export function normalizePerpPortfolio(rows: RawPortfolioEntry[]): Record<PortfolioRange, PortfolioSeries> {
  return Object.fromEntries(Object.entries(sourceNames).map(([range, sourceName]) => {
    const value = rows.find(([name]) => name === sourceName)?.[1];
    return [range, {
      accountValue: (value?.accountValueHistory ?? []).map(([time, amount]) => [time, Number(amount)]),
      pnl: (value?.pnlHistory ?? []).map(([time, amount]) => [time, Number(amount)]),
      volume: Number(value?.vlm ?? 0),
    }];
  })) as Record<PortfolioRange, PortfolioSeries>;
}
