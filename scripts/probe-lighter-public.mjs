import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Read-only feasibility probe; observed accounts are candidates, not verified traders.
const limit = Number(process.argv[2] ?? 200);
const duration = Number(process.argv[3] ?? 150);
const selectedFile = process.argv[4];
assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 200);
assert.ok(Number.isFinite(duration) && duration >= 90 && duration <= 600);
const startedAt = Date.now();
const directory = path.resolve("backups", `lighter-probe-${startedAt}`);
mkdirSync(directory, { recursive: true });
const candidates = new Set();
const selectedWallets = [];
if (selectedFile) {
  const selection = JSON.parse(readFileSync(selectedFile, "utf8"));
  assert.equal(selection.criteria?.revision, "2026-10-15-lifetime-v2", "wrong_selection_criteria");
  for (const wallet of selection.candidates) {
    const accounts = wallet.accounts.map(a => a.account);
    assert.ok(accounts.length && accounts.every(Number.isSafeInteger), "invalid_selected_accounts");
    const extra = accounts.filter(a => !candidates.has(a)); if (candidates.size + extra.length > limit) continue;
    accounts.forEach(a => candidates.add(a)); selectedWallets.push({ address: wallet.address, accounts });
  }
  assert.ok(candidates.size > 0, "no_selected_accounts");
}
const expectedAccounts = selectedFile ? candidates.size : limit;
const sent = new Set();
const snapshots = new Map();
const updated = new Set();
const counts = {};
const errors = [];
const tradeLags = [];
const accountTradeLags = [];
const perAccount = new Map();
const seenAccountTrades = new Set();
const positionSamples = [];
let bytes = 0;
let tradeRecords = 0;
let accountTradeRecords = 0;
let fieldCoverage = { beforePosition: 0, beforeEntry: 0, timestamp: 0 };
let timer;
let finished = false;
const ws = new WebSocket("wss://mainnet.zklighter.elliot.ai/stream?readonly=true");
const percentile = (rows, q) => rows.length ? [...rows].sort((a, b) => a - b)[Math.min(rows.length - 1, Math.floor(rows.length * q))] : null;
function finish(reason) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  const report = {
    startedAt, finishedAt: Date.now(), reason, endpoint: "Lighter public readonly WebSocket", requestedAccounts: expectedAccounts,
    selectedFile: selectedFile ?? null, selectedWallets, perAccount: [...perAccount.values()], fullyAccepted: false,
    discoveredAccounts: candidates.size, sentAccounts: sent.size, acknowledgedAccounts: snapshots.size,
    accountsWithPositionSettings: [...snapshots.values()].filter(row => row.positions > 0).length,
    accountsWithOpenPositions: [...snapshots.values()].filter(row => row.openPositions > 0).length,
    accountsWithLiveUpdates: updated.size, counts, errors, bytes, tradeRecords, accountTradeRecords, fieldCoverage,
    publicTradeLagMs: { samples: tradeLags.length, p50: percentile(tradeLags, .5), p95: percentile(tradeLags, .95), max: tradeLags.length ? Math.max(...tradeLags) : null, over3000: tradeLags.filter(n => n > 3000).length, negative: tradeLags.filter(n => n < 0).length },
    accountTradeLagMs: { samples: accountTradeLags.length, p50: percentile(accountTradeLags, .5), p95: percentile(accountTradeLags, .95), max: accountTradeLags.length ? Math.max(...accountTradeLags) : null, over3000: accountTradeLags.filter(n => n > 3000).length, over5000: accountTradeLags.filter(n => n > 5000).length, negative: accountTradeLags.filter(n => n < 0).length },
    snapshots: [...snapshots.values()], positionSamples,
    limitations: ["Candidates discovered from market prints; wallet screening and opening history not verified", "Clock difference from exchange not calibrated", "Trade timestamps measure feed receive latency, not Bybit execution", "No 500-user or 100-copy-account load test in this probe", "Snapshot transaction_time may describe last account change rather than snapshot freshness"]
  };
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  ws.close();
  console.log(JSON.stringify({ report: path.join(directory, "report.json"), ...report, snapshots: undefined, positionSamples: undefined }, null, 2));
  setTimeout(() => process.exit(reason === "completed" && snapshots.size === expectedAccounts && !errors.length ? 0 : 1), 1000);
}
ws.onopen = () => {
  if (!selectedFile) for (const market of [0, 1, 2, 3, 4, 5]) ws.send(JSON.stringify({ type: "subscribe", channel: `trade/${market}` }));
  // 160 subscriptions/minute leaves room below the documented 200 client messages/minute.
  timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || sent.size >= limit) return;
    const account = [...candidates].find(id => !sent.has(id));
    if (account !== undefined) { sent.add(account); ws.send(JSON.stringify({ type: "subscribe", channel: `account_all/${account}` })); }
  }, 375);
};
ws.onmessage = ({ data }) => {
  const receivedAt = Date.now(); bytes += String(data).length;
  let message;
  try { message = JSON.parse(data); } catch { errors.push({ stage: "parse", receivedAt }); return; }
  counts[message.type] = (counts[message.type] ?? 0) + 1;
  if (message.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
  if (message.error || message.type === "error") { errors.push({ receivedAt, message }); return; }
  if (["subscribed/trade", "update/trade"].includes(message.type)) {
    for (const trade of message.trades ?? []) {
      for (const id of [trade.ask_account_id, trade.bid_account_id]) if (Number.isSafeInteger(id) && id >= 0) candidates.add(id);
      if (message.type === "update/trade") {
        tradeRecords++;
        if (Number.isFinite(trade.timestamp)) tradeLags.push(receivedAt - trade.timestamp);
        if (trade.maker_position_size_before !== undefined && trade.taker_position_size_before !== undefined) fieldCoverage.beforePosition++;
        if (trade.maker_entry_quote_before !== undefined && trade.taker_entry_quote_before !== undefined) fieldCoverage.beforeEntry++;
        if (Number.isFinite(trade.timestamp)) fieldCoverage.timestamp++;
      }
    }
  }
  if (["subscribed/account_all", "update/account_all"].includes(message.type)) {
    const id = Number(String(message.channel).split(":")[1]);
    if (message.type === "subscribed/account_all") {
      const positions = Object.values(message.positions ?? {});
      snapshots.set(id, { account: id, receivedAt, millisecondsSinceProbeStart: receivedAt - startedAt, positions: positions.length, openPositions: positions.filter(position => Number.isFinite(Number(position.position)) && Number(position.position) !== 0).length, keys: Object.keys(message), transactionTime: message.transaction_time ?? null });
      if (positions.length && positionSamples.length < 3) positionSamples.push({ account: id, position: positions[0] });
    } else {
      updated.add(id);
      for (const trade of Object.values(message.trades ?? {}).flat()) {
        accountTradeRecords++;
        if (Number.isFinite(trade.timestamp)) accountTradeLags.push(receivedAt - trade.timestamp);
        const key = `${id}:${trade.trade_id_str}`;
        if (!seenAccountTrades.has(key)) {
          seenAccountTrades.add(key);
          const stats = perAccount.get(id) ?? { account: id, uniqueExecutions: 0, missingTradeId: 0, missingTimestamp: 0, maxLagMs: null, over5000: 0, negative: 0 };
          stats.uniqueExecutions++;
          if (!trade.trade_id_str) stats.missingTradeId++;
          if (!Number.isSafeInteger(trade.timestamp)) stats.missingTimestamp++;
          else { const lag = receivedAt - trade.timestamp; stats.maxLagMs = Math.max(stats.maxLagMs ?? -Infinity, lag); if (lag > 5000) stats.over5000++; if (lag < 0) stats.negative++; }
          perAccount.set(id, stats);
        }
      }
    }
  }
};
ws.onerror = () => { errors.push({ stage: "transport", receivedAt: Date.now() }); finish("transport_error"); };
ws.onclose = event => { if (!finished) { errors.push({ stage: "close", code: event.code }); finish("early_close"); } };
setTimeout(() => finish("completed"), duration * 1000);
