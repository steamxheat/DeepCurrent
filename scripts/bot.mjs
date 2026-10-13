import {
  getNotificationProfile, getSubscribersForWallet, getWatchedWallets,
  getStoredPositions, linkTelegramChat, markFillProcessed, replaceStoredPositions, setNotificationsEnabled, setStoredPosition,
} from "../src/lib/notification-store.ts";
import { classifyPositionChange, shouldNotify } from "../src/lib/notifications.ts";
import { recordCopySample, recordFundingEvents, recordOrderEvents, recordPositionSnapshots, recordWalletEvent } from "../src/lib/event-store.ts";
import { fetchWithRetry } from "../src/lib/fetch-retry.ts";
import { availableWalletScreenings } from "../src/lib/wallet-registry.ts";
import { hasPositiveMonthPnl } from "../src/lib/wallet-quality.ts";

const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.APP_URL;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in the collector process environment");

const api = `https://api.telegram.org/bot${token}`;
const aggregateDelay = 1_500;
const confluenceWindow = Math.max(60_000, Number(process.env.CONFLUENCE_WINDOW_MS) || 15 * 60_000);
const indexedWalletLimit = Math.min(1_000, Math.max(10, Number(process.env.TRACKED_WALLETS) || 1_000));
const positions = new Map();
const readyWallets = new Set();
const targetWallets = new Set();
const exactWallets = new Set();
const walletNames = new Map();
const pending = new Map();
const recentSignals = new Map();
const latestPrices = new Map();
let coinNames = {};
let marketSubscriptions = [];
let perpDexNames = [""];
let socket;
let streamStartedAt = 0;
let refreshTask;
let offset = 0;
let running = true;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const short = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const money = (value) => `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const displayCoin = (coin) => coinNames[coin] ?? coin;
const positionKey = (wallet, coin) => `${wallet}:${coin}`;

async function post(body) {
  const response = await fetchWithRetry(() => fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  if (!response.ok) throw new Error(`Hyperliquid API: ${response.status}`);
  return response.json();
}

async function telegram(method, body) {
  const response = await fetch(`${api}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method}: ${result.description}`);
  return result.result;
}

async function send(chatId, text, wallet) {
  const url = wallet && appUrl?.startsWith("https://") ? `${appUrl.replace(/\/$/, "")}/wallet/${wallet}` : appUrl;
  const replyMarkup = url?.startsWith("https://") ? { inline_keyboard: [[{ text: "Открыть Deep Current", web_app: { url } }]] } : undefined;
  return telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: replyMarkup });
}

async function leaderboard() {
  const response = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
  if (!response.ok) throw new Error(`Leaderboard: ${response.status}`);
  const payload = await response.json();
  const verified = availableWalletScreenings(); const byAddress = new Map(payload.leaderboardRows.map((row) => [row.ethAddress.toLowerCase(), row]));
  const ordered = verified.flatMap((entry) => {
    const row = byAddress.get(entry.address); const monthPnl = Number(row?.windowPerformances.find(([name]) => name === "month")?.[1]?.pnl ?? 0);
    return row && hasPositiveMonthPnl(monthPnl) ? [row] : [];
  }).slice(0, indexedWalletLimit);
  return ordered.map((row) => {
    const day = row.windowPerformances.find(([name]) => name === "day")?.[1] ?? {};
    return { address: row.ethAddress.toLowerCase(), name: row.displayName || short(row.ethAddress), pnl: Number(day.pnl || 0) };
  });
}

async function command(message) {
  const chatId = String(message.chat.id); const userId = String(message.from?.id ?? "");
  const text = (message.text || "").split("@")[0].trim().toLowerCase();
  if (!userId) return;
  if (text === "/start" || text === "/watch") {
    linkTelegramChat(userId, chatId); setNotificationsEnabled(userId, true);
    const profile = getNotificationProfile(userId);
    return send(chatId, `<b>Deep Current</b> подключён.\n\nИзбранных трейдеров: <b>${profile.favorites.length}</b>. События придут с точным временем, ценой и типом изменения позиции. Настройки находятся в мини‑приложении.`);
  }
  if (text === "/stop") { setNotificationsEnabled(userId, false); return send(chatId, "Уведомления Deep Current отключены."); }
  if (text === "/settings") return send(chatId, "Откройте настройки уведомлений в Deep Current.");
  if (text === "/top") {
    const rows = (await leaderboard()).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
    return send(chatId, `<b>Топ за день по PnL</b>\n\n${rows.map((row, index) => `${index + 1}. ${escapeHtml(row.name)} — ${row.pnl >= 0 ? "+" : ""}${money(row.pnl)}`).join("\n")}`);
  }
  return send(chatId, "Команды: /top — лидеры дня, /watch — включить уведомления, /stop — выключить, /settings — настройки.");
}

async function pollTelegram() {
  while (running) {
    try {
      const updates = await telegram("getUpdates", { offset, timeout: 45, allowed_updates: ["message"] });
      for (const update of updates) { offset = update.update_id + 1; if (update.message) await command(update.message); }
    } catch (error) { console.error("Telegram:", error.message); await sleep(3_000); }
  }
}

async function marketCatalog() {
  const [dexes, spot] = await Promise.all([post({ type: "perpDexs" }).catch(() => []), post({ type: "spotMeta" }).catch(() => ({ universe: [], tokens: [] }))]);
  perpDexNames = ["", ...dexes.flatMap((dex) => dex?.name ? [dex.name] : [])];
  const metas = await Promise.allSettled(perpDexNames.map((dex) => post({ type: "meta", ...(dex ? { dex } : {}) })));
  const markets = metas.flatMap((result) => result.status === "fulfilled" ? (result.value.universe ?? []).map((asset) => asset.name) : []).filter(Boolean);
  const tokens = new Map((spot.tokens ?? []).map((item) => [item.index, item.name ?? `Token ${item.index}`]));
  coinNames = Object.fromEntries((spot.universe ?? []).map((pair) => [`@${pair.index}`, `${tokens.get(pair.tokens?.[0]) ?? `Token ${pair.tokens?.[0]}`}/${tokens.get(pair.tokens?.[1]) ?? `Token ${pair.tokens?.[1]}`}`]));
  markets.push(...(spot.universe ?? []).map((pair) => pair.name ?? `@${pair.index}`));
  return [...new Set(markets)].slice(0, 995);
}

async function seedWallet(wallet) {
  try {
    const stored = new Map(getStoredPositions(wallet).map((position) => [position.coin, position]));
    const states = await Promise.allSettled(perpDexNames.map((dex) => post({ type: "clearinghouseState", user: wallet, ...(dex ? { dex } : {}) })));
    const capturedAt = Date.now();
    const snapshots = states.flatMap((result) => result.status === "fulfilled" ? (result.value.assetPositions ?? []).map(({ position }) => ({
      wallet, coin: position.coin, capturedAt, size: Number(position.szi), entryPx: Number(position.entryPx ?? 0),
      positionValue: Number(position.positionValue ?? 0), unrealizedPnl: Number(position.unrealizedPnl ?? 0),
      leverage: Number(position.leverage?.value ?? 1), liquidationPx: position.liquidationPx ? Number(position.liquidationPx) : null,
      marginUsed: Math.abs(Number(position.positionValue ?? 0)) / Math.max(1, Number(position.leverage?.value ?? 1)), source: "Hyperliquid clearinghouseState",
    })) : []);
    recordPositionSnapshots(snapshots);
    const rows = snapshots.map((position) => {
      const size = position.size; const previous = stored.get(position.coin);
      return { coin: position.coin, size, openedAt: previous && Math.sign(previous.size) === Math.sign(size) ? previous.openedAt : null };
    }).filter((row) => row.size);
    replaceStoredPositions(wallet, rows);
    for (const key of [...positions.keys()]) if (key.startsWith(`${wallet}:`)) positions.delete(key);
    for (const row of rows) positions.set(positionKey(wallet, row.coin), { size: row.size, openedAt: row.openedAt });
    readyWallets.add(wallet);
  } catch (error) { console.error(`Seed ${short(wallet)}:`, error.message); }
}

async function refreshTargets(reseed = false) {
  if (refreshTask) { await refreshTask; if (!reseed) return; }
  const task = (async () => {
    const [favorites, curated] = await Promise.all([Promise.resolve(getWatchedWallets()), leaderboard().catch(() => [])]);
    const wallets = [...new Set([...favorites, ...curated.map((row) => row.address)])];
    curated.forEach((row) => walletNames.set(row.address, row.name));
    const next = new Set(wallets); const exact = new Set([...favorites, ...curated.slice(0, 10).map((row) => row.address)]);
    for (const wallet of targetWallets) if (!next.has(wallet)) {
      readyWallets.delete(wallet);
      for (const key of [...positions.keys()]) if (key.startsWith(`${wallet}:`)) positions.delete(key);
    }
    targetWallets.clear(); wallets.forEach((wallet) => targetWallets.add(wallet)); exactWallets.clear(); exact.forEach((wallet) => exactWallets.add(wallet));
    for (const wallet of exact) {
      if (!reseed && readyWallets.has(wallet)) continue;
      if (reseed) readyWallets.delete(wallet);
      await seedWallet(wallet); await sleep(perpDexNames.length * 110);
    }
  })();
  refreshTask = task;
  try { await task; } finally { if (refreshTask === task) refreshTask = undefined; }
}

async function syncExactHistory() {
  const wallets = [...exactWallets].slice(0, 25);
  for (const wallet of wallets) {
    try {
      const [orders, funding] = await Promise.all([
        post({ type: "historicalOrders", user: wallet }).catch(() => []),
        post({ type: "userFunding", user: wallet, startTime: Date.now() - 86_400_000 }).catch(() => []),
      ]);
      recordOrderEvents(orders.slice(0, 500).flatMap((row) => row.order?.coin ? [{
        eventKey: `${wallet}:order:${row.order.oid ?? "unknown"}:${row.status ?? "unknown"}:${row.statusTimestamp ?? row.order.timestamp ?? 0}`, wallet,
        coin: displayCoin(row.order.coin), side: row.order.side ?? "—", status: row.status ?? "unknown",
        kind: typeof row.order.orderType === "string" ? row.order.orderType : row.order.reduceOnly ? "reduce-only" : "limit",
        limitPx: Number(row.order.limitPx ?? 0), size: Number(row.order.origSz ?? row.order.sz ?? 0),
        time: Number(row.statusTimestamp ?? row.order.timestamp ?? 0), source: "Hyperliquid historicalOrders",
      }] : []));
      recordFundingEvents(funding.slice(0, 500).flatMap((row) => row.delta?.coin && row.time ? [{
        eventKey: `${wallet}:funding:${row.hash ?? `${row.delta.coin}:${row.time}`}`, wallet, coin: displayCoin(row.delta.coin),
        time: row.time, amount: Number(row.delta.usdc ?? 0), rate: Number(row.delta.fundingRate ?? 0), size: Number(row.delta.szi ?? 0), source: "Hyperliquid userFunding",
      }] : []));
    } catch (error) { console.error(`History ${short(wallet)}:`, error.message); }
    await sleep(120);
  }
}

function confluenceCount(event) {
  if (!["OPEN", "FLIP"].includes(event.action)) return 1;
  const key = `${event.coin}:${event.direction}`; const cutoff = event.time - confluenceWindow;
  const rows = (recentSignals.get(key) ?? []).filter((row) => row.time >= cutoff && row.wallet !== event.wallet);
  rows.push({ wallet: event.wallet, time: event.time }); recentSignals.set(key, rows.slice(-200));
  return new Set(rows.map((row) => row.wallet)).size;
}

function sampleCopyability(eventKey, event) {
  if (!["OPEN", "ADD", "FLIP"].includes(event.action) || !event.price) return;
  for (const delay of [1, 3, 10, 30]) setTimeout(() => {
    const price = latestPrices.get(event.rawCoin); if (!price) return;
    const adverseBps = (event.direction === "LONG" ? price - event.price : event.price - price) / event.price * 10_000;
    recordCopySample(eventKey, event.wallet, event.coin, delay, adverseBps);
  }, delay * 1_000);
}

async function flushGroup(key) {
  const group = pending.get(key); if (!group) return;
  pending.delete(key); clearTimeout(group.timer);
  const change = classifyPositionChange(group.before, group.after);
  if (!change) return;
  const event = { ...group, ...change, coin: displayCoin(group.coin), notional: group.notional };
  const keyId = `${event.wallet}:${event.hash ?? event.time}:${event.tid ?? `${event.coin}:${event.time}`}:group`;
  recordWalletEvent({ eventKey: keyId, wallet: event.wallet, walletName: walletNames.get(event.wallet), coin: event.coin,
    action: event.action, direction: event.direction, time: event.time, price: event.price, size: event.size, notional: event.notional,
    beforeSize: event.before, afterSize: event.after, source: "Hyperliquid market WebSocket", precision: "exact", hash: event.hash, tid: event.tid });
  sampleCopyability(keyId, { ...event, rawCoin: group.coin });
  const matches = confluenceCount(event);
  const labels = { OPEN: "ОТКРЫЛ", ADD: "УВЕЛИЧИЛ", REDUCE: "СОКРАТИЛ", CLOSE: "ЗАКРЫЛ", FLIP: "ПЕРЕВЕРНУЛ", BUY: "КУПИЛ", SELL: "ПРОДАЛ" };
  const exactTime = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }).format(event.time);
  const duration = event.action === "CLOSE" && group.openedAt ? `\nВ позиции: ${Math.max(1, Math.round((event.time - group.openedAt) / 60_000))} мин.` : "";
  const text = `<b>${escapeHtml(event.coin)} · ${labels[event.action]} ${event.direction}</b>\nКошелёк: <code>${escapeHtml(short(event.wallet))}</code>\nЦена: <b>${money(event.price)}</b>\nИсполнено: ${event.size.toLocaleString("en-US")} · ${money(event.notional)}\nПозиция после: ${Math.abs(event.after).toLocaleString("en-US")} ${event.direction}${duration}\nТочное время: <code>${exactTime} MSK</code>${matches > 1 ? `\nСовпадение: <b>${matches} кошелька</b>` : ""}`;
  for (const subscriber of getSubscribersForWallet(event.wallet)) {
    if (!shouldNotify(subscriber.settings, event, matches)) continue;
    await send(subscriber.chatId, text, event.wallet).catch((error) => console.error(`Send ${subscriber.userId}:`, error.message));
  }
}

function recordTrade(trade, wallet, side) {
  if (trade.time < streamStartedAt - 2_000 || !markFillProcessed(wallet, trade.hash ?? "", trade.tid ?? `${trade.coin}:${trade.time}:${side}`, trade.time)) return;
  if (trade.coin.startsWith("@")) {
    recordWalletEvent({ eventKey: `${wallet}:${trade.hash ?? trade.time}:${trade.tid ?? `${trade.coin}:${side}`}`, wallet, walletName: walletNames.get(wallet),
      coin: displayCoin(trade.coin), action: side, direction: side === "BUY" ? "LONG" : "SHORT", time: trade.time,
      price: Number(trade.px), size: Number(trade.sz), notional: Math.abs(Number(trade.px) * Number(trade.sz)),
      source: "Hyperliquid market WebSocket", precision: "observed", hash: trade.hash, tid: trade.tid });
    return;
  }
  if (!readyWallets.has(wallet)) {
    recordWalletEvent({ eventKey: `${wallet}:${trade.hash ?? trade.time}:${trade.tid ?? `${trade.coin}:${side}`}`, wallet, walletName: walletNames.get(wallet),
      coin: displayCoin(trade.coin), action: side, direction: side === "BUY" ? "LONG" : "SHORT", time: trade.time,
      price: Number(trade.px), size: Number(trade.sz), notional: Math.abs(Number(trade.px) * Number(trade.sz)),
      source: "Hyperliquid market WebSocket", precision: "observed", hash: trade.hash, tid: trade.tid });
    return;
  }
  const coin = trade.coin; const key = positionKey(wallet, coin); const current = positions.get(key) ?? { size: 0, openedAt: null };
  const delta = Number(trade.sz) * (side === "BUY" ? 1 : -1); const rawSize = current.size + delta; const nextSize = Math.abs(rawSize) < 1e-10 ? 0 : rawSize;
  const openedAt = current.size === 0 || Math.sign(current.size) !== Math.sign(nextSize) ? trade.time : nextSize === 0 ? null : current.openedAt;
  positions.set(key, { size: nextSize, openedAt }); setStoredPosition(wallet, coin, nextSize, openedAt, trade.time);
  const groupKey = `${key}:${side}:${trade.hash ?? trade.time}`; const existing = pending.get(groupKey);
  if (existing) {
    clearTimeout(existing.timer); existing.after = nextSize; existing.size += Math.abs(delta); existing.notional += Math.abs(delta) * Number(trade.px); existing.price = existing.notional / existing.size; existing.time = Math.max(existing.time, trade.time);
    existing.timer = setTimeout(() => flushGroup(groupKey).catch(console.error), aggregateDelay);
  } else {
    const group = { wallet, coin, before: current.size, after: nextSize, openedAt: current.openedAt, size: Math.abs(delta), notional: Math.abs(delta) * Number(trade.px), price: Number(trade.px), time: trade.time, hash: trade.hash, tid: trade.tid };
    group.timer = setTimeout(() => flushGroup(groupKey).catch(console.error), aggregateDelay); pending.set(groupKey, group);
  }
}

function handleTrades(trades) {
  for (const trade of trades ?? []) { latestPrices.set(trade.coin, Number(trade.px)); for (const [index, address] of (trade.users ?? []).entries()) {
    const wallet = String(address).toLowerCase(); if (targetWallets.has(wallet)) recordTrade(trade, wallet, index === 0 ? "BUY" : "SELL");
  } }
}

async function connectMarkets() {
  streamStartedAt = Date.now();
  socket = new WebSocket("wss://api.hyperliquid.xyz/ws");
  socket.onopen = () => {
    marketSubscriptions.forEach((coin) => socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } })));
    console.log(`Market stream connected: ${marketSubscriptions.length} markets, ${targetWallets.size} indexed wallets, ${exactWallets.size} exact`);
  };
  socket.onmessage = ({ data }) => { try { const message = JSON.parse(data); if (message.channel === "trades") handleTrades(message.data); } catch (error) { console.error("WebSocket message:", error.message); } };
  socket.onclose = async () => { if (!running) return; console.error("Market stream disconnected; resyncing positions"); await sleep(3_000); await refreshTargets(true); connectMarkets().catch(console.error); };
  socket.onerror = () => socket.close();
}

await telegram("setMyCommands", { commands: [
  { command: "start", description: "Подключить Deep Current" }, { command: "top", description: "Лидеры дня" },
  { command: "watch", description: "Включить уведомления" }, { command: "stop", description: "Отключить уведомления" },
  { command: "settings", description: "Настройки уведомлений" },
] });
marketSubscriptions = await marketCatalog();
await refreshTargets();
setInterval(() => refreshTargets().catch(console.error), 180_000);
setInterval(() => syncExactHistory().catch(console.error), 60_000);
syncExactHistory().catch(console.error);
setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ method: "ping" })), 45_000);
process.on("SIGINT", () => { running = false; socket?.close(); process.exit(0); });
console.log("Deep Current collector started");
connectMarkets().catch(console.error);
await pollTelegram();
