import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";

const filename = process.argv[2];
assert.ok(filename && path.isAbsolute(filename) && !path.resolve(filename).startsWith(`${process.cwd()}${path.sep}`), "Supply a private absolute backup path outside the checkout");
const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8" }));
const names = ["dc-pulse-web", "dc-pulse-bot"];
const selected = names.map((name) => {
  const rows = processes.filter((row) => row.name === name); assert.equal(rows.length, 1, name);
  assert.equal(rows[0].pm2_env.exec_mode, "fork_mode"); assert.equal(rows[0].pm2_env.status, "online"); return rows[0];
});
assert.equal(selected[1].pm2_env.DC_JOURNAL_MODE, "shadow", "Do not unexpectedly enable trading notifications during Push setup");
const existing = selected.map((row) => ({ publicKey: row.pm2_env.VAPID_PUBLIC_KEY || "", privateKey: row.pm2_env.VAPID_PRIVATE_KEY || "" }));
assert.ok(existing.every((key) => Boolean(key.publicKey) === Boolean(key.privateKey)), "Incomplete existing key pair; investigate without rotating keys");
const configured = existing.filter((key) => key.publicKey);
assert.ok(configured.every((key) => key.publicKey === configured[0].publicKey && key.privateKey === configured[0].privateKey), "Processes have different keys; do not rotate active subscriptions");
let keys;
if (existsSync(filename)) {
  assert.equal(statSync(filename).mode & 0o077, 0, "Key backup must not be readable by other users");
  keys = JSON.parse(readFileSync(filename, "utf8"));
  assert.ok(configured.every((key) => key.publicKey === keys.publicKey && key.privateKey === keys.privateKey), "Backup differs from running keys");
} else {
  keys = configured[0] || webpush.generateVAPIDKeys();
  webpush.setVapidDetails("https://mac-mini.tail50f09f.ts.net", keys.publicKey, keys.privateKey);
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  writeFileSync(filename, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
}
chmodSync(filename, 0o600);
webpush.setVapidDetails("https://mac-mini.tail50f09f.ts.net", keys.publicKey, keys.privateKey);
const restart = selected.filter((row) => row.pm2_env.VAPID_PUBLIC_KEY !== keys.publicKey || row.pm2_env.VAPID_PRIVATE_KEY !== keys.privateKey || row.pm2_env.VAPID_SUBJECT !== "https://mac-mini.tail50f09f.ts.net").map((row) => row.name);
for (const name of restart) execFileSync("pm2", ["restart", name, "--update-env"], { env: { ...process.env,
  VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "https://mac-mini.tail50f09f.ts.net", NODE_USE_ENV_PROXY: "1" }, stdio: "pipe" });
if (restart.length) execFileSync("pm2", ["save"], { stdio: "pipe" });
console.log(JSON.stringify({ configured: true, keyBackup: filename, publicKeyFingerprint: createHash("sha256").update(keys.publicKey).digest("hex").slice(0, 16), restarted: restart, notificationsMode: "shadow", envFileChanged: false, deviceDeliveryChecked: false }));
