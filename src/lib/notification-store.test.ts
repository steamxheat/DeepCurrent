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
});
