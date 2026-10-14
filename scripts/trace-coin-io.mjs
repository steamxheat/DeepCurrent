import { DatabaseSync } from "node:sqlite";

const emit = (row) => process.stderr.write(`[DC_COIN_TRACE]${JSON.stringify(row)}\n`);
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (/^\s*SELECT\b/i.test(sql)) for (const method of ["all", "get"]) {
    const original = statement[method];
    statement[method] = function (...args) {
      const started = Date.now(), began = performance.now();
      try { return original.apply(this, args); }
      finally { emit({ stage: "sqlite", started, ended: Date.now(), ms: performance.now() - began, table: sql.match(/\bFROM\s+([a-z_]+)/i)?.[1] ?? "other" }); }
    };
  }
  return statement;
};
const fetcher = globalThis.fetch;
globalThis.fetch = async function (input, options) {
  let body;
  try { if (String(input) === "https://api.hyperliquid.xyz/info") body = JSON.parse(options?.body || "{}"); } catch {}
  if (!["metaAndAssetCtxs", "perpDexs", "candleSnapshot"].includes(body?.type)) return fetcher(input, options);
  const started = Date.now();
  try { const response = await fetcher(input, options); emit({ stage: "upstream", started, ended: Date.now(), operation: body.type, dex: body.dex, coin: body.req?.coin, endTime: body.req?.endTime, status: response.status }); return response; }
  catch (error) { emit({ stage: "upstream", started, ended: Date.now(), operation: body.type, error: error.name }); throw error; }
};
