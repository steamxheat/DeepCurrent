import assert from "node:assert/strict";
import test from "node:test";
import { createViewerPriority, nextDueWallet } from "./viewer-priority.ts";

test("entering a profile clears background deadlines once, renewing the view does not bypass refresh intervals", () => {
  const snapshots = new Map([["viewer", 300000], ["background", 300000]]), history = new Map([["viewer", 300000]]);
  const update = createViewerPriority([snapshots, history]);
  assert.deepEqual(update(["viewer"]).entered, ["viewer"]);
  assert.equal(snapshots.has("viewer"), false); assert.equal(history.has("viewer"), false); assert.equal(snapshots.get("background"), 300000);
  snapshots.set("viewer", 8000); update(["viewer"]); assert.equal(snapshots.get("viewer"), 8000);
  assert.deepEqual(update([]).exited, ["viewer"]); assert.deepEqual(update(["viewer"]).entered, ["viewer"]); assert.equal(snapshots.has("viewer"), false);
});

test("due profiles are served oldest-first without duplicating in-flight work", () => {
  const due = new Map([["first", 100], ["second", 50], ["later", 200]]);
  assert.equal(nextDueWallet(["first", "second", "later"], new Set(), due, 100), "second");
  assert.equal(nextDueWallet(["first", "second"], new Set(["second"]), due, 100), "first");
  assert.equal(nextDueWallet(["later"], new Set(), due, 100), undefined);
  due.set("second", 8000); assert.equal(nextDueWallet(["first", "second"], new Set(), due, 100), "first");
});
