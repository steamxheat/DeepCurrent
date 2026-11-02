import { decimalAdd, decimalEqual, decimalNegate, decimalSign, validDecimal } from "./position-reducer.ts";

type Row = Record<string, unknown>;
const amount = (value: unknown) => { if (!validDecimal(value) || !Number.isFinite(Number(value))) throw Error("missing_decimal"); return value; };
const time = (value: unknown) => { if (typeof value !== "string" || !Number.isSafeInteger(Date.parse(value))) throw Error("invalid_time"); return Date.parse(value); };
function product(left: string, right: string) {
  const [a, b = ""] = left.split("."), [c, d = ""] = right.split(".");
  const scale = b.length + d.length, digits = (BigInt(a + b) * BigInt(c + d)).toString().padStart(scale + 1, "0");
  const result = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "") : digits;
  return amount(result || "0");
}

// Caller must preserve /fills?page=... eventId ASC order and prove every page up to its fixed height.
// This is independent of tradeHistory's grouping and PnL implementation.
export function replayDydxRawFills(fills: Row[], positions: Row[], current: Row[], height: number, asOf: number, complete: boolean) {
  if (!complete || !Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(asOf)) throw Error("incomplete_anchored_history");
  type State = { size: string; average: number; displayAverage: number; openedTotal: number; openedAt: number; gross: number; fees: number; notional: number };
  const states = new Map<string, State>();
  const closed: Array<{ market: string; openedAt: number; closedAt: number; tradingGross: number; tradingFees: number; notional: number }> = [];
  const ids = new Set(); let previousHeight = 0, previousTime = 0, volume30dUsd = "0", actions60d = 0;
  for (const fill of fills) {
    const at = time(fill.createdAt), atHeight = Number(fill.createdAtHeight);
    if (typeof fill.createdAtHeight !== "string" || !/^[1-9]\d*$/.test(fill.createdAtHeight) || !Number.isSafeInteger(atHeight) || atHeight < previousHeight || at < previousTime || atHeight > height || at > asOf) throw Error("not_canonical_anchored_order");
    previousHeight = atHeight; previousTime = at;
    if (typeof fill.id !== "string" || !fill.id || ids.has(fill.id)) throw Error("missing_or_duplicate_fill_id"); ids.add(fill.id);
    if (typeof fill.market !== "string" || !fill.market || fill.marketType !== "PERPETUAL" || typeof fill.side !== "string" || !["BUY", "SELL"].includes(fill.side)) throw Error("invalid_perp_fill");
    const size = amount(fill.size), price = amount(fill.price), fee = Number(amount(fill.fee));
    if (decimalSign(size) <= 0 || decimalSign(price) <= 0) throw Error("invalid_quantity_or_price");
    for (const name of ["builderFee", "orderRouterFee"]) if (fill[name] !== undefined && fill[name] !== null && !decimalEqual(amount(fill[name]), "0")) throw Error("additional_fee_reconciliation_required");
    const market = fill.market, quantity = Number(size), px = Number(price);
    const prior = states.get(market), before = prior?.size ?? "0", sign = decimalSign(before);
    if (fill.positionSizeBefore !== undefined) {
      const absolute = amount(fill.positionSizeBefore);
      if (Number(absolute) < 0 || Number(absolute) !== 0 && !["LONG", "SHORT"].includes(String(fill.positionSideBefore))) throw Error("invalid_authoritative_position");
      const authoritative = fill.positionSideBefore === "SHORT" ? decimalNegate(absolute) : absolute;
      if (!decimalEqual(authoritative, before)) throw Error("raw_position_continuity_gap");
    }
    if (sign && fill.entryPriceBefore !== undefined && fill.entryPriceBefore !== null) {
      const entry = Number(amount(fill.entryPriceBefore));
      if (Math.abs(entry - prior!.displayAverage) > Math.max(1e-8, Math.abs(entry) * 1e-8)) throw Error("source_entry_price_mismatch");
    }
    const delta = fill.side === "BUY" ? size : decimalNegate(size), after = decimalAdd(before, delta);
    const notional = product(price, size);
    if (at >= asOf - 30 * 86400000) volume30dUsd = decimalAdd(volume30dUsd, notional);
    if (at >= asOf - 60 * 86400000) actions60d++;
    if (!sign || sign === decimalSign(delta)) {
      const state = prior ?? { size: "0", average: 0, displayAverage: 0, openedTotal: 0, openedAt: at, gross: 0, fees: 0, notional: 0 };
      state.average = (state.average * Math.abs(Number(before)) + px * quantity) / Math.abs(Number(after));
      // API entryPrice weights all opens in the lifecycle, not just the remaining inventory's PnL basis.
      state.displayAverage = (state.displayAverage * state.openedTotal + px * quantity) / (state.openedTotal + quantity); state.openedTotal += quantity;
      state.size = after; state.fees += fee; state.notional += Number(notional); states.set(market, state);
    } else {
      const state = prior!, closingSize = Math.min(quantity, Math.abs(Number(before))), closingFee = fee * closingSize / quantity;
      state.gross += (px - state.average) * closingSize * sign; state.fees += closingFee; state.notional += px * closingSize;
      if (decimalSign(after) !== sign) {
        closed.push({ market, openedAt: state.openedAt, closedAt: at, tradingGross: state.gross, tradingFees: state.fees, notional: state.notional }); states.delete(market);
        if (decimalSign(after)) states.set(market, { size: after, average: px, displayAverage: px, openedTotal: Math.abs(Number(after)), openedAt: at, gross: 0, fees: fee - closingFee, notional: px * Math.abs(Number(after)) });
      } else state.size = after;
    }
  }
  const positionKey = (market: unknown, openedAt: number, closedAt: number) => JSON.stringify([market, openedAt, closedAt]);
  const closedPositions = new Map<string, Row>();
  for (const position of positions) if (position.status === "CLOSED" && time(position.closedAt) <= asOf) {
    const key = positionKey(position.market, time(position.createdAt), time(position.closedAt));
    if (closedPositions.has(key)) throw Error("duplicate_closed_position"); closedPositions.set(key, position);
  }
  const cycles = closed.map(cycle => {
    const key = positionKey(cycle.market, cycle.openedAt, cycle.closedAt), position = closedPositions.get(key);
    if (!position) throw Error("raw_closed_position_not_matched"); closedPositions.delete(key);
    const funding = Number(amount(position.netFunding)), netPnl = cycle.tradingGross - cycle.tradingFees + funding;
    const errorBound = Math.max(1e-8, cycle.notional * 1e-12);
    if (!Number.isFinite(netPnl) || Math.abs(netPnl) <= errorBound && (cycle.tradingGross !== 0 || cycle.tradingFees !== 0 || funding !== 0)) throw Error("pnl_near_numeric_uncertainty");
    return { ...cycle, funding, netPnl, errorBound };
  });
  if (closedPositions.size) throw Error("unmatched_raw_closed_position");
  const open = current.filter(position => !decimalEqual(amount(position.size), "0"));
  if (open.length !== states.size) throw Error("raw_current_position_count_mismatch");
  for (const position of open) {
    const state = states.get(String(position.market));
    if (!state || !decimalEqual(state.size, amount(position.size)) || state.openedAt !== time(position.createdAt)) throw Error("raw_current_size_or_opening_mismatch");
    const entry = Number(amount(position.entryPrice));
    if (Math.abs(entry - state.displayAverage) > Math.max(1e-8, Math.abs(entry) * 1e-8)) throw Error("raw_current_entry_mismatch");
  }
  const wins = cycles.filter(c => c.netPnl > 0).length;
  return { complete: true, sourceOrder: "indexer_eventId_ASC", rawExecutions: fills.length, asOfHeight: height, asOf,
    closedPositionsLifetime: cycles.length, winsLifetime: wins, winRateLifetime: cycles.length ? wins * 100 / cycles.length : null,
    volume30dUsd, tradeActions60d: actions60d, cycles, openings: [...states].map(([market, state]) => ({ market, ...state })),
    independentFillAudit: true, liveVerified: false, fullyAccepted: false };
}
