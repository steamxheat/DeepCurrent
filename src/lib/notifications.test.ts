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
