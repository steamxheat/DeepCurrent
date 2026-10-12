import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAdminConfigValue } from "./admin-config.ts";

test("admin parser settings are clamped and stepped", () => {
  assert.equal(normalizeAdminConfigValue("trackedWallets", 37), 100);
  assert.equal(normalizeAdminConfigValue("trackedWallets", 276), 300);
  assert.equal(normalizeAdminConfigValue("signalThreshold", 250_000), 100_000);
  assert.equal(normalizeAdminConfigValue("liveMarkets", 937), 900);
  assert.equal(normalizeAdminConfigValue("confluenceMinutes", 33), 35);
});
