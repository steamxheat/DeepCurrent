import assert from "node:assert/strict";
import test from "node:test";
import { defaultUserPreferences, normalizeUserPreferences } from "./user-preferences.ts";

test("normalizes user preferences at the API boundary", () => {
  const value = normalizeUserPreferences({ language: "en", pageSize: 500, privacy: true, minAccount: -20, hiddenMarkets: ["btc", "btc", 2] });
  assert.equal(value.language, "en");
  assert.equal(value.pageSize, defaultUserPreferences.pageSize);
  assert.equal(value.privacy, true);
  assert.equal(value.minAccount, 0);
  assert.deepEqual(value.hiddenMarkets, ["BTC"]);
});

test("returns isolated defaults for malformed values", () => {
  const first = normalizeUserPreferences(null);
  first.hiddenMarkets.push("BTC");
  assert.deepEqual(normalizeUserPreferences("bad").hiddenMarkets, []);
});
