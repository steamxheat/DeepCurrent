import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createFillJournal } from "./fill-journal.ts";
import { readWalletSnapshot, snapshotRefreshScopes, streamScopeSnapshots } from "./wallet-snapshot.ts";

const wallet = `0x${"c".repeat(40)}`;
test("all-DEX websocket state accepts the documented object and legacy entries", () => {
  const payload = { assetPositions: [], marginSummary: { accountValue: "10" } };
  const rows = streamScopeSnapshots(wallet, { "": payload, xyz: payload }, 100);
  assert.equal(rows.length, 2); assert.equal(rows[1].scope, "xyz"); assert.equal(rows[1].receivedAt, 100);
  assert.deepEqual(streamScopeSnapshots(wallet, [["xyz", payload]], 100), [rows[1]]);
  assert.throws(() => streamScopeSnapshots(wallet, { xyz: {} }, 100));
});
test("compact snapshots use proven market openings and suppress a later confirmed close", () => {
  const store = createFillJournal(new DatabaseSync(":memory:"));
  assert.equal(readWalletSnapshot(wallet, store, 200).pending, true);
  const fill = { coin: "BTC", time: 100, tid: 1, side: "B", px: "100", sz: "1", startPosition: "0", dir: "Open Long", fee: "0", closedPnl: "0", hash: "h" };
  store.ingest(wallet, fill, "userFills"); store.project(); store.coverage(wallet, "fills", 100, 200, "covered_interval");
  store.recordScope({ wallet, scope: "", requestedAt: 190, receivedAt: 200, payload: { marginSummary: { accountValue: "1000", totalMarginUsed: "20" }, withdrawable: "980", assetPositions: [{ position: { coin: "BTC", szi: "1", entryPx: "100", positionValue: "101", unrealizedPnl: "1" } }] } });
  store.recordScope({ wallet, scope: "spot", requestedAt: 190, receivedAt: 200, payload: { balances: [] } });
  const view = readWalletSnapshot(wallet, store, 201);
  assert.equal(view.positions[0].openedAt, 100); assert.equal(view.accountValue, 1000); assert.deepEqual(view.unavailableScopes, []);
  assert.equal(readWalletSnapshot(wallet, store, 40_000).positions[0].openedAt, null);
  store.ingest(wallet, { ...fill, time: 300, tid: 2, side: "A", startPosition: "1" }, "userFills"); store.project();
  assert.equal(readWalletSnapshot(wallet, store, 301).positions.length, 0);
  assert.deepEqual(readWalletSnapshot(wallet, store, 301).unavailableScopes, [""]);
});

test("streaming only skips REST for scopes that are actually fresh, not merely present", () => {
  const scopes = [{ wallet, scope: "", requestedAt: 100, receivedAt: 200, payload: { assetPositions: [] } }];
  assert.deepEqual(snapshotRefreshScopes(scopes, ["", "xyz"], true, 201), ["xyz", "spot"]);
  assert.deepEqual(snapshotRefreshScopes(scopes, ["", "xyz"], true, 30_000), ["", "xyz", "spot"]);
  assert.deepEqual(snapshotRefreshScopes(scopes, ["", "xyz"], false, 201), ["", "xyz", "spot"]);
  assert.deepEqual(snapshotRefreshScopes(scopes, [""], true, 199), ["", "spot"]);
});

test("an incomplete wallet cannot report partial capital as a complete account", () => {
  const store = createFillJournal(new DatabaseSync(":memory:"));
  store.status("catalog", { dexNames: ["", "xyz"] });
  const payload = { assetPositions: [], marginSummary: { accountValue: "0", totalMarginUsed: "0" }, withdrawable: "0" };
  store.recordScope({ wallet, scope: "", requestedAt: 100, receivedAt: 200, payload });
  assert.ok(Number.isNaN(readWalletSnapshot(wallet, store, 201).accountValue));
  store.recordScope({ wallet, scope: "xyz", requestedAt: 100, receivedAt: 200, payload });
  assert.equal(readWalletSnapshot(wallet, store, 201).accountValue, 0);
  assert.ok(readWalletSnapshot(wallet, store, 199).unavailableScopes.includes(""));
  store.recordScope({ wallet, scope: "", requestedAt: 100, receivedAt: 200, payload: { ...payload, assetPositions: [{ position: { coin: "BTC", szi: "1" } }] } });
  const missing = store.currentSnapshots(0)[0];
  assert.ok(Number.isNaN(missing.entryPx)); assert.ok(Number.isNaN(missing.positionValue)); assert.ok(Number.isNaN(missing.unrealizedPnl)); assert.ok(Number.isNaN(missing.leverage));
  store.recordScope({ wallet, scope: "", requestedAt: 100, receivedAt: Date.now() + 60_000, payload: { ...payload, assetPositions: [{ position: { coin: "BTC", szi: "1" } }] } });
  assert.equal(store.currentSnapshots(0).length, 0);
  store.db.close();
});
