const token = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.APP_URL;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in .env.local or your process environment");

const api = `https://api.telegram.org/bot${token}`;
const watchers = new Set();
const seen = new Set();
let offset = 0;
let running = true;

async function telegram(method, body) {
  const response = await fetch(`${api}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method}: ${result.description}`);
  return result.result;
}

async function send(chatId, text, withApp = false) {
  const replyMarkup = withApp && appUrl?.startsWith("https://")
    ? { inline_keyboard: [[{ text: "Открыть Deep Current", web_app: { url: appUrl } }]] }
    : undefined;
  return telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: replyMarkup });
}

async function leaderboard() {
  // shortcut: watchers are selected from an undocumented public leaderboard, move them to the product database before launch.
  const payload = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard").then((response) => response.json());
  return payload.leaderboardRows.slice(0, 200).map((row) => {
    const day = row.windowPerformances.find(([name]) => name === "day")?.[1] ?? {};
    return { address: row.ethAddress, name: row.displayName || `${row.ethAddress.slice(0, 6)}…${row.ethAddress.slice(-4)}`, pnl: Number(day.pnl || 0), volume: Number(day.vlm || 0) };
  });
}

async function command(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").split("@")[0].trim().toLowerCase();
  if (text === "/start") return send(chatId, "<b>Deep Current</b> отслеживает публичные сделки сильных кошельков Hyperliquid.\n\nБез копитрейдинга и обещаний доходности — только данные.", true);
  if (text === "/watch") {
    watchers.add(chatId);
    return send(chatId, "Live-уведомления включены для этого чата. Команда /stop отключит их.", true);
  }
  if (text === "/stop") {
    watchers.delete(chatId);
    return send(chatId, "Live-уведомления отключены.");
  }
  if (text === "/top") {
    const rows = (await leaderboard()).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
    return send(chatId, `<b>Топ за день по PnL</b>\n\n${rows.map((row, index) => `${index + 1}. ${row.name} — ${row.pnl >= 0 ? "+" : ""}$${Math.round(row.pnl).toLocaleString("en-US")}`).join("\n")}`, true);
  }
  return send(chatId, "Команды: /top — лидеры дня, /watch — уведомления, /stop — выключить.", true);
}

async function poll() {
  while (running) {
    try {
      const updates = await telegram("getUpdates", { offset, timeout: 45, allowed_updates: ["message"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await command(update.message);
      }
    } catch (error) {
      console.error(error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function monitor() {
  if (!watchers.size) return;
  try {
    const rows = (await leaderboard()).sort((a, b) => b.volume - a.volume).slice(0, 10);
    const startTime = Date.now() - 75_000;
    for (const row of rows) {
      const fills = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "userFillsByTime", user: row.address, startTime, aggregateByTime: true }),
      }).then((response) => response.json());
      for (const fill of fills.filter((item) => item.dir.toLowerCase().includes("open")).slice(-3)) {
        if (seen.has(fill.hash)) continue;
        seen.add(fill.hash);
        const direction = fill.dir.toLowerCase().includes("short") ? "SHORT" : "LONG";
        const text = `<b>${fill.coin} · ${direction}</b>\n${row.name} открыл позицию\nЦена: $${Number(fill.px).toLocaleString("en-US")} · Размер: ${fill.sz}`;
        await Promise.all([...watchers].map((chatId) => send(chatId, text, true).catch(console.error)));
      }
    }
    if (seen.size > 2_000) seen.clear();
  } catch (error) { console.error("Monitor:", error.message); }
}

await telegram("setMyCommands", { commands: [
  { command: "start", description: "Открыть Deep Current" },
  { command: "top", description: "Лидеры дня" },
  { command: "watch", description: "Включить live-уведомления" },
  { command: "stop", description: "Отключить уведомления" },
] });
console.log("Deep Current bot started");
setInterval(monitor, 60_000);
process.on("SIGINT", () => { running = false; process.exit(0); });
await poll();
