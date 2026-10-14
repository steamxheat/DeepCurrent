import assert from "node:assert/strict";
import { cpSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const directory = mkdtempSync(path.join(tmpdir(), "dc-stages-7-10-"));
process.env.DEEPCURRENT_DB_PATH = path.join(directory, "fixture.sqlite");
const { getFillJournal } = await import("../src/lib/fill-journal.ts");
const { availableWalletScreenings } = await import("../src/lib/wallet-registry.ts");
const { defaultNotificationSettings } = await import("../src/lib/notifications.ts");
const store = getFillJournal(), now = Date.now();
const wallets = availableWalletScreenings().slice(0, 6).map((row, index) => ({ address: row.address, name: `QA Wallet ${index + 1}`, quality: 90 }));
assert.equal(wallets.length, 6);
store.status("targets", { wallets });
store.status("catalog", { coinNames: {}, dexNames: [""], markets: ["BTC", "ETH", "SOL"], excludedMarkets: [] });
store.status("leaderboard", { leaderboardRows: wallets.map((wallet) => ({ ethAddress: wallet.address, displayName: wallet.name, accountValue: "100000", windowPerformances: ["day", "week", "month", "allTime"].map((window) => [window, { pnl: "1000", roi: "0.1", vlm: "100000" }]) })) });
store.status("mids", { prices: { BTC: 100, ETH: 120, SOL: 100 }, receivedAt: now });
store.status("collector", { connected: false, acknowledgedMarkets: 0, exactWallets: [], marketCount: 3, lastReceive: now, mode: "shadow" });
let tid = 0;
const add = (wallet, overrides = {}) => store.ingest(wallet, { coin: "BTC", time: now - 600000 + tid * 1000, tid: ++tid, side: "B", px: "100", sz: "1", startPosition: "0", dir: "Open Long", closedPnl: "0", fee: "1", hash: `0x${"a".repeat(64)}`, ...overrides }, "userFills", "history", now);
for (const wallet of wallets.slice(0, 3)) add(wallet.address);
add(wallets[3].address, { coin: "ETH", time: now - 900000 }); add(wallets[3].address, { coin: "ETH", time: now - 3000, side: "A", startPosition: "1", closedPnl: "20", px: "120", dir: "Close Long" });
add(wallets[4].address, { coin: "SOL", startPosition: "10" });
for (let index = 0; index < 125; index++) add(wallets[5].address, { coin: "SOL", startPosition: String(index), time: now - 600000 + index * 1000, px: String(100 + index) });
store.project(1000);
for (const wallet of wallets) { store.coverage(wallet.address, "fills", now - 1000000, now, "covered_interval"); store.resource(wallet.address, "copyability", { score: 80, confidence: "high" }); }
store.resource(wallets[0].address, "subAccounts", [{ master: wallets[0].address, subAccountUser: wallets[2].address }]);
function snapshots() {
  for (const [index, wallet] of wallets.entries()) {
    const coin = index < 3 ? "BTC" : index === 3 ? "ETH" : "SOL", size = index === 0 && process.argv.includes("--soak") ? store.getState(wallet.address, coin)?.size || "0" : index < 3 ? "1" : index === 4 ? "11" : "125";
    const assetPositions = index === 3 || size === "0" ? [] : [{ position: { coin, szi: size, entryPx: "100", positionValue: String(Number(size) * 101), unrealizedPnl: size, marginUsed: "20", leverage: { value: 5 }, liquidationPx: "80" } }];
    const time = Date.now(); store.recordScope({ wallet: wallet.address, scope: "", requestedAt: time, receivedAt: time, payload: { assetPositions, marginSummary: { accountValue: "100000", totalMarginUsed: "20" }, withdrawable: "99980" } });
    store.recordScope({ wallet: wallet.address, scope: "spot", requestedAt: time, receivedAt: time, payload: { balances: [] } });
  }
}
snapshots();
const port = process.argv.includes("--soak") ? "3002" : "3001", url = `http://localhost:${port}`;
// Test runtime caches must never share the production build directory.
cpSync(path.resolve(".next"), path.join(directory, ".next"), { recursive: true, filter: (name) => !name.split(path.sep).includes("cache") });
for (const item of ["node_modules", "public", "package.json", "next.config.ts"]) symlinkSync(path.resolve(item), path.join(directory, item));
const child = spawn(process.execPath, [path.resolve("node_modules/next/dist/bin/next"), "start", "-p", port, "--hostname", "127.0.0.1"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, APP_URL: url, DC_JOURNAL_MODE: "shadow", TELEGRAM_BOT_TOKEN: process.argv.includes("--soak") ? process.env.DC_SOAK_TEST_TOKEN || "" : "", ADMIN_TELEGRAM_IDS: process.argv.includes("--soak") ? Array.from({ length: 100 }, (_, index) => String(900000 + index)).join(",") : "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" } });
child.stdout.on("data", () => {}); child.stderr.on("data", (chunk) => { const message = String(chunk); if (!message.includes("ExperimentalWarning") && !message.includes("trace-warnings")) process.stderr.write(message); });
let stopped = false; let timer;
function stop() { if (stopped) return; stopped = true; clearInterval(timer); child.kill("SIGTERM"); store.db.close(); }
process.on("SIGINT", () => { stop(); process.exit(0); }); process.on("SIGTERM", () => { stop(); process.exit(0); });
try {
  for (let retry = 0; retry < 100; retry++) {
    if (child.exitCode !== null) throw new Error("Preview server exited");
    try { if ((await fetch(`${url}/manifest.webmanifest`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let checks = 0;
  const get = async (route, expected = 200) => { const response = await fetch(`${url}${route}`); assert.equal(response.status, expected, route); checks++; return expected === 200 ? response.json() : null; };
  const open = await get(`/api/events?wallet=${wallets[0].address}&action=OPEN`); assert.equal(open.events[0].positionStatus, "open");
  const closed = await get(`/api/events?wallet=${wallets[3].address}&action=OPEN`); assert.equal(closed.events[0].positionStatus, "closed"); assert.equal(closed.events[0].netPnl, 18);
  const unknown = await get(`/api/events?wallet=${wallets[4].address}`); assert.equal(unknown.events[0].positionStatus, "unknown");
  const first = await get(`/api/events?wallet=${wallets[5].address}&order=oldest&limit=50`), second = await get(`/api/events?wallet=${wallets[5].address}&order=oldest&limit=50&offset=${first.nextOffset}&to=${first.to}`);
  assert.equal(first.events.length, 50); assert.equal(second.events.length, 50); assert.ok(first.events.at(-1).time < second.events[0].time);
  const signals = await get("/api/confluences?minutes=15&onlyOpen=true&minWallets=2&minQuality=80&minCopyability=70");
  assert.equal(signals.groups[0].independentWallets, 2); assert.equal(signals.groups[0].allEntries.length, 3); assert.equal(signals.groups[0].stillOpen, true);
  assert.equal((await get("/api/confluences?minutes=15&minWallets=4")).groups.length, 0);
  await get("/api/events?order=wrong", 400); await get("/api/events?wallets=invalid", 400); await get("/api/events?precision=wrong", 400); await get("/api/confluences?minWallets=NaN", 400);
  const session = async () => { const response = await fetch(`${url}/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: "{}" }); assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";", 1)[0]; };
  const alice = await session(), bob = await session();
  const profile = async (cookie, method, body) => { const response = await fetch(`${url}/api/notifications`, { method, headers: { cookie, origin: url, "content-type": "application/json" }, body: JSON.stringify(body) }); assert.equal(response.status, 200); checks++; return response.json(); };
  const settings = { ...defaultNotificationSettings, direction: "SHORT", minLeverage: 2, maxLeverage: 10, minCopyability: 70, minWallets: 3, confluenceMinutes: 1 };
  await profile(alice, "PUT", { favorites: [wallets[0].address], settings, preferences: { language: "en", confluenceMinWallets: 3, confluenceMinQuality: 70 } });
  assert.equal((await profile(alice, "POST", {})).settings.minCopyability, 70); assert.equal((await profile(bob, "POST", {})).favorites.length, 0);
  await profile(alice, "PUT", { favorites: [], settings }); assert.equal((await profile(alice, "POST", {})).preferences.language, "en");
  const denied = await fetch(`${url}/api/notifications`, { method: "PUT", headers: { cookie: alice, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ favorites: [], settings }) }); assert.equal(denied.status, 403); checks++;
  const unauthenticated = await fetch(`${url}/api/notifications`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.equal(unauthenticated.status, 401); checks++;
  const reversed = await fetch(`${url}/api/notifications`, { method: "PUT", headers: { cookie: alice, origin: url, "content-type": "application/json" }, body: JSON.stringify({ favorites: [], settings: { ...settings, minLeverage: 20 } }) }); assert.equal(reversed.status, 400); checks++;
  const forbiddenSession = await fetch(`${url}/api/session`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }); assert.equal(forbiddenSession.status, 403); checks++;
  const restored = await fetch(`${url}/api/session`, { method: "POST", headers: { cookie: alice, origin: url, "content-type": "application/json" }, body: "{}" }); assert.equal(restored.headers.get("set-cookie").split(";", 1)[0], alice); checks++;
  const setCookie = restored.headers.get("set-cookie"); for (const flag of ["HttpOnly", "Secure", "SameSite=lax", "Max-Age=31536000"]) assert.ok(setCookie.includes(flag), flag); checks++;
  const push = async (cookie, method = "GET", body, origin = url, expected = 200) => {
    const response = await fetch(`${url}/api/push`, { method, headers: { ...(cookie ? { cookie } : {}), origin, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, expected, `push ${method}`); checks++; return response.json();
  };
  await push(null, "GET", undefined, url, 401);
  await push(alice, "POST", { action: "clear" }, "https://evil.example", 403);
  const inboxTest = await push(alice, "POST", { action: "test" }); assert.equal(inboxTest.inboxCreated, true); assert.equal(inboxTest.pushAccepted, 0); assert.equal(inboxTest.pushFailed, false);
  assert.equal(inboxTest.notifications.length, 1); assert.ok(inboxTest.notifications[0].title.includes("notification center"));
  assert.equal((await push(bob)).notifications.length, 0);
  assert.equal((await push(alice, "POST", { action: "read" })).unread, 0);
  assert.equal((await push(alice)).notifications.length, 1);
  assert.equal((await push(alice, "POST", { action: "clear" })).notifications.length, 0);
  await push(alice, "POST", { action: "subscribe", endpoint: "https://fcm.googleapis.com/test", keys: { p256dh: "junk", auth: "junk" } }, url, 503);
  const manifest = await get("/manifest.webmanifest"); assert.equal(manifest.display, "standalone"); assert.equal(manifest.background_color, "#000000"); assert.equal(manifest.start_url, "/");
  for (const icon of manifest.icons) { const response = await fetch(`${url}${icon.src}`); assert.equal(response.status, 200); assert.ok(response.headers.get("content-type").includes("image/png")); checks++; }
  const sw = await fetch(`${url}/sw.js`); assert.equal(sw.status, 200); assert.ok((await sw.text()).includes('addEventListener("push"')); checks++;
  const englishPage = await fetch(`${url}/wallet/${wallets[0].address}`, { headers: { cookie: `${alice}; deep_current_language=en` } }); assert.equal(englishPage.status, 200);
  const html = await englishPage.text(); assert.ok(html.includes("Open positions")); assert.ok(html.includes("Fill and position event journal")); checks++;
  if (process.argv.includes("--load")) {
    const existing = new Set(wallets.map((wallet) => wallet.address));
    const extra = availableWalletScreenings().slice(0, 1000).filter((wallet) => !existing.has(wallet.address)).map((wallet, index) => ({ address: wallet.address, name: `QA Load Wallet ${index + 1}`, quality: 90 }));
    for (const [index, wallet] of extra.entries()) {
      const coin = ["BTC", "ETH", "SOL"][index % 3];
      store.ingestBatch(Array.from({ length: 20 }, (_, step) => ({ wallet: wallet.address, source: "userFills", mode: "history", fill: { coin, time: now - 120000 + step * 1000 + index, tid: step,
        px: "100", sz: "1", side: "B", startPosition: String(step), dir: step ? "Increase Long" : "Open Long", fee: "0.01", closedPnl: "0", hash: `0x${"b".repeat(64)}` } })));
      const time = Date.now();
      store.recordScopes([{ wallet: wallet.address, scope: "", requestedAt: time, receivedAt: time, payload: { assetPositions: [{ position: { coin, szi: "20", entryPx: "100", positionValue: "2020", unrealizedPnl: "20", marginUsed: "400", leverage: { value: 5 }, liquidationPx: "80" } }], marginSummary: { accountValue: "10000", totalMarginUsed: "400" }, withdrawable: "9600" } },
        { wallet: wallet.address, scope: "spot", requestedAt: time, receivedAt: time, payload: { balances: [] } }]);
    }
    store.project(2000, 10000); store.status("targets", { wallets: [...wallets, ...extra] });
  }
  console.log(JSON.stringify({ checks, url, walletUrl: `${url}/wallet/${wallets[0].address}`, wallets: wallets.map(row => row.address), fixture: directory,
    loadWallets: store.status("targets").payload.wallets.length, savedEvents: store.db.prepare("SELECT COUNT(*) count FROM lifecycle_events").get().count,
    productionChanged: false, externalNotificationsSent: false }));
  if (process.argv.includes("--keep")) {
    let ticks = 0;
    timer = setInterval(() => {
      if (process.argv.includes("--soak") && ++ticks % 3 === 0) {
        const step = Math.floor(ticks / 3 - 1) % 4, before = ["1", "2", "1", "0"][step], side = step === 1 || step === 2 ? "A" : "B";
        add(wallets[0].address, { time: Date.now(), startPosition: before, side, dir: ["Increase Long", "Reduce Long", "Close Long", "Open Long"][step], closedPnl: side === "A" ? "20" : "0" });
        store.project(100); store.coverage(wallets[0].address, "fills", now - 1000000, Date.now(), "covered_interval");
      }
      snapshots();
    }, 5000); await new Promise(() => {});
  }
} finally { stop(); }
