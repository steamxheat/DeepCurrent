import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultNotificationSettings, normalizeNotificationSettings, type NotificationSettings } from "./notifications.ts";
import { defaultUserPreferences, normalizeUserPreferences, type UserPreferences } from "./user-preferences.ts";

export type NotificationProfile = {
  favorites: string[];
  settings: NotificationSettings;
  preferences: UserPreferences;
  chatLinked: boolean;
};

export type NotificationSubscriber = {
  userId: string;
  chatId: string;
  settings: NotificationSettings;
};

export type StoredPosition = { wallet: string; coin: string; size: number; openedAt: number | null; updatedAt: number };
type UserRow = { chat_id: string | null; settings: string | null; preferences: string | null };
type FavoriteRow = { address: string };
type WalletRow = { address: string };
type SubscriberRow = { user_id: string; chat_id: string; settings: string | null };
type PositionRow = { wallet: string; coin: string; size: number; opened_at: number | null; updated_at: number };

const databasePath = process.env.DEEPCURRENT_DB_PATH || path.join(process.cwd(), ".data", "deep-current.sqlite");
mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS notification_users (
    user_id TEXT PRIMARY KEY,
    chat_id TEXT,
    settings TEXT NOT NULL,
    preferences TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS favorite_wallets (
    user_id TEXT NOT NULL,
    address TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, address)
  );
  CREATE INDEX IF NOT EXISTS favorite_wallets_address ON favorite_wallets(address);
  CREATE TABLE IF NOT EXISTS wallet_positions (
    wallet TEXT NOT NULL,
    coin TEXT NOT NULL,
    size REAL NOT NULL,
    opened_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (wallet, coin)
  );
  CREATE TABLE IF NOT EXISTS processed_fills (
    event_key TEXT PRIMARY KEY,
    occurred_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS processed_fills_time ON processed_fills(occurred_at);
`);
if (!(db.prepare("PRAGMA table_info(notification_users)").all() as Array<{ name: string }>).some((column) => column.name === "preferences")) {
  db.exec("ALTER TABLE notification_users ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}'");
}

const readSettings = (value: string | null | undefined) => {
  try { return normalizeNotificationSettings(JSON.parse(value ?? "{}")); } catch { return defaultNotificationSettings; }
};
const readPreferences = (value: string | null | undefined) => {
  try { return normalizeUserPreferences(JSON.parse(value ?? "{}")); } catch { return { ...defaultUserPreferences, hiddenMarkets: [] }; }
};

function ensureUser(userId: string) {
  db.prepare("INSERT OR IGNORE INTO notification_users (user_id, chat_id, settings, updated_at) VALUES (?, NULL, ?, ?)")
    .run(userId, JSON.stringify(defaultNotificationSettings), Date.now());
}

export function getNotificationProfile(userId: string): NotificationProfile {
  ensureUser(userId);
  const user = db.prepare("SELECT chat_id, settings, preferences FROM notification_users WHERE user_id = ?").get(userId) as UserRow;
  const favorites = db.prepare("SELECT address FROM favorite_wallets WHERE user_id = ? ORDER BY added_at").all(userId) as FavoriteRow[];
  return { favorites: favorites.map((row) => row.address), settings: readSettings(user.settings), preferences: readPreferences(user.preferences), chatLinked: Boolean(user.chat_id) };
}

export function saveNotificationProfile(userId: string, favorites: string[], settings: NotificationSettings, preferences?: UserPreferences) {
  ensureUser(userId);
  const cleanFavorites = [...new Set(favorites.map((address) => address.toLowerCase()))];
  const normalized = normalizeNotificationSettings(settings);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE notification_users SET settings = ?, preferences = COALESCE(?, preferences), updated_at = ? WHERE user_id = ?")
      .run(JSON.stringify(normalized), preferences ? JSON.stringify(normalizeUserPreferences(preferences)) : null, Date.now(), userId);
    db.prepare("DELETE FROM favorite_wallets WHERE user_id = ?").run(userId);
    const insert = db.prepare("INSERT INTO favorite_wallets (user_id, address, added_at) VALUES (?, ?, ?)");
    cleanFavorites.forEach((address, index) => insert.run(userId, address, Date.now() + index));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getNotificationProfile(userId);
}

export function linkTelegramChat(userId: string, chatId: string) {
  ensureUser(userId);
  db.prepare("UPDATE notification_users SET chat_id = ?, updated_at = ? WHERE user_id = ?").run(chatId, Date.now(), userId);
}

export function setNotificationsEnabled(userId: string, enabled: boolean) {
  const profile = getNotificationProfile(userId);
  saveNotificationProfile(userId, profile.favorites, { ...profile.settings, enabled });
}

export function getWatchedWallets() {
  return (db.prepare(`SELECT DISTINCT f.address FROM favorite_wallets f JOIN notification_users u ON u.user_id = f.user_id
    WHERE json_extract(u.settings, '$.enabled') != 0`).all() as WalletRow[]).map((row) => row.address);
}

export function getSubscribersForWallet(wallet: string): NotificationSubscriber[] {
  return (db.prepare(`SELECT u.user_id, u.chat_id, u.settings FROM notification_users u JOIN favorite_wallets f ON f.user_id = u.user_id
    WHERE f.address = ? AND u.chat_id IS NOT NULL`).all(wallet.toLowerCase()) as SubscriberRow[])
    .map((row) => ({ userId: row.user_id, chatId: row.chat_id, settings: readSettings(row.settings) }));
}

export function getStoredPositions(wallet: string) {
  return (db.prepare("SELECT wallet, coin, size, opened_at, updated_at FROM wallet_positions WHERE wallet = ?").all(wallet.toLowerCase()) as PositionRow[])
    .map((row): StoredPosition => ({ wallet: row.wallet, coin: row.coin, size: row.size, openedAt: row.opened_at, updatedAt: row.updated_at }));
}

export function replaceStoredPositions(wallet: string, positions: Array<{ coin: string; size: number; openedAt?: number | null }>, time = Date.now()) {
  const address = wallet.toLowerCase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM wallet_positions WHERE wallet = ?").run(address);
    const insert = db.prepare("INSERT INTO wallet_positions (wallet, coin, size, opened_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const position of positions) if (position.size) insert.run(address, position.coin, position.size, position.openedAt ?? null, time);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setStoredPosition(wallet: string, coin: string, size: number, openedAt: number | null, time: number) {
  const address = wallet.toLowerCase();
  if (!size) db.prepare("DELETE FROM wallet_positions WHERE wallet = ? AND coin = ?").run(address, coin);
  else db.prepare(`INSERT INTO wallet_positions (wallet, coin, size, opened_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(wallet, coin) DO UPDATE SET size = excluded.size, opened_at = excluded.opened_at, updated_at = excluded.updated_at`)
    .run(address, coin, size, openedAt, time);
}

export function markFillProcessed(wallet: string, hash: string, tid: number | string, occurredAt: number) {
  const key = `${wallet.toLowerCase()}:${hash}:${tid}`;
  const result = db.prepare("INSERT OR IGNORE INTO processed_fills (event_key, occurred_at) VALUES (?, ?)").run(key, occurredAt);
  if (Math.random() < 0.001) db.prepare("DELETE FROM processed_fills WHERE occurred_at < ?").run(Date.now() - 7 * 86_400_000);
  return result.changes === 1;
}
