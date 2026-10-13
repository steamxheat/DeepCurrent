import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultNotificationSettings } from "./notifications.ts";
import { defaultUserPreferences } from "./user-preferences.ts";

test("keeps favorites and preferences isolated per Telegram user", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deep-current-settings-"));
  process.env.DEEPCURRENT_DB_PATH = path.join(directory, "test.sqlite");
  const store = await import(`./notification-store.ts?test=${Date.now()}`);
  const wallet = "0x0000000000000000000000000000000000000001";
  store.saveNotificationProfile("alice", [wallet], defaultNotificationSettings, { ...defaultUserPreferences, language: "en", privacy: true });
  store.saveNotificationProfile("bob", [], defaultNotificationSettings, { ...defaultUserPreferences, language: "ru", privacy: false });
  assert.deepEqual(store.getNotificationProfile("alice").favorites, [wallet]);
  assert.equal(store.getNotificationProfile("alice").preferences.language, "en");
  assert.equal(store.getNotificationProfile("alice").preferences.privacy, true);
  assert.deepEqual(store.getNotificationProfile("bob").favorites, []);
  assert.equal(store.getNotificationProfile("bob").preferences.language, "ru");
  assert.equal(store.getNotificationProfile("bob").preferences.privacy, false);
  const rules = { ...defaultNotificationSettings, includeOpens: false, direction: "SHORT" as const, minCopyability: 70, minWallets: 3, confluenceMinutes: 1 };
  store.saveNotificationProfile("alice", [wallet], rules, { ...defaultUserPreferences, confluenceMinQuality: 80, confluenceMinWallets: 3 });
  assert.equal(store.getNotificationProfile("alice").settings.minCopyability, 70);
  assert.equal(store.getNotificationProfile("alice").settings.includeOpens, false);
  assert.equal(store.getNotificationProfile("bob").settings.includeOpens, true);
  assert.equal(store.getNotificationProfile("alice").preferences.confluenceMinQuality, 80);
});

test("stores browser push subscriptions and an isolated notification inbox", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deep-current-push-"));
  process.env.DEEPCURRENT_DB_PATH = path.join(directory, "test.sqlite");
  const store = await import(`./notification-store.ts?push=${Date.now()}`);
  store.savePushSubscription("browser-a", { endpoint: "https://push.example/a", p256dh: "key", auth: "auth" });
  assert.equal(store.hasPushSubscription("browser-a"), true);
  assert.equal(store.pushSubscriptionsForUser("browser-a").length, 1);
  store.recordInboxNotification("browser-a", "event-1", "BTC · OPEN LONG", "$10K @ $100", "/wallet/0x1", 100);
  store.recordInboxNotification("browser-a", "event-1", "duplicate", "duplicate", "/", 101);
  assert.equal(store.recentInboxNotifications("browser-a").length, 1);
  assert.equal(store.recentInboxNotifications("browser-b").length, 0);
  store.markInboxRead("browser-a");
  assert.equal(store.recentInboxNotifications("browser-a")[0]?.readAt !== null, true);
  store.clearInbox("browser-a");
  store.removePushSubscription("browser-a", "https://push.example/a");
  assert.equal(store.recentInboxNotifications("browser-a").length, 0);
  assert.equal(store.hasPushSubscription("browser-a"), false);
});
