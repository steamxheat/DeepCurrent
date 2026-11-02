import assert from "node:assert/strict";
type Row = Record<string, unknown>;
export type PublicExchange = "gate" | "bitget" | "bingx";
export function publicSourceData(exchange: PublicExchange, payload: Row) {
  assert.ok(exchange === "gate" ? [0, 200].includes(Number(payload.code)) : exchange === "bitget" ? payload.code === "200" : payload.code === 0,
    `API_${payload.code}: ${payload.msg ?? payload.message ?? "unknown"}`);
  assert.ok(payload.data && typeof payload.data === "object", "missing_public_data");
  return payload.data as Row;
}
export function publicTraderPage(exchange: PublicExchange, data: Row, page: number) {
  const rows = exchange === "gate" ? data.list : exchange === "bitget" ? data.rows : data.result;
  assert.ok(Array.isArray(rows), "missing_trader_list");
  const ids = rows.map((row: Row) => {
    const value = exchange === "gate" ? row.leader_id : exchange === "bitget" ? row.traderUid ?? row.portfolioId : row.traderId;
    assert.ok(typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)), "missing_trader_id");
    const id = String(value); assert.match(id, /^[A-Za-z0-9_-]+$/, "invalid_trader_id"); return id;
  });
  assert.equal(new Set(ids).size, ids.length, "duplicate_trader_page");
  let more: boolean;
  if (exchange === "gate") {
    assert.ok(Number.isSafeInteger(data.pagecount) && Number(data.pagecount) >= 0, "missing_pagecount"); more = page < Number(data.pagecount);
  } else if (exchange === "bitget") { assert.equal(typeof data.nextFlag, "boolean", "missing_next_flag"); more = data.nextFlag as boolean; }
  else { assert.ok(Number.isSafeInteger(data.total) && Number(data.total) >= 0, "missing_total"); more = page * 20 < Number(data.total); }
  assert.ok(!more || rows.length > 0, "empty_unfinished_page");
  return { rows: rows as Row[], ids, more };
}
export function publicTiming(payload: Row, startedAt: number, receivedAt: number) {
  assert.ok(receivedAt >= startedAt, "invalid_receive_time");
  const value = payload.timestamp ?? payload.requestTime;
  const sourceResponseAt = typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= receivedAt ? value : null;
  return { startedAt, receivedAt, requestDurationMs: receivedAt - startedAt, sourceResponseAt,
    exchangeEventAt: null, endToEndDelayMs: null, liveProven: false };
}
