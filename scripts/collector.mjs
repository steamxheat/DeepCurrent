import { randomUUID } from "node:crypto";
import { statfsSync, statSync } from "node:fs";
import path from "node:path";
import { getNotificationProfile, getSubscribersForWallet, getWatchedWallets, linkTelegramChat, recordInboxNotification, setNotificationsEnabled, pushSubscriptionsForUser } from "../src/lib/notification-store.ts";
import { shouldNotify } from "../src/lib/notifications.ts";
import { decimalAdd, fillTransition, orderFillChain } from "../src/lib/position-reducer.ts";
import { sendWebPush, webPushConfigured } from "../src/lib/web-push-delivery.ts";
import { recordFundingEvents, recordOrderEvents } from "../src/lib/event-store.ts";
import { getFillJournal, validWalletAddress } from "../src/lib/fill-journal.ts";
import { recoverFills } from "../src/lib/fill-recovery.ts";
import { createInfoClient } from "../src/lib/hyperliquid-client.ts";
import { availableWalletScreenings } from "../src/lib/wallet-registry.ts";
import { hasPositiveMonthPnl, walletQuality } from "../src/lib/wallet-quality.ts";
import { copyabilityScore } from "../src/lib/copyability.ts";
import { normalizePerpPortfolio } from "../src/lib/portfolio.ts";
import { readConfluences } from "../src/lib/confluence-data.ts";
import { walletMoney, walletPrice } from "../src/lib/wallet-format.ts";
import { transaction } from "../src/lib/database.ts";
import { createSocketBudget } from "../src/lib/socket-budget.ts";
import { snapshotRefreshScopes, streamScopeSnapshots } from "../src/lib/wallet-snapshot.ts";
import { createConfirmationQueue } from "../src/lib/confirmation-queue.ts";
import { missingUserSubscriptions, selectStreamWallets } from "../src/lib/stream-wallets.ts";
import { createCollectorHealth, diagnosticError } from "../src/lib/collector-health.ts";

const journal = getFillJournal(); const owner = randomUUID();
const health = createCollectorHealth(journal.db, owner);
const client = createInfoClient(fetch, (details) => health.event("http", details)); const post = client.post;
const mode = process.env.DC_JOURNAL_MODE === "live" ? "live" : "shadow";
const token = process.env.TELEGRAM_BOT_TOKEN; const appUrl = process.env.APP_URL;
let running = true; let socket; let offset = 0; let lastReceive = 0; let diskCheckedAt = 0; let freeBytes = 0; let disconnectedAt = 0;
let subscriptionLimited = false;
let dexNames = [""]; let markets = []; let excludedMarkets = []; let coinNames = {}; let mids = {}; let midsAt = 0;
const targets = new Map(); const subscribedUsers = new Set(); const ack = new Set(); const recoverQueue = new Set();
const subscribedAt = new Map(); const lastTrade = new Map();
let watchedWallets = new Set();
const seenMarkets = new Set();
const confirmations = createConfirmationQueue(); let confirmationRequests = 0; let confirmationFailures = 0;
let fillsChanged = 0; let fillsRepeated = 0; let fillsRejected = 0;
const pendingSubscriptions = new Map(); const takeSocketMessage = createSocketBudget();
const activeWork = new Set(); const snapshotDue = new Map(); const resourceDue = new Map(); const historyDue = new Map(); const resourcesInFlight = new Set();
const subscriptions = new Map(); const timers = []; const limit = Math.min(1000, Math.max(10, Number(process.env.TRACKED_WALLETS) || 1000));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const money = walletMoney;
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

journal.db.exec("CREATE TABLE IF NOT EXISTS collector_lock (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at INTEGER NOT NULL)");
function renewLock() {
  transaction(journal.db, () => {
    const lock = journal.db.prepare("SELECT * FROM collector_lock WHERE id=1").get();
    if (lock && lock.owner !== owner && lock.expires_at > Date.now()) throw new Error("Another collector already owns this database");
    journal.db.prepare("INSERT INTO collector_lock VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at").run(owner, Date.now() + 30_000);
  });
}
renewLock();
health.event("start", { stage: mode });

async function telegram(method, body) {
  if (!token) throw new Error("Telegram is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(method === "getUpdates" ? 55_000 : 20_000) });
  const result = await response.json(); if (!result.ok) throw new Error(`Telegram: ${result.description}`); return result.result;
}
function send(chatId, text, wallet) {
  const url = wallet && appUrl?.startsWith("https://") ? `${appUrl.replace(/\/$/, "")}/wallet/${wallet}` : appUrl;
  return telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: url?.startsWith("https://") ? { inline_keyboard: [[{ text: "Открыть Deep Current", web_app: { url } }]] } : undefined });
}
async function pollTelegram() {
  while (running) {
    try {
      const updates = await telegram("getUpdates", { offset, timeout: 45, allowed_updates: ["message"] });
      for (const update of updates) {
        offset = update.update_id + 1; const message = update.message; if (!message?.from) continue;
        const id = String(message.from.id); const chat = String(message.chat.id); const command = (message.text || "").split("@")[0].trim().toLowerCase();
        if (["/start", "/watch"].includes(command)) { linkTelegramChat(id, chat); setNotificationsEnabled(id, true); await send(chat, `<b>Deep Current</b> подключён.\nИзбранных трейдеров: ${getNotificationProfile(id).favorites.length}. Настройки уведомлений — в личном кабинете.`); }
        else if (command === "/stop") { setNotificationsEnabled(id, false); await send(chat, "Уведомления Deep Current отключены."); }
        else if (command === "/top") await send(chat, `<b>Топ за день</b>\n${[...targets.values()].sort((a, b) => b.pnl - a.pnl).slice(0, 5).map((row) => `${escapeHtml(row.name)} — ${money(row.pnl)}`).join("\n")}`);
        else await send(chat, "Команды: /top, /watch, /stop. Настройки — в личном кабинете Deep Current.");
      }
    } catch (error) { console.error("Telegram:", error.message); await sleep(3000); }
  }
}
async function refreshTargets() {
  const response = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Leaderboard: ${response.status}`);
  const payload = await response.json(); const byAddress = new Map(payload.leaderboardRows.map((row) => [row.ethAddress.toLowerCase(), row]));
  journal.status("leaderboard", payload);
  const rows = availableWalletScreenings().flatMap((entry) => {
    const row = byAddress.get(entry.address); const month = Number(row?.windowPerformances.find(([name]) => name === "month")?.[1]?.pnl ?? 0);
    const day = row?.windowPerformances.find(([name]) => name === "day")?.[1]; const week = row?.windowPerformances.find(([name]) => name === "week")?.[1]; const monthData = row?.windowPerformances.find(([name]) => name === "month")?.[1];
    return row && hasPositiveMonthPnl(month) ? [{ address: row.ethAddress.toLowerCase(), name: row.displayName || short(row.ethAddress), pnl: Number(day?.pnl || 0), score: walletQuality({ accountValue: Number(row.accountValue), monthPnl: month, monthVolume: Number(monthData?.vlm), weekPnl: Number(week?.pnl), monthRoi: Number(monthData?.roi) * 100, dayPnl: Number(day?.pnl) }) }] : [];
  }).slice(0, limit);
  const low = Math.min(...rows.map((row) => row.score)), high = Math.max(...rows.map((row) => row.score));
  targets.clear(); for (const row of rows) targets.set(row.address, { ...row, quality: low === high ? 50 : Math.round(40 + (row.score - low) / (high - low) * 60) });
  watchedWallets = new Set(getWatchedWallets());
  for (const wallet of watchedWallets) if (validWalletAddress(wallet) && !targets.has(wallet)) targets.set(wallet, { address: wallet, name: short(wallet), pnl: 0 });
  journal.status("targets", { wallets: [...targets.values()], sourceCount: payload.leaderboardRows.length });
}
async function catalog() {
  const [dexes, spot] = await Promise.all([post({ type: "perpDexs" }), post({ type: "spotMeta" })]);
  dexNames = ["", ...dexes.flatMap((row) => row?.name ? [row.name] : [])];
  const metadata = await Promise.all(dexNames.map((dex) => post({ type: "meta", ...(dex ? { dex } : {}) })));
  const tokens = new Map((spot.tokens ?? []).map((row) => [row.index, row.name]));
  coinNames = Object.fromEntries((spot.universe ?? []).map((row) => [`@${row.index}`, `${tokens.get(row.tokens[0])}/${tokens.get(row.tokens[1])}`]));
  const all = [...new Set([...metadata.flatMap((meta) => (meta.universe ?? []).map((row) => row.name)), ...(spot.universe ?? []).map((row) => row.name ?? `@${row.index}`)])];
  const budget = 1000 - 10 * 4 - dexNames.length;
  markets = all.slice(0, budget); excludedMarkets = all.slice(budget);
  journal.status("catalog", { markets, excludedMarkets, dexNames, coinNames, spot });
}
async function marketTickers() {
  for (const [name, url] of [["binance", "https://api.binance.com/api/v3/ticker/24hr"], ["bybit", "https://api.bybit.com/v5/market/tickers?category=spot"]]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (name === "binance" ? !Array.isArray(payload) : payload.retCode !== 0 || !Array.isArray(payload.result?.list)) throw new Error("Invalid ticker response");
      journal.status(`tickers:${name}`, payload);
    } catch (error) { console.error(`${name} tickers:`, error.message); }
  }
}
function subscribe(subscription, method = "subscribe") {
  const key = JSON.stringify(subscription);
  if (method === "subscribe") subscriptions.set(key, subscription); else { subscriptions.delete(key); ack.delete(key); }
  pendingSubscriptions.set(key, { method, subscription });
}
function flushSubscriptions() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  let sent = 0;
  const priority = (message) => message.method === "unsubscribe" ? 0 : message.subscription.user ? 1 : message.subscription.type === "allMids" ? 2 : 3;
  for (const [key, message] of [...pendingSubscriptions].sort((a, b) => priority(a[1]) - priority(b[1]))) {
    if (subscriptionLimited && message.method === "subscribe" && message.subscription.type === "trades") continue;
    if (sent >= 50 || !takeSocketMessage()) break;
    socket.send(JSON.stringify(message)); pendingSubscriptions.delete(key); sent++;
  }
}
function selectUsers() {
  watchedWallets = new Set(getWatchedWallets());
  for (const wallet of watchedWallets) if (validWalletAddress(wallet) && !targets.has(wallet)) targets.set(wallet, { address: wallet, name: short(wallet), pnl: 0 });
  const selected = selectStreamWallets({ active: journal.activeWallets().filter(validWalletAddress), favorites: [...watchedWallets].filter(validWalletAddress),
    ranked: [...targets.keys()], subscribedAt, lastTrade, now: Date.now() });
  for (const wallet of subscribedUsers) if (!selected.includes(wallet)) {
    for (const type of ["userFills", "allDexsClearinghouseState", "userFundings"]) subscribe({ type, user: wallet, ...(type === "userFills" ? { aggregateByTime: false } : {}) }, "unsubscribe");
    subscribedUsers.delete(wallet); subscribedAt.delete(wallet);
  }
  for (const wallet of selected) if (!subscribedUsers.has(wallet)) {
    subscribedUsers.add(wallet); subscribedAt.set(wallet, Date.now());
    if (!journal.getCoverage(wallet)) recoverQueue.add(wallet);
  }
  // A rejected subscription is not an acknowledgement; retry on the bounded 10-second selection tick.
  for (const subscription of missingUserSubscriptions(subscribedUsers, ack)) subscribe(subscription);
}
function ingestBatch(rows) {
  for (let start = 0; start < rows.length; start += 500) {
    const results = journal.ingestBatch(rows.slice(start, start + 500));
    const errors = results.filter((result) => result.error);
    fillsChanged += results.filter((result) => result.changed).length; fillsRepeated += results.filter((result) => !result.changed && !result.error).length; fillsRejected += errors.length;
    if (errors.length) {
      // Keep a bounded example set per batch; total rejected count is always recorded.
      results.flatMap((result, index) => result.error ? [{ ...result, input: rows[start + index] }] : []).slice(0, 10).forEach((result) => health.event("fill_rejected", { wallet: result.input.wallet, coin: result.input.fill?.coin, fillId: result.id, count: errors.length, error: String(result.error) }));
      console.error("Fill evidence:", errors.length, errors[0].error);
    }
  }
}
function orders(wallet, rows) {
  recordOrderEvents(rows.flatMap((row) => row.order?.coin ? [{ eventKey: `${wallet}:order:${row.order.oid}:${row.status}:${row.statusTimestamp}`, wallet,
    coin: row.order.coin, side: row.order.side, status: row.status ?? "unknown", kind: typeof row.order.orderType === "string" ? row.order.orderType : "limit",
    limitPx: Number(row.order.limitPx), size: Number(row.order.origSz ?? row.order.sz), time: Number(row.statusTimestamp ?? row.order.timestamp), source: "Hyperliquid orders" }] : []));
}
function funding(wallet, rows) {
  recordFundingEvents(rows.flatMap((row) => row.time && (row.coin || row.delta?.coin) ? [{ eventKey: `${wallet}:funding:${row.hash ?? `${row.coin ?? row.delta.coin}:${row.time}`}`, wallet,
    coin: row.coin ?? row.delta.coin, time: row.time, amount: Number(row.usdc ?? row.delta.usdc), rate: Number(row.fundingRate ?? row.delta.fundingRate), size: Number(row.szi ?? row.delta.szi), source: "Hyperliquid funding" }] : []));
}
function handle(message) {
  lastReceive = Date.now();
  if (message.channel === "subscriptionResponse") { if (message.data?.method === "subscribe") ack.add(JSON.stringify(message.data.subscription)); return; }
  if (message.channel === "error") {
    health.event("stream_error", { error: diagnosticError(new Error(String(message.data))), stage: "subscription" }); journal.status("streamError", message.data);
    if (/more than 1000 channels/i.test(String(message.data))) {
      if (!subscriptionLimited) console.error("Subscription capacity reached; public market coverage is incomplete. Check other consumers on this IP.");
      subscriptionLimited = true;
    } else console.error("Subscription error:", message.data);
    return;
  }
  if (message.channel === "allMids") { mids = { ...mids, ...message.data?.mids }; midsAt = lastReceive; return; }
  const batch = [];
  const initialMarkets = new Set((message.channel === "trades" ? message.data ?? [] : []).map((trade) => trade.coin).filter((coin) => !seenMarkets.has(coin)));
  if (message.channel === "trades") for (const trade of message.data ?? []) for (const [i, address] of (trade.users ?? []).entries()) {
    const wallet = String(address).toLowerCase(); if (!targets.has(wallet)) continue;
    if (Number.isSafeInteger(trade.time) && trade.time <= lastReceive && trade.time >= lastReceive - 60_000) lastTrade.set(wallet, Math.max(lastTrade.get(wallet) ?? 0, trade.time));
    batch.push({ wallet, fill: { ...trade, side: i === 0 ? "B" : "A", dir: i === 0 ? "Buy" : "Sell" }, source: "market", mode: initialMarkets.has(trade.coin) || trade.time < Date.now() - 10_000 ? "history" : mode, receivedAt: lastReceive });
    if (!subscribedUsers.has(wallet) || !ack.has(JSON.stringify({ type: "userFills", user: wallet, aggregateByTime: false }))) {
      if (journal.getCoverage(wallet)?.status === "gap") recoverQueue.add(wallet);
      if (!initialMarkets.has(trade.coin) && trade.time >= lastReceive - 10_000) confirmations.enqueue(wallet, trade.time, lastReceive);
    }
  }
  for (const coin of initialMarkets) seenMarkets.add(coin);
  const wallet = String(message.data?.user ?? "").toLowerCase();
  if (message.channel === "userFills") for (const fill of message.data?.fills ?? []) batch.push({ wallet, fill, source: "userFills", mode: message.data.isSnapshot === true ? "history" : mode, receivedAt: lastReceive });
  if (batch.length) ingestBatch(batch);
  if (message.channel === "allDexsClearinghouseState") journal.recordScopes(streamScopeSnapshots(wallet, message.data?.clearinghouseStates, lastReceive));
  if (message.channel === "userFundings") funding(wallet, message.data?.fundings ?? []);
}
function connect() {
  if (!running) return; subscriptionLimited = false; ack.clear(); seenMarkets.clear(); socket = new WebSocket("wss://api.hyperliquid.xyz/ws");
  const wallets = [...new Set([...targets.keys(), ...subscribedUsers, ...journal.activeWallets()])];
  journal.markStreamGap(wallets, "stream_restart");
  const active = new Set(journal.activeWallets());
  for (const wallet of wallets) if (journal.getCoverage(wallet) || active.has(wallet) || watchedWallets.has(wallet)) recoverQueue.add(wallet);
  socket.onopen = () => { health.event("connect", { durationMs: disconnectedAt ? Date.now() - disconnectedAt : 0, count: subscriptions.size }); disconnectedAt = 0; pendingSubscriptions.clear(); for (const subscription of subscriptions.values()) pendingSubscriptions.set(JSON.stringify(subscription), { method: "subscribe", subscription }); };
  socket.onmessage = ({ data }) => { try { handle(JSON.parse(String(data))); } catch (error) { health.event("stream_error", { error: diagnosticError(error), stage: "parse_or_ingest" }); journal.status("streamError", { message: error.message }); console.error("Stream:", error.message); } };
  socket.onerror = () => socket.close();
  socket.onclose = (event) => {
    disconnectedAt ||= Date.now(); health.event("disconnect", { code: event.code, clean: event.wasClean, stage: running ? "unexpected" : "shutdown" });
    ack.clear(); const wallets = [...new Set([...targets.keys(), ...subscribedUsers, ...journal.activeWallets()])];
    journal.markStreamGap(wallets);
    const active = new Set(journal.activeWallets());
    for (const wallet of wallets) if (journal.getCoverage(wallet) || active.has(wallet) || watchedWallets.has(wallet)) recoverQueue.add(wallet);
    if (running) timers.push(setTimeout(connect, 3000));
  };
}
async function recover(wallet, priority) {
  const started = Date.now();
  const covered = journal.getCoverage(wallet);
  const seed = await post({ type: "userFills", user: wallet, aggregateByTime: false }, priority);
  const end = Date.now();
  ingestBatch(seed.map((fill) => ({ wallet, fill, source: "userFills", mode: "history" })));
  const seedStart = seed.length ? Math.min(...seed.map((fill) => fill.time)) : end;
  const from = Math.min(end, Math.max(0, (covered?.through_time ?? seedStart) - 1));
  const result = await recoverFills(from, end, (start, stop) => post({ type: "userFillsByTime", user: wallet, startTime: start, endTime: stop, aggregateByTime: false }, priority), 16);
  ingestBatch(result.fills.map((fill) => ({ wallet, fill, source: "userFills", mode: "history" })));
  // Only the recent seed proves API retention; an empty old range cannot prove no missing fills.
  const provenFrom = Math.max(from, seedStart);
  journal.coverage(wallet, "fills", result.complete ? provenFrom : from, result.complete ? end : Math.max(from, covered?.through_time ?? from), result.complete ? "covered_interval" : "gap", result.complete ? "older_history_not_proven" : JSON.stringify(result.gaps)); journal.project(100, 50);
  health.event("recovery_ok", { wallet, from, through: end, complete: result.complete, count: result.fills.length, durationMs: Date.now() - started });
  for (const gap of result.gaps) health.event("recovery_failed", { wallet, from: gap.from, through: gap.to, error: gap.reason, stage: "incomplete_interval" });
}
async function historyLoop() {
  while (running) {
    const candidates = [...new Set([...journal.activeWallets(), ...subscribedUsers, ...watchedWallets, ...recoverQueue])];
    const wallet = candidates.find((address) => Date.now() >= (historyDue.get(address) ?? 0));
    if (!wallet) { await sleep(500); continue; } recoverQueue.delete(wallet);
    try { await recover(wallet, journal.activeWallets().includes(wallet) ? 2 : 4); historyDue.set(wallet, Date.now() + 300_000); }
    catch (error) { health.event("recovery_failed", { wallet, error: diagnosticError(error) }); recoverQueue.add(wallet); const covered = journal.getCoverage(wallet); journal.coverage(wallet, "fills", covered?.from_time ?? Date.now(), covered?.through_time ?? Date.now(), "gap", error.message); historyDue.set(wallet, Date.now() + 30_000); }
  }
}
async function confirmationLoop() {
  while (running) {
    const active = new Set(journal.activeWallets());
    const task = confirmations.take((wallet) => active.has(wallet) ? 0 : watchedWallets.has(wallet) ? 1 : 2);
    if (!task) { await sleep(100); continue; }
    let confirmed = false;
    try {
      const rows = await post({ type: "userFillsByTime", user: task.wallet, startTime: task.from, endTime: task.through, aggregateByTime: false }, 0);
      if (!Array.isArray(rows) || rows.length > 2000) throw new Error("Invalid confirmation response");
      confirmationRequests++;
      ingestBatch(rows.map((fill) => ({ wallet: task.wallet, fill, source: "userFills", mode: "history" })));
      confirmed = !journal.hasUnconfirmed(task.wallet, task.from, task.through);
      if (rows.length === 2000 || !confirmed) recoverQueue.add(task.wallet);
      journal.project(100, 10);
    } catch (error) { health.event("confirmation_failed", { wallet: task.wallet, error: diagnosticError(error) }); confirmationFailures++; console.error("Fill confirmation:", error.message); recoverQueue.add(task.wallet); }
    confirmations.complete(task.wallet, task.through, confirmed);
  }
}
async function snapshotWallet(wallet, priority) {
  const streaming = subscribedUsers.has(wallet) && ack.has(JSON.stringify({ type: "allDexsClearinghouseState", user: wallet }));
  const scopes = snapshotRefreshScopes(journal.scopes(wallet), dexNames, streaming);
  await Promise.all(scopes.map(async (scope) => {
    const requestedAt = Date.now();
    try {
      const payload = await post(scope === "spot" ? { type: "spotClearinghouseState", user: wallet } : { type: "clearinghouseState", user: wallet, ...(scope ? { dex: scope } : {}) }, priority);
      if (scope !== "spot" && !Array.isArray(payload.assetPositions)) throw new Error("Invalid scoped position response");
      journal.recordScope({ wallet, scope, requestedAt, receivedAt: Date.now(), payload });
    } catch (error) { health.event("snapshot_failed", { wallet, scope, durationMs: Date.now() - requestedAt, error: diagnosticError(error) }); journal.recordScope({ wallet, scope, requestedAt, receivedAt: Date.now(), error: error.message }); }
  })); snapshotDue.set(wallet, Date.now() + (priority <= 1 ? 8000 : 300_000));
}
async function resourceWallet(wallet) {
  if (!journal.resource(wallet, "subAccounts") || Date.now() - journal.resource(wallet, "subAccounts").updatedAt > 86400000) {
    try { journal.resource(wallet, "subAccounts", await post({ type: "subAccounts", user: wallet }, 3)); } catch (error) { health.event("resource_failed", { wallet, operation: "subAccounts", error: diagnosticError(error) }); console.error("Subaccount relationships:", error.message); }
  }
  const results = await Promise.allSettled(["portfolio", "historicalOrders", "userFunding"].map(async (type) => {
    const payload = await post({ type, user: wallet, ...(type === "userFunding" ? { startTime: Date.now() - 30 * 86_400_000 } : {}) }, type === "portfolio" ? 2 : 3);
    journal.resource(wallet, type, payload); if (type === "historicalOrders") orders(wallet, payload); if (type === "userFunding") funding(wallet, payload);
  }));
  results.forEach((result, index) => { if (result.status === "rejected") health.event("resource_failed", { wallet, operation: ["portfolio", "historicalOrders", "userFunding"][index], error: diagnosticError(result.reason) }); });
  const exact = journal.events(0, 10000, wallet).filter((event) => event.precision === "exact");
  const portfolio = normalizePerpPortfolio(journal.resource(wallet, "portfolio")?.payload ?? []);
  journal.resource(wallet, "copyability", copyabilityScore({ fills: exact, closedTrades: journal.completed(wallet), accountValue: portfolio.month.accountValue }));
  resourceDue.set(wallet, Date.now() + (results.some((row) => row.status === "rejected") ? 30_000 : 120_000));
}
async function snapshotLoop(foreground) {
  let cursor = 0;
  while (running) {
    const active = journal.activeWallets(); const activeSet = new Set(active);
    const background = foreground ? [] : [...targets.keys()].filter((address) => !activeSet.has(address));
    const wallet = foreground ? active.find((address) => !activeWork.has(address) && Date.now() >= (snapshotDue.get(address) ?? 0))
      : background[cursor++ % Math.max(1, background.length)];
    if (!wallet || activeWork.has(wallet) || Date.now() < (snapshotDue.get(wallet) ?? 0)) { await sleep(100); continue; }
    activeWork.add(wallet);
    try { await snapshotWallet(wallet, activeSet.has(wallet) ? 1 : 4); }
    finally { activeWork.delete(wallet); }
  }
}
async function resourcesLoop() {
  while (running) {
    const wallet = journal.activeWallets().find((address) => !resourcesInFlight.has(address) && Date.now() >= (resourceDue.get(address) ?? 0));
    if (!wallet) { await sleep(500); continue; }
    resourcesInFlight.add(wallet);
    try { await resourceWallet(wallet); } finally { resourcesInFlight.delete(wallet); }
  }
}
function prepareSignals() {
  for (const group of journal.readySignals()) {
    const fills = orderFillChain(group.fills.filter((fill) => fill.precision === "exact")).fills; if (!fills.length) { journal.completeSignal(group.id, []); continue; }
    const first = fills[0]; const last = fills.at(-1); const wallet = first.wallet;
    const size = fills.reduce((sum, fill) => decimalAdd(sum, fill.sz), "0"); const notional = fills.reduce((sum, fill) => sum + Number(fill.sz) * Number(fill.px), 0);
    const coin = coinNames[first.coin] ?? first.coin; const grouped = fillTransition({ ...first, sz: size });
    const evidence = journal.evidence([last])[0]; const model = journal.resource(wallet, "copyability");
    const event = { action: grouped?.action ?? last.action, coin, notional, time: last.time, direction: grouped?.direction ?? last.direction,
      rawCoin: first.coin, fillIds: fills.map((fill) => fill.id), positionStatus: evidence.positionStatus,
      leverage: evidence.positionStatus === "open" ? evidence.leverage : undefined,
      copyability: model && Date.now() - model.updatedAt < 300000 && model.payload.confidence !== "low" && Number.isFinite(model.payload.score) ? model.payload.score : undefined };
    if (["OPEN", "ADD", "FLIP"].includes(event.action) && evidence.positionStatus === "absent") { journal.completeSignal(group.id, []); continue; }
    const time = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "medium" }).format(last.time);
    const title = `${coin} · ${event.action} ${grouped?.direction ?? last.direction}`; const body = `${targets.get(wallet)?.name ?? short(wallet)} · ${money(notional)} @ ${walletPrice(notional / Number(size))} · ${time} MSK · статус позиции: ${evidence.positionStatus} · задержка ${(Math.max(0, Date.now() - last.time) / 1000).toFixed(1)}с`;
    const status = evidence.positionStatus === "open" ? "активна в свежем снимке" : evidence.positionStatus === "closed" ? "уже закрыта" : "текущее состояние не подтверждено";
    const text = `<b>${escapeHtml(title)}</b>\nКошелёк: <code>${wallet}</code>\nЦена: ${walletPrice(notional / Number(size))}\nИсполнено: ${size} · ${money(notional)}\nПозиция после исполнения: ${grouped?.after ?? "неизвестна"}\nПроверка при подготовке (${new Date().toISOString()}): ${status}\nПлечо: ${event.leverage ?? "неизвестно"}\nПервое исполнение: ${new Date(first.time).toISOString()}\nПоследнее: ${new Date(last.time).toISOString()}\n${fills.length} исполнений одной группы\nПолучено с задержкой ${(Math.max(0, Date.now() - last.time) / 1000).toFixed(1)}с`;
    const deliveries = []; const inbox = [];
    for (const subscriber of getSubscribersForWallet(wallet)) {
      const confluence = subscriber.settings.confluenceOnly ? readConfluences(subscriber.settings.confluenceMinutes).groups.find((row) => row.coin === first.coin && row.direction === event.direction && row.allEntries.some((entry) => entry.wallet === wallet)) : undefined;
      const matches = confluence?.independentWallets ?? 1;
      if (!shouldNotify(subscriber.settings, event, matches, Date.now())) continue;
      const url = `/wallet/${wallet}`;
      if (subscriber.settings.inAppEnabled) inbox.push(() => recordInboxNotification(subscriber.userId, group.id, title, body, url, last.time));
      if (subscriber.settings.webPushEnabled && webPushConfigured()) for (const subscription of pushSubscriptionsForUser(subscriber.userId)) deliveries.push({ recipient: subscriber.userId, channel: "push", destination: subscription.endpoint, payload: { title, body, url, wallet, event, matches, endpoint: subscription.endpoint } });
      if (token && subscriber.chatId && subscriber.settings.telegramEnabled) deliveries.push({ recipient: subscriber.userId, channel: "telegram", payload: { chatId: subscriber.chatId, text, wallet, event, matches } });
    }
    journal.completeSignal(group.id, deliveries, () => inbox.forEach((run) => run()));
  }
}
async function deliverLoop() {
  while (running) {
    if (mode !== "live") { await sleep(1000); continue; }
    prepareSignals(); const delivery = journal.claimDelivery(); if (!delivery) { await sleep(250); continue; }
    try {
      const profile = getNotificationProfile(delivery.recipient); const payload = delivery.payload;
      const proofs = Array.isArray(payload.event?.fillIds) ? journal.db.prepare("SELECT payload FROM lifecycle_events WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(payload.event.fillIds)).map((row) => JSON.parse(row.payload)) : [];
      if (!proofs.length || proofs.length !== payload.event.fillIds.length || proofs.some((fill) => fill.precision !== "exact")) { journal.finishDelivery(delivery.id, "cancelled_unconfirmed_evidence"); continue; }
      const latest = proofs.sort((a, b) => b.time - a.time)[0];
      const currentEvent = { ...payload.event, positionStatus: journal.evidence([latest])[0].positionStatus };
      const confluence = profile.settings.confluenceOnly ? readConfluences(profile.settings.confluenceMinutes).groups.find((row) => row.coin === (Object.entries(coinNames).find(([, value]) => value === payload.event.coin)?.[0] ?? payload.event.coin) && row.direction === payload.event.direction && row.allEntries.some((entry) => entry.wallet === payload.wallet)) : undefined;
      const matches = confluence?.independentWallets ?? 1;
      if (Date.now() - payload.event.time > 300000 || !profile.favorites.includes(payload.wallet) || !shouldNotify(profile.settings, currentEvent, matches, Date.now()) || !profile.settings[delivery.channel === "push" ? "webPushEnabled" : "telegramEnabled"]) { journal.finishDelivery(delivery.id, "cancelled_by_settings_or_stale"); continue; }
      const receipt = delivery.channel === "push" ? await sendWebPush(delivery.recipient, { ...payload, eventId: delivery.id }) : await send(payload.chatId, payload.text, payload.wallet);
      if (delivery.channel === "push" && receipt === 0) { journal.finishDelivery(delivery.id, "cancelled_no_active_subscription"); continue; }
      journal.finishDelivery(delivery.id, JSON.stringify(receipt));
    } catch (error) { health.event("delivery_failed", { operation: delivery.channel, attempt: delivery.attempts, error: diagnosticError(error) }); journal.finishDelivery(delivery.id, undefined, error.message); }
  }
}
function heartbeat() {
  if (Date.now() - diskCheckedAt > 60_000) {
    const filename = process.env.DEEPCURRENT_DB_PATH || path.join(process.cwd(), ".data", "deep-current.sqlite");
    const disk = statfsSync(path.dirname(filename)); freeBytes = Number(disk.bavail) * Number(disk.bsize); diskCheckedAt = Date.now();
    journal.status("storage", { freeBytes, databaseBytes: statSync(filename).size, checkedAt: diskCheckedAt });
    if (freeBytes < 1024 ** 3) { health.event("storage_stop"); console.error("Collector stopped: less than 1 GiB free disk; recovery required after restart"); stop(); return; }
  }
  renewLock(); journal.status("mids", { prices: mids, receivedAt: midsAt });
  journal.status("collector", { mode, connected: socket?.readyState === WebSocket.OPEN, acknowledgedMarkets: markets.filter((coin) => ack.has(JSON.stringify({ type: "trades", coin }))).length,
    exactUsers: [...subscribedUsers].filter((user) => ack.has(JSON.stringify({ type: "userFills", user, aggregateByTime: false }))).length,
    exactWallets: [...subscribedUsers].filter((user) => ack.has(JSON.stringify({ type: "userFills", user, aggregateByTime: false }))),
    marketCount: markets.length, excludedMarkets, subscriptionLimited, pendingSubscriptions: pendingSubscriptions.size, indexedWallets: targets.size, lastReceive, pendingRequests: client.pending(), activeRequests: client.active(),
    recoveryBacklog: recoverQueue.size, freeBytes, revision: journal.revision() });
  journal.status("confirmations", { ...confirmations.stats(), requests: confirmationRequests, failures: confirmationFailures, budget: client.budget() });
  const stats = confirmations.stats(); const memory = process.memoryUsage();
  health.sample({ connected: socket?.readyState === WebSocket.OPEN, lastReceive, recoveryBacklog: recoverQueue.size,
    pendingRequests: client.pending(), activeRequests: client.active(), confirmationBacklog: stats.pending, confirmationOldestAgeMs: stats.oldestAgeMs,
    confirmationExpired: stats.expired, confirmationRejected: stats.rejected, confirmationFailures, cooldownUntil: client.budget().cooldownUntil,
    freeBytes, rssBytes: memory.rss, heapBytes: memory.heapUsed, indexedWallets: targets.size, fillsChanged, fillsRepeated, fillsRejected,
    acknowledgedMarkets: markets.filter((coin) => ack.has(JSON.stringify({ type: "trades", coin }))).length,
    exactUsers: [...subscribedUsers].filter((user) => ack.has(JSON.stringify({ type: "userFills", user, aggregateByTime: false }))).length });
}
function stop() {
  health.event("stop");
  running = false; timers.forEach((timer) => { clearTimeout(timer); clearInterval(timer); }); socket?.close();
  try { journal.project(1000); } catch (error) { console.error("Pending projection preserved for restart:", error.message); }
  journal.status("collector", { connected: false, mode, stoppedAt: Date.now() }); journal.db.prepare("DELETE FROM collector_lock WHERE owner=?").run(owner); process.exit(0);
}
process.on("SIGINT", stop); process.on("SIGTERM", stop);
process.on("uncaughtExceptionMonitor", (error) => { try { health.event("fatal", { error: diagnosticError(error) }); } catch { /* Preserve the original fatal error if storage is unavailable. */ } });
function fatal(stage, error) { health.event("fatal", { stage, error: diagnosticError(error) }); console.error(stage, error); stop(); }
await refreshTargets(); await catalog();
for (const coin of markets) subscribe({ type: "trades", coin }); subscribe({ type: "allMids" });
selectUsers(); connect();
timers.push(setInterval(heartbeat, 1000), setInterval(() => { try { journal.project(100, 10); } catch (error) { health.event("projection_failed", { error: diagnosticError(error) }); console.error("Projection:", error.message); } }, 200), setInterval(selectUsers, 10_000), setInterval(() => refreshTargets().catch((error) => { health.event("targets_failed", { error: diagnosticError(error) }); console.error("Targets:", error.message); }), 180_000), setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ method: "ping" })), 30_000));
timers.push(setInterval(flushSubscriptions, 100));
historyLoop().catch((error) => fatal("history_loop", error));
for (const foreground of [true, false]) snapshotLoop(foreground).catch((error) => fatal(foreground ? "foreground_snapshot" : "background_snapshot", error));
resourcesLoop().catch((error) => fatal("resources_loop", error)); deliverLoop().catch((error) => fatal("delivery_loop", error));
for (const event of journal.events(Date.now() - 60_000, 10_000)) if (event.source === "market" && targets.has(event.wallet)) confirmations.enqueue(event.wallet, event.time);
for (let i = 0; i < 2; i++) confirmationLoop().catch((error) => fatal("confirmation_loop", error));
void marketTickers(); timers.push(setInterval(() => void marketTickers(), 60_000));
if (token && mode === "live") pollTelegram().catch(console.error);
console.log(`Deep Current journal v2: ${targets.size} wallets, ${markets.length} markets, mode=${mode}`);
