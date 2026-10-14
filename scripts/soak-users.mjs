import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { setPriority } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { defaultNotificationSettings } from "../src/lib/notifications.ts";
import { createQaBehavior } from "../src/lib/qa-behavior.ts";

const hours = Number(process.argv[2] ?? 8), periodMs = Number(process.argv[3] ?? 30000);
assert.ok(hours > 0 && hours <= 24 && periodMs >= 1000 && periodMs <= 60000);
const userCount = Number(process.env.DC_SOAK_USERS ?? 100), concurrency = Number(process.env.DC_SOAK_CONCURRENCY ?? 4);
assert.ok(Number.isInteger(userCount) && userCount >= 1 && userCount <= 500);
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= Math.min(50, userCount));
const started = Date.now(), deadline = started + hours * 3600000;
const randomized = process.argv.includes("--random"), seed = Number(process.env.DC_SOAK_SEED ?? started % 4294967296);
assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295);
const behavior = createQaBehavior(seed);
const directory = process.env.DC_SOAK_RUN_DIR || path.resolve("backups", `qa-soak-${started}`);
assert.ok(directory.startsWith(path.resolve("backups") + path.sep + "qa-soak-"), "Logs must stay in a dedicated QA directory");
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (process.argv.includes("--detach")) {
  const fd = openSync(path.join(directory, "runner.log"), "a", 0o600);
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/soak-users.mjs", String(hours), String(periodMs), ...(randomized ? ["--random"] : []), ...(process.argv.includes("--load") ? ["--load"] : [])], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, DC_SOAK_SEED: String(seed), DC_SOAK_RUN_DIR: directory, NODE_OPTIONS: "--max-old-space-size=384" } });
  closeSync(fd); child.unref(); console.log(JSON.stringify({ pid: child.pid, directory, hours, sessions: userCount, concurrency })); process.exit(0);
}
try { setPriority(0, 10); } catch {}
const logfile = path.join(directory, "actions.jsonl"), summaryfile = path.join(directory, "summary.json");
const token = randomBytes(32).toString("hex"), users = Array.from({ length: userCount }, (_, id) => ({ id, cookie: "", actions: 0, errors: 0, dueAt: 0 }));
const log = (entry) => appendFileSync(logfile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
let fixture, checks = 0, failures = 0, round = 0, stopping = false;
const scenarioCounts = {};
const production = process.env.DC_SOAK_PRODUCTION_URL; let slowProduction = 0;
assert.ok(!production || production === "http://127.0.0.1:3000", "Production guard is read-only and localhost-only");
const summary = (state) => writeFileSync(summaryfile, JSON.stringify({ state, started, updatedAt: Date.now(), deadline, randomized, seed, scenarioCounts, users: users.length, concurrency, checks, failures, round, fixture, sessions: users.map(({ id, actions, errors }) => ({ id, actions, errors })), scope: `${userCount} virtual HTTP sessions with at most ${concurrency} concurrent action chains, isolated SQLite/admin state, localhost-only. Not complete browsers, paid entitlement/billing or actual phone Push delivery.` }, null, 2), { mode: 0o600 });
const server = spawn(process.execPath, ["--experimental-strip-types", "scripts/check-stages-7-10.mjs", "--keep", "--soak", ...(process.argv.includes("--load") ? ["--load"] : [])], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DC_SOAK_TEST_TOKEN: token } });
let output = "";
server.stdout.on("data", (chunk) => {
  output += chunk; let boundary;
  while ((boundary = output.indexOf("\n")) >= 0) {
    const line = output.slice(0, boundary); output = output.slice(boundary + 1);
    try { const value = JSON.parse(line); if (value.fixture) fixture = value; } catch {}
  }
  if (output.length > 200000) { log({ stage: "fixture_output_overflow" }); stop(); }
});
server.stderr.on("data", (chunk) => log({ stage: "fixture_server", message: String(chunk).slice(0, 3000) }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stop = () => { stopping = true; server.kill("SIGTERM"); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
function adminData(id) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 900000 + id, first_name: `QA ${id}` }) });
  const data = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  params.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(token).digest()).update(data).digest("hex")); return params.toString();
}
async function request(user, route, method = "GET", body, expected = 200, admin = false, origin) {
  const begin = Date.now(), url = fixture.url;
  try {
    const response = await fetch(url + route, { method, signal: AbortSignal.timeout(10000), headers: { origin: origin || url, cookie: user.cookie, "content-type": "application/json", ...(admin ? { "x-telegram-init-data": adminData(user.id) } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(), ms = Date.now() - begin;
    log({ user: user.id, round, route, method, expected, actual: response.status, ms, bytes: text.length }); checks++; user.actions++;
    assert.equal(response.status, expected, `${method} ${route}: ${text.slice(0, 300)}`); assert.ok(ms < 5000, `Slow request: ${ms}ms`);
    if (route === "/api/session" && !admin && response.headers.has("set-cookie")) user.cookie = response.headers.get("set-cookie").split(";", 1)[0];
    return /(?:application\/json|application\/manifest\+json)/.test(response.headers.get("content-type") || "") ? JSON.parse(text) : text;
  } catch (error) { failures++; user.errors++; log({ user: user.id, round, route, method, stage: "assertion_failed", error: error.message }); throw error; }
}
async function action(user) {
  if (!user.cookie) { await request(user, "/api/session", "POST", {}); return; }
  if (randomized && Date.now() < user.dueAt) return;
  const next = randomized ? behavior(user.id) : { step: (round + user.id) % 13, choice: user.id, pauseMs: 0 };
  const step = next.step, choice = next.choice;
  scenarioCounts[step] = (scenarioCounts[step] ?? 0) + 1;
  user.dueAt = Date.now() + next.pauseMs;
  log({ stage: "scenario", user: user.id, round, step, choice, persona: user.id % 4, pauseMs: next.pauseMs, seed });
  const wallet = randomized && fixture.wallets?.length ? fixture.wallets[choice % fixture.wallets.length] : fixture.walletUrl.split("/").at(-1);
  switch (step) {
    case 0: { const before = user.cookie; await request(user, "/api/session", "POST", {}); assert.equal(user.cookie, before); break; }
    case 1: { const value = await request(user, `/api/wallet/${wallet}/watch`, "POST"); assert.equal(value.snapshot.address, wallet); assert.ok(value.snapshot.positions.every((position) => Number.isFinite(position.size) && position.size !== 0)); break; }
    case 2: { const value = await request(user, `/api/events?order=${user.id % 2 ? "oldest" : "newest"}&limit=100&precision=exact`); assert.equal(new Set(value.events.map((row) => row.id)).size, value.events.length); break; }
    case 3: await request(user, `/api/confluences?minutes=${[1, 5, 15, 60, 240, 1440][user.id % 6]}&minWallets=${2 + user.id % 3}&onlyOpen=true`); break;
    case 4: { const language = user.id % 2 ? "en" : "ru"; await request(user, "/api/notifications", "PUT", { favorites: [wallet], settings: { ...defaultNotificationSettings, minNotional: user.id * 100, direction: user.id % 2 ? "LONG" : "SHORT" }, preferences: { language } }); const saved = await request(user, "/api/notifications", "POST", {}); assert.deepEqual(saved.favorites, [wallet]); assert.equal(saved.preferences.language, language); assert.equal(saved.settings.minNotional, user.id * 100); break; }
    case 5: { const value = await request(user, "/api/push", "POST", { action: "test" }); assert.equal(value.pushAccepted, 0); assert.equal(value.inboxCreated, true); await request(user, "/api/push", "POST", { action: "read" }); await request(user, "/api/push", "POST", { action: "clear" }); break; }
    case 6: { await request(user, "/api/session", "POST", { initData: adminData(user.id) }, 200, true); const value = await request(user, "/api/admin", "POST", { action: "setConfig", key: ["trackedWallets", "signalThreshold", "confluenceMinutes"][user.id % 3], value: 100 }, 200, true); assert.ok(value.config); break; }
    case 7: await request(user, "/api/events?precision=wrong", "GET", undefined, 400); await request(user, "/api/push", "POST", { action: "clear" }, 403, false, "https://evil.example"); break;
    case 8: { const value = await request(user, "/manifest.webmanifest"); assert.equal(value.display, "standalone"); await request(user, "/sw.js"); break; }
    case 9: await request(user, `/wallet/${wallet}`); break;
    case 10: await request(user, "/coin/BTC"); break;
    case 11: await request(user, user.id % 2 ? "/" : "/api/admin", "GET", undefined, user.id % 2 ? 200 : 401); break;
    case 12: {
      const began = Date.now(), response = await fetch(fixture.url + "/api/live", { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200);
      const reader = response.body.getReader(); let frame = "";
      try { while (!frame.includes("\n\n")) { const row = await reader.read(); assert.equal(row.done, false); frame += new TextDecoder().decode(row.value); } const payload = JSON.parse(frame.slice(6).split("\n\n")[0]); assert.ok(Number.isFinite(payload.serverAt)); }
      finally { await reader.cancel(); }
      checks++; user.actions++; log({ user: user.id, round, route: "/api/live", stage: "sse_frame", ms: Date.now() - began }); break;
    }
    case 13: {
      const order = ["newest", "oldest", "largest", "price", "price-asc"][choice % 5];
      const coin = ["BTC", "ETH", "SOL"][choice % 3], direction = choice % 2 ? "LONG" : "SHORT";
      const query = `/api/events?coin=${coin}&direction=${direction}&order=${order}&limit=10&minNotional=${choice % 500}`;
      const first = await request(user, query);
      assert.ok(first.events.every(row => row.coin === coin && row.direction === direction && Number(row.px) * Number(row.sz) >= choice % 500));
      if (first.nextOffset !== null) { const second = await request(user, `${query}&to=${first.to}&offset=${first.nextOffset}`); assert.ok(second.events.every(row => !first.events.some(previous => previous.id === row.id))); }
      break;
    }
    case 14: {
      const query = `?open=${["time-asc", "time-desc", "entry-asc", "pnl-desc", "notional-asc", "notional-desc"][choice % 6]}&fills=${choice % 2 ? "price-asc" : "time-desc"}&closed=${choice % 2 ? "duration-desc" : "pnl-asc"}`;
      await request(user, `/wallet/${wallet}${query}`); await request(user, "/"); await request(user, `/wallet/${wallet}${query}`); break;
    }
    case 15: {
      const language = choice % 2 ? "ru" : "en", favorites = choice % 3 ? [wallet] : [];
      await request(user, "/api/notifications", "PUT", { favorites, settings: { ...defaultNotificationSettings, minNotional: choice % 10000, coins: ["BTC", "ETH"], quietStart: "23:00", quietEnd: "07:00" }, preferences: { language, activitySort: "oldest" } });
      const saved = await request(user, "/api/notifications", "POST", {});
      assert.deepEqual(saved.favorites, favorites); assert.equal(saved.preferences.language, language);
      assert.equal(saved.settings.minNotional, choice % 10000); assert.deepEqual(saved.settings.coins, ["BTC", "ETH"]);
      assert.equal(saved.settings.quietStart, "23:00"); assert.equal(saved.settings.quietEnd, "07:00");
      await request(user, "/api/events?limit=0", "GET", undefined, 400); break;
    }
  }
}
try {
  for (let wait = 0; !fixture && wait < 300; wait++) { assert.equal(server.exitCode, null, "Fixture exited before startup"); await sleep(100); }
  assert.ok(fixture, "Fixture did not start"); log({ stage: "started", users: userCount, concurrency, fixture: fixture.fixture, durationHours: hours }); summary("running");
  while (!stopping && Date.now() < deadline) {
    assert.equal(server.exitCode, null, "Fixture server stopped"); const began = Date.now(); let index = 0, roundErrors = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { while (!stopping && index < users.length) { const user = users[index++], beforeErrors = user.errors; try { await action(user); } catch (error) { roundErrors++; if (user.errors === beforeErrors) { failures++; user.errors++; } log({ stage: "scenario_failed", user: user.id, round, error: error.message }); } } }));
    round++; summary("running"); if (roundErrors >= 5) throw new Error("Five failures in one round; stopped to avoid repeated load");
    if (production) {
      const began = Date.now(); let ok = false;
      try { const response = await fetch(production + "/api/events?limit=1", { signal: AbortSignal.timeout(5000) }); await response.arrayBuffer(); ok = response.ok && Date.now() - began < 2000; } catch {}
      log({ stage: "production_guard", ok, ms: Date.now() - began }); slowProduction = ok ? 0 : slowProduction + 1;
      if (slowProduction >= 2) throw new Error("Production guard failed twice; QA load stopped");
    }
    await sleep(Math.max(0, Math.min(periodMs - (Date.now() - began), deadline - Date.now())));
  }
  summary(stopping ? "stopped" : failures ? "failed" : "complete"); if (failures) process.exitCode = 1;
  console.log(JSON.stringify({ directory, users: users.length, checks, failures, round, seed, scenarioCounts }));
} catch (error) { log({ stage: "fatal", error: error.message }); summary("failed"); process.exitCode = 1; console.error(error.message); }
finally { stop(); }
