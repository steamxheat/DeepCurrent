import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("a truncated raw confluence window is disclosed even if most fills lack exact fields", async () => {
  process.env.DEEPCURRENT_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "dc-confluence-cap-")), "test.sqlite");
  const { getFillJournal } = await import("./fill-journal.ts"); const { readConfluences } = await import("./confluence-data.ts");
  const store = getFillJournal(), now = Date.now(), wallet = `0x${"a".repeat(40)}`;
  store.status("targets", { wallets: [{ address: wallet, name: "Test", quality: 90 }] });
  const insert = store.db.prepare("INSERT INTO lifecycle_events(id,wallet,coin,occurred_at,payload,revision,algorithm_version) VALUES(?,?,?,?,?,1,5)");
  store.db.exec("BEGIN");
  for (let i = 0; i < 20001; i++) insert.run(String(i), wallet, "BTC", now - i, JSON.stringify({ id: String(i), wallet, coin: "BTC", time: now - i, source: "market", precision: "observed", side: "B", sz: "1", px: "100", action: "BUY", direction: "BUY" }));
  store.db.exec("COMMIT");
  const result = readConfluences(15, {}, now); assert.equal(result.capped, true); assert.deepEqual(result.groups, []);
  assert.equal(result.independence, "correlation_heuristic_not_ownership_proof");
  assert.equal(readConfluences(15, {}, now + 1).groups, result.groups, "identical viewers share computed groups");
  assert.notEqual(readConfluences(15, { minWallets: 3 }, now + 2).groups, result.groups, "different rules do not share a result");
  assert.notEqual(readConfluences(15, {}, now + 10001).groups, result.groups, "expired results are recomputed");
});
