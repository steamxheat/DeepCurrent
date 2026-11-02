import { decimalAdd, decimalEqual, fillTransition, orderFillChain, validDecimal } from "./position-reducer.ts";
import { closedTrades, type Fill } from "./stats.ts";

export function shouldExpandLighterCandidates(pending: number, pages: number, nextPage: number, exhausted: boolean) {
  return !exhausted && pending === 0 && pages >= nextPage;
}

export function lighterFill(trade: Record<string, unknown>, account: number): Fill {
  const ask = trade.ask_account_id === account;
  if (!ask && trade.bid_account_id !== account) throw new Error("unrelated_trade");
  if (trade.ask_account_id === trade.bid_account_id) throw new Error("self_trade");
  if (trade.market_kind !== "perps" || !["trade", "liquidation", "deleverage", "market-settlement"].includes(String(trade.type))) throw new Error("unsupported_trade_kind");
  if (typeof trade.is_maker_ask !== "boolean" || !Number.isSafeInteger(trade.timestamp) || !Number.isSafeInteger(trade.market_id)) throw new Error("invalid_trade");
  const role = ask === trade.is_maker_ask ? "maker" : "taker";
  const before = trade[`${role}_position_size_before`];
  const quote = trade.usd_amount;
  const size = trade.size;
  const price = trade.price;
  if (![before, quote, size, price].every(validDecimal)) throw new Error("missing_position_or_money");
  if (Number(size) <= 0 || Number(quote) <= 0) throw new Error("invalid_trade_amount");
  // Deleveraging can report price=0 while keeping the executed notional and size.
  const executionPrice = Number(price) > 0 ? String(price) : (Number(quote) / Number(size)).toFixed(18);
  if (!validDecimal(executionPrice) || Number(executionPrice) <= 0) throw new Error("missing_execution_price");
  const rates = [trade[`${role}_fee`] ?? 0, trade[`integrator_${role}_fee`] ?? 0];
  if (!rates.every(rate => Number.isSafeInteger(rate) && Number(rate) >= 0)) throw new Error("unknown_fee_rate");
  const [whole, fraction = ""] = String(quote).split(".");
  const numerator = BigInt(whole + fraction) * BigInt(Number(rates[0]) + Number(rates[1])) * 1_000_000n;
  const divisor = 10n ** BigInt(fraction.length) * 1_000_000n;
  if (numerator < 0n) throw new Error("negative_notional");
  // Round costs upwards to a USDC micro-unit so rounding cannot manufacture a win.
  const cost = (numerator + divisor - 1n) / divisor;
  const fee = `${cost / 1_000_000n}.${String(cost % 1_000_000n).padStart(6, "0")}`;
  const fill: Fill = { coin: String(trade.market_id), px: executionPrice, sz: String(size), side: ask ? "A" : "B",
    time: Number(trade.timestamp), startPosition: String(before), dir: "", closedPnl: "0", fee, feeToken: "USDC",
    hash: String(trade.tx_hash ?? ""), crossed: role === "taker" };
  const change = fillTransition(fill)!;
  fill.dir = change.action;
  if (["REDUCE", "CLOSE", "FLIP"].includes(change.action)) {
    const pnl = trade[ask ? "ask_account_pnl" : "bid_account_pnl"];
    if (!validDecimal(pnl)) throw new Error("missing_realized_pnl");
    fill.closedPnl = pnl;
  }
  return fill;
}

export function summarizeLighterWallet(outcomes: Array<ReturnType<typeof screenLighterAccount> | { error: string }>, transactions60d: number, monthPnl: number) {
  let closedPositions60d = 0, wins = 0, unknown = false;
  for (const result of outcomes) {
    if ("error" in result) { unknown = true; continue; }
    closedPositions60d += result.closedPositions60d; wins += result.wins;
    unknown ||= !result.historyComplete || result.chainErrors || result.unknownOutcomes > 0 || !result.positionsVerified;
  }
  const winRate = closedPositions60d ? wins / closedPositions60d * 100 : null;
  return { transactions60d, closedPositions60d, wins, winRate,
    status: unknown || !Number.isFinite(monthPnl) || !outcomes.length ? "needs_review" : transactions60d >= 6 && closedPositions60d >= 20 && winRate !== null && winRate >= 60 && monthPnl > 0 ? "verified_wallet_data" : "rejected" };
}

export function screenLighterAccount(trades: Record<string, unknown>[], account: number, positions: Record<string, unknown>[], historyComplete: boolean, now: number) {
  const fills = trades.map(trade => lighterFill(trade, account));
  const cutoff = now - 60 * 86400000;
  const recent = fills.filter(fill => fill.time >= cutoff && fill.time <= now);
  const transactions = new Set(recent.map(fill => fill.hash).filter(Boolean)).size;
  const lifecycles = closedTrades(fills).filter(trade => trade.closedAt >= cutoff && trade.closedAt <= now);
  const unknownOutcomes = lifecycles.filter(trade => trade.openedAt === null || !Number.isFinite(trade.netPnl)).length;
  const wins = lifecycles.filter(trade => trade.openedAt !== null && trade.netPnl > .000001).length;
  const winRate = lifecycles.length ? wins / lifecycles.length * 100 : null;
  const byMarket = new Map<string, Fill[]>();
  for (const fill of fills) { const rows = byMarket.get(fill.coin) ?? []; rows.push(fill); byMarket.set(fill.coin, rows); }
  const states = new Map([...byMarket].map(([market, rows]) => [market, orderFillChain(rows).state]));
  const chainErrors = [...byMarket.values()].some(rows => {
    const chain = orderFillChain(rows);
    return chain.ambiguous || chain.fills.some((fill, index) => index > 0 && fill.time >= cutoff && !decimalEqual(fillTransition(chain.fills[index - 1])!.after, fill.startPosition!));
  });
  for (const position of positions) {
    if (!validDecimal(position.position)) throw new Error("missing_current_size");
    if (decimalEqual(position.position, "0")) continue;
    if (![1, -1].includes(Number(position.sign)) || !Number.isSafeInteger(position.market_id) ||
      ![position.avg_entry_price, position.unrealized_pnl, position.realized_pnl, position.liquidation_price, position.allocated_margin, position.initial_margin_fraction].every(validDecimal)) throw new Error("incomplete_current_position");
  }
  const openings = positions.filter(position => validDecimal(position.position) && !decimalEqual(position.position, "0")).map(position => {
    const state = states.get(String(position.market_id));
    const size = Number(position.sign) < 0 ? decimalAdd("0", `-${String(position.position).replace(/^-/, "")}`) : String(position.position);
    const matched = Boolean(state && state.reason === null && decimalEqual(state.size, size));
    return { market: position.market_id, symbol: position.symbol, size, matched, openedAt: matched ? state!.openedAt : null };
  });
  const currentMarkets = new Set(positions.map(position => String(position.market_id)));
  const unmatchedHistory = [...states].some(([market, state]) => state && !decimalEqual(state.size, "0") && (!currentMarkets.has(market) || !positions.some(position => String(position.market_id) === market && validDecimal(position.position) && !decimalEqual(position.position, "0"))));
  return { historyComplete, transactions60d: transactions, closedPositions60d: lifecycles.length, wins, winRate,
    unknownOutcomes, chainErrors, lastActive: recent.length ? Math.max(...recent.map(fill => fill.time)) : null,
    statisticalPass: historyComplete && !chainErrors && transactions >= 6 && lifecycles.length > 0 && unknownOutcomes === 0 && winRate !== null && winRate >= 60,
    positionsVerified: openings.every(position => position.matched && position.openedAt !== null) && !unmatchedHistory, openings };
}
