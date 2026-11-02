import { decimalAdd, decimalEqual, decimalNegate, orderFillChain, validDecimal } from "./position-reducer.ts";

type Row = Record<string, unknown>;
const timestamp = (value: unknown) => {
  if (typeof value !== "string" || !Number.isSafeInteger(Date.parse(value))) throw Error("invalid_timestamp");
  return Date.parse(value);
};
const money = (value: unknown) => {
  if (!validDecimal(value) || !Number.isFinite(Number(value))) throw Error("missing_or_invalid_decimal");
  return value;
};
const unique = (rows: Row[], key: (row: Row) => string) => {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const id = key(row); if (!id) throw Error("missing_identity");
    if (result.has(id) && JSON.stringify(result.get(id)) !== JSON.stringify(row)) throw Error("conflicting_identity");
    result.set(id, row);
  }
  return [...result.values()];
};

// Public tradeHistory netRealizedPnl is gross; netFee is a separate cumulative field.
// This checks the reported lifecycle against position records, not independently against every raw fill.
export function auditDydxReportedHistory(rows: Row[], positions: Row[], current: Row[], complete: boolean, asOf: number) {
  const byMarket = new Map<string, Row[]>();
  for (const row of unique(rows, row => typeof row.id === "string" ? row.id : "")) {
    if (typeof row.marketId !== "string" || !row.marketId || !["BUY", "SELL"].includes(String(row.side))) throw Error("invalid_trade_history_row");
    const market = byMarket.get(row.marketId) ?? []; market.push(row); byMarket.set(row.marketId, market);
  }
  const ordered = [...byMarket].flatMap(([market, records]) => {
    const chain = orderFillChain(records.map(row => {
      if (!["OPEN", "EXTEND", "PARTIAL_CLOSE", "LIQUIDATION_PARTIAL_CLOSE", "CLOSE", "LIQUIDATION_CLOSE"].includes(String(row.action))) throw Error("unknown_history_action");
      const increasing = row.action === "OPEN" || row.action === "EXTEND";
      const positiveBefore = increasing ? row.side === "BUY" : row.side === "SELL";
      const before = money(row.prevSize), delta = money(row.additionalSize);
      if (Number(before) < 0) throw Error("invalid_history_quantity");
      return { coin: market, time: timestamp(row.time), side: row.side === "BUY" ? "B" as const : "A" as const,
        sz: delta.startsWith("-") ? decimalNegate(delta) : delta,
        startPosition: positiveBefore ? before : decimalNegate(before), row };
    }));
    if (chain.ambiguous) throw Error("ambiguous_timestamp");
    return chain.fills.map(fill => fill.row);
  }).sort((a, b) => timestamp(a.time) - timestamp(b.time));
  const cycles: Array<{ market: string; openedAt: number; closedAt: number; netPnl: string }> = [];
  const states = new Map<string, { size: string; openedAt: number }>();
  let volume30dUsd = "0", actions60d = 0;
  const matched = new Set<Row>();
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i], time = timestamp(row.time);
    if (time > asOf || typeof row.marketId !== "string" || !["BUY", "SELL"].includes(String(row.side))) throw Error("invalid_trade_history_row");
    const market = row.marketId, beforeSize = money(row.prevSize), delta = money(row.additionalSize);
    money(row.netFee); money(row.netRealizedPnl);
    if (Number(beforeSize) < 0 || Number(money(row.value)) < 0 || decimalEqual(delta, "0")) throw Error("invalid_history_quantity");
    const previous = states.get(market);
    const before = previous?.size ?? "0";
    if (!decimalEqual(beforeSize, before.startsWith("-") ? decimalNegate(before) : before)) throw Error("position_continuity_gap");
    const after = decimalAdd(before, delta);
    if (row.side === "BUY" && Number(delta) <= 0 || row.side === "SELL" && Number(delta) >= 0) throw Error("invalid_trade_side");
    if (time >= asOf - 30 * 86400000) volume30dUsd = decimalAdd(volume30dUsd, money(row.value));
    if (time >= asOf - 60 * 86400000) actions60d++;
    if (row.action === "OPEN") {
      if (!decimalEqual(before, "0") || decimalEqual(after, "0")) throw Error("invalid_open");
      states.set(market, { size: after, openedAt: time });
    } else if (["EXTEND", "PARTIAL_CLOSE", "LIQUIDATION_PARTIAL_CLOSE"].includes(String(row.action))) {
      if (!previous || Number(before) * Number(after) <= 0) throw Error("invalid_position_change");
      if (row.action === "EXTEND" ? Math.abs(Number(after)) <= Math.abs(Number(before)) : Math.abs(Number(after)) >= Math.abs(Number(before))) throw Error("invalid_position_change");
      previous.size = after;
    } else if (["CLOSE", "LIQUIDATION_CLOSE"].includes(String(row.action))) {
      if (!previous || !decimalEqual(after, "0")) throw Error("close_without_complete_open");
      const matches = positions.filter(p => p.status === "CLOSED" && p.market === market && timestamp(p.createdAt) === previous.openedAt && timestamp(p.closedAt) === time);
      if (matches.length !== 1) throw Error("closed_position_not_uniquely_matched");
      const position = matches[0]; matched.add(position);
      // netFunding is the signed funding credit/debit, not a trading commission.
      const netPnl = decimalAdd(decimalAdd(money(row.netRealizedPnl), decimalNegate(money(row.netFee))), money(position.netFunding));
      cycles.push({ market, openedAt: previous.openedAt, closedAt: time, netPnl }); states.delete(market);
    } else throw Error("unknown_history_action");
  }
  if (positions.some(p => p.status === "CLOSED" && !matched.has(p))) throw Error("unmatched_closed_position");
  const nonzero = current.filter(p => !decimalEqual(money(p.size), "0"));
  if (nonzero.length !== states.size) throw Error("current_position_count_mismatch");
  for (const position of nonzero) {
    const state = states.get(String(position.market));
    if (!state || !decimalEqual(state.size, money(position.size)) || state.openedAt !== timestamp(position.createdAt)) throw Error("current_position_size_or_opening_mismatch");
  }
  const wins = cycles.filter(c => Number(c.netPnl) > 0).length;
  return { complete, closedPositionsLifetime: cycles.length, winsLifetime: wins, winRateLifetime: cycles.length ? wins * 100 / cycles.length : null,
    volume30dUsd, reportedActions60d: actions60d, openings: [...states].map(([market, state]) => ({ market, ...state })), cycles,
    sampleWarning: cycles.length < 20 ? "Small sample; minimum20 is not an eligibility criterion" : null,
    fullyAccepted: false, independentFillAudit: false, liveVerified: false };
}

export function dydxOfficialPnl30d(accounts: Array<{ subaccountNumber: number; head: Row; startRows: Row[]; endRows?: Row[] }>, now: number) {
  if (!accounts.length || accounts.some(a => !Number.isSafeInteger(a.subaccountNumber) || a.subaccountNumber < 0) || new Set(accounts.map(a => a.subaccountNumber)).size !== accounts.length) throw Error("invalid_pnl_subaccounts");
  const times = accounts.map(a => timestamp(a.head.createdAt));
  if (!Number.isSafeInteger(now) || times.some(t => t > now || now - t >= 2 * 3600000)) throw Error("stale_or_future_pnl_head");
  const endAt = Math.min(...times), startAt = endAt - 30 * 86400000;
  const point = (rows: Row[], at: number) => {
    const matches = rows.filter(r => timestamp(r.createdAt) === at);
    if (matches.length !== 1) throw Error("missing_or_ambiguous_exact_pnl_boundary");
    const row = matches[0];
    if (!decimalEqual(decimalAdd(money(row.equity), decimalNegate(money(row.netTransfers))), money(row.totalPnl))) throw Error("pnl_equity_transfer_conflict");
    return row;
  };
  const results = accounts.map(a => {
    const start = point(a.startRows, startAt), end = point(a.endRows ?? [a.head], endAt);
    return { subaccountNumber: a.subaccountNumber, start, end, netPnl30dUsd: decimalAdd(money(end.totalPnl), decimalNegate(money(start.totalPnl))) };
  });
  return { startAt, endAt, officialPnlAll: results.reduce((sum, a) => decimalAdd(sum, money(a.end.totalPnl)), "0"),
    officialNetPnl30dUsd: results.reduce((sum, a) => decimalAdd(sum, a.netPnl30dUsd), "0"), accounts: results };
}
