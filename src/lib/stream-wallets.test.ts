import assert from "node:assert/strict";
import test from "node:test";
import { missingUserSubscriptions, selectStreamWallets } from "./stream-wallets.ts";

test("rejected user subscriptions retry without replacing acknowledged streams or exceeding selected wallets", () => {
  const users = new Set(["a", "b"]); const ack = new Set<string>();
  const initial = missingUserSubscriptions(users, ack); assert.equal(initial.length, 6);
  const accepted = initial.filter((row) => row.user === "a");
  accepted.forEach((row) => ack.add(JSON.stringify(row)));
  const retry = missingUserSubscriptions(users, ack);
  assert.equal(retry.length, 3); assert.ok(retry.every((row) => row.user === "b"));
  assert.deepEqual(missingUserSubscriptions(users, ack), retry);
  retry.forEach((row) => ack.add(JSON.stringify(row)));
  assert.deepEqual(missingUserSubscriptions(users, ack), []);
  assert.deepEqual(missingUserSubscriptions([], ack), []);
  ack.clear(); assert.deepEqual(missingUserSubscriptions(users, ack), initial);
});

test("viewers and favorites displace lower priority streams; recent activity fills the remaining slots", () => {
  const ranked = Array.from({ length: 20 }, (_, index) => `wallet${index}`);
  const lastTrade = new Map([["wallet19", 99], ["wallet18", 98]]);
  const selected = selectStreamWallets({ active: ["viewer"], favorites: ["favorite"], ranked, subscribedAt: new Map(), lastTrade, now: 100 });
  assert.deepEqual(selected.slice(0, 4), ["viewer", "favorite", "wallet19", "wallet18"]); assert.equal(selected.length, 10);
});
test("non-user priorities have a minimum hold to avoid resubscribing on every trade", () => {
  const ranked = Array.from({ length: 10 }, (_, index) => `wallet${index}`);
  const subscribedAt = new Map(ranked.map((wallet) => [wallet, 1000])); const lastTrade = new Map([["new-active", 60_000]]);
  assert.deepEqual(selectStreamWallets({ active: [], favorites: [], ranked: ["new-active", ...ranked], subscribedAt, lastTrade, now: 60_999 }), ranked);
  assert.equal(selectStreamWallets({ active: [], favorites: [], ranked: ["new-active", ...ranked], subscribedAt, lastTrade, now: 61_000 })[0], "new-active");
  assert.equal(selectStreamWallets({ active: ["viewer"], favorites: [], ranked, subscribedAt, lastTrade, now: 2000 })[0], "viewer");
});
