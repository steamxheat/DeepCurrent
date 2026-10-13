import assert from "node:assert/strict";
import test from "node:test";
import { classifyPositionChange, defaultNotificationSettings, isQuietTime, normalizeNotificationSettings, shouldNotify } from "./notifications.ts";

test("classifies the complete position lifecycle", () => {
  assert.equal(classifyPositionChange(0, 2)?.action, "OPEN");
  assert.equal(classifyPositionChange(2, 3)?.action, "ADD");
  assert.equal(classifyPositionChange(3, 1)?.action, "REDUCE");
  assert.equal(classifyPositionChange(1, 0)?.action, "CLOSE");
  assert.deepEqual(classifyPositionChange(-1, 2), { action: "FLIP", direction: "LONG", before: -1, after: 2 });
});

test("normalizes notification input at the API boundary", () => {
  const value = normalizeNotificationSettings({ minNotional: -1, coins: [" btc ", "BTC", "eth"], quietStart: "25:00", timezone: "bad/timezone" });
  assert.equal(value.minNotional, 0);
  assert.deepEqual(value.coins, ["BTC", "ETH"]);
  assert.equal(value.quietStart, "");
  assert.equal(value.timezone, "Europe/Moscow");
  assert.equal(value.inAppEnabled, true);
  assert.equal(value.webPushEnabled, true);
  assert.equal(value.telegramEnabled, true);
  assert.equal(normalizeNotificationSettings({ inAppEnabled: false, webPushEnabled: false, telegramEnabled: false }).webPushEnabled, false);
});

test("quiet hours work when they cross midnight", () => {
  const settings = { ...defaultNotificationSettings, quietStart: "23:00", quietEnd: "07:00", timezone: "UTC" };
  assert.equal(isQuietTime(settings, Date.UTC(2026, 0, 1, 23, 30)), true);
  assert.equal(isQuietTime(settings, Date.UTC(2026, 0, 1, 12)), false);
});

test("filters additions, size, coins and confluence", () => {
  const event = { action: "ADD" as const, coin: "BTC", notional: 10_000, time: Date.UTC(2026, 0, 1, 12) };
  assert.equal(shouldNotify({ ...defaultNotificationSettings, includeAdds: false }, event), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, minNotional: 20_000 }, event), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, coins: ["ETH"] }, event), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, confluenceOnly: true }, event, 2), true);
});

test("new notification rules reject unknown metrics and match explicit markets or base symbols", () => {
  const event = { action: "OPEN" as const, direction: "SHORT", coin: "xyz:BTC", notional: 10_000, time: 100, leverage: 5, copyability: 80 };
  assert.equal(shouldNotify({ ...defaultNotificationSettings, coins: ["BTC"], direction: "SHORT", minCopyability: 70, minLeverage: 2, maxLeverage: 10 }, event), true);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, direction: "LONG" }, event), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, minCopyability: 70 }, { ...event, copyability: undefined }), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, minLeverage: 1 }, { ...event, leverage: undefined }), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, includeOpens: false }, event), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, includeCloses: false }, { ...event, action: "CLOSE" }), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, confluenceOnly: true, minWallets: 3 }, event, 2), false);
  assert.equal(shouldNotify(defaultNotificationSettings, { ...event, notional: NaN }), false);
  assert.equal(shouldNotify({ ...defaultNotificationSettings, coins: ["BTC/USDC"] }, { ...event, coin: "BTC/USDT" }), false);
});

test("notification normalization migrates old profiles and quiet time uses delivery time", () => {
  const settings = normalizeNotificationSettings({ minNotional: Infinity, minLeverage: NaN, minCopyability: 1000, minWallets: 1, confluenceMinutes: 1 });
  assert.equal(settings.minNotional, 5000); assert.equal(settings.minCopyability, 100); assert.equal(settings.minLeverage, 0); assert.equal(settings.minWallets, 2); assert.equal(settings.confluenceMinutes, 1);
  const quiet = { ...defaultNotificationSettings, timezone: "UTC", quietStart: "23:00", quietEnd: "07:00" };
  assert.equal(shouldNotify(quiet, { action: "OPEN", coin: "BTC", notional: 10000, time: Date.UTC(2026, 1, 1, 22) }, 1, Date.UTC(2026, 1, 1, 23)), false);
});

test("a delayed entry notification is suppressed once closure or absence is known", () => {
  const event = { action: "OPEN" as const, coin: "BTC", notional: 10000, time: 100 };
  assert.equal(shouldNotify(defaultNotificationSettings, { ...event, positionStatus: "closed" }), false);
  assert.equal(shouldNotify(defaultNotificationSettings, { ...event, positionStatus: "absent" }), false);
  assert.equal(shouldNotify(defaultNotificationSettings, { ...event, positionStatus: "unknown" }), true);
  assert.equal(shouldNotify(defaultNotificationSettings, { ...event, action: "CLOSE", positionStatus: "closed" }), true);
});
