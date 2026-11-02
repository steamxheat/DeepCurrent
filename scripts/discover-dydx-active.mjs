import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function ownersInBlock(payload, height) {
  const block = payload.block ?? payload.sdk_block;
  assert.equal(String(block?.header?.height), String(height), "wrong_block_height");
  assert.ok(Array.isArray(block.data?.txs), "missing_block_transactions");
  const owners = new Set();
  for (const encoded of block.data.txs) {
    assert.ok(typeof encoded === "string" && encoded.length < 10_000_000, "invalid_raw_transaction");
    const text = Buffer.from(encoded, "base64").toString("utf8");
    if (!text.includes("/dydxprotocol.clob.MsgProposedOperations")) continue;
    for (const address of text.match(/dydx1[a-z0-9]{38}/g) ?? []) owners.add(address);
  }
  // Discovery only. An address embedded in a proposal is not proof that its order filled.
  return [...owners];
}
if (process.argv.includes("--self-test")) {
  const address = "dydx14dltc2w6y3dhf0naz8luglsvjt0vhvswm2j6d0";
  const tx = Buffer.from("/dydxprotocol.clob.MsgProposedOperations\0" + address).toString("base64");
  const block = { block: { header: { height: "10" }, data: { txs: [tx, tx] } } };
  assert.deepEqual(ownersInBlock(block, 10), [address]);
  assert.throws(() => ownersInBlock(block, 11), /wrong_block_height/);
  assert.deepEqual(ownersInBlock({ block: { header: { height: "10" }, data: { txs: [Buffer.from(address).toString("base64")] } } }, 10), []);
  assert.throws(() => ownersInBlock({ block: { header: { height: "10" } } }, 10), /missing_block_transactions/);
  console.log("dYdX active discovery self-checks: 4 passed");
} else {
  const directory = path.resolve(process.argv[2] ?? "backups/dydx-active-20261015"); mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "evidence.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS responses(url TEXT PRIMARY KEY,received_at INTEGER,http INTEGER,payload TEXT);");
  const get = key => { const row = db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; };
  const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  const prior = get("pid"); if (prior) { let alive = true; try { process.kill(prior, 0); } catch { alive = false; } assert.ok(!alive, `already_running_${prior}`); }
  set("pid", process.pid); let running = true, lastRequest = 0, requests = get("requests") ?? 0;
  const candidates = new Set(), accounts = [], checks = [], heights = new Map(); let blocksRead = 0;
  process.on("SIGTERM", () => { running = false; }); process.on("SIGINT", () => { running = false; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function save(status, error = null) {
    const report = { revision: "dydx-active-v1", status, error, pid: process.pid, updatedAt: Date.now(), requests, executionHeightsFound: heights.size, blocksRead,
      discoveredOwners: candidates.size, accounts: accounts.length, checkedOwners: checks.length, ownersWithRecentExecutions: new Set(accounts.map(a => a.id.owner)).size, fullyAccepted: 0 };
    for (const [name, value] of [["summary.json", report], ["selection.json", { ...report, sourceEvidence: path.join(directory, "evidence.sqlite"), accounts, checks }]]) {
      writeFileSync(path.join(directory, name + ".tmp"), JSON.stringify(value, null, 2)); renameSync(path.join(directory, name + ".tmp"), path.join(directory, name));
    }
  }
  async function request(url) {
    const cached = db.prepare("SELECT http,payload FROM responses WHERE url=?").get(url);
    if (cached?.http === 200) return JSON.parse(cached.payload);
    for (let attempt = 0; attempt < 3 && running; attempt++) {
      await pause(Math.max(0, lastRequest + 1500 - Date.now())); assert.ok(running, "stopped"); lastRequest = Date.now(); requests++; set("requests", requests);
      const response = await fetch(url, { signal: AbortSignal.timeout(25000) }); const body = await response.text();
      db.prepare("INSERT INTO responses VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET received_at=excluded.received_at,http=excluded.http,payload=excluded.payload").run(url, Date.now(), response.status, body);
      if (response.status === 429) { save("rate_limit_backoff"); for (let n = 0; n < 60 && running; n++) await pause(1000); continue; }
      assert.equal(response.status, 200, `HTTP_${response.status}`); const payload = JSON.parse(body); assert.ok(!payload.errors, "api_errors"); return payload;
    }
    throw Error(running ? "persistent_rate_limit" : "stopped");
  }
  try {
    save("finding_execution_blocks");
    for (const market of ["BTC-USD", "ETH-USD", "SOL-USD", "HYPE-USD"]) {
      const payload = await request(`https://indexer.dydx.trade/v4/trades/perpetualMarket/${market}?limit=10`);
      assert.ok(Array.isArray(payload.trades), "missing_market_executions");
      for (const trade of payload.trades) {
        const time = Date.parse(trade.createdAt); assert.ok(Number.isSafeInteger(time) && /^\d+$/.test(trade.createdAtHeight), "invalid_execution_height_or_time");
        if (time <= Date.now() && Date.now() - time <= 15 * 60000) heights.set(trade.createdAtHeight, time);
      }
    }
    const selectedHeights = [...heights].sort((a, b) => b[1] - a[1]).slice(0, 10);
    assert.ok(selectedHeights.length, "no_execution_blocks_within_15_minutes");
    for (const [height] of selectedHeights) {
      const block = await request(`https://dydx-dao-api.polkachu.com/cosmos/base/tendermint/v1beta1/blocks/${height}`);
      for (const address of ownersInBlock(block, height)) candidates.add(address); blocksRead++; save("resolving_active_accounts");
    }
    for (const address of [...candidates].slice(0, 20)) {
      const snapshot = await request(`https://indexer.dydx.trade/v4/addresses/${address}`);
      assert.ok(Array.isArray(snapshot.subaccounts) && snapshot.subaccounts.length, "missing_subaccounts");
      const numbers = snapshot.subaccounts.map(a => a.subaccountNumber); assert.equal(new Set(numbers).size, numbers.length);
      let recent = false; const details = [];
      for (const subaccount of snapshot.subaccounts) {
        assert.ok(subaccount.address === address && Number.isInteger(subaccount.subaccountNumber) && subaccount.subaccountNumber >= 0, "wrong_subaccount_identity");
        const fills = await request(`https://indexer.dydx.trade/v4/fills?address=${address}&subaccountNumber=${subaccount.subaccountNumber}&limit=5`);
        assert.ok(Array.isArray(fills.fills), "missing_individual_fills");
        for (const fill of fills.fills) assert.ok(typeof fill.id === "string" && fill.id && fill.subaccountNumber === subaccount.subaccountNumber && Number.isSafeInteger(Date.parse(fill.createdAt)) && typeof fill.fee === "string" && Number.isFinite(Number(fill.fee)), "invalid_individual_fill");
        const observed = fills.fills.filter(f => Number.isSafeInteger(Date.parse(f.createdAt)) && Date.parse(f.createdAt) <= Date.now() && Date.now() - Date.parse(f.createdAt) <= 15 * 60000);
        recent ||= observed.length > 0;
        details.push({ subaccountNumber: subaccount.subaccountNumber, recentExecutionIds: observed.map(f => f.id) });
      }
      checks.push({ address, recent, accounts: details });
      if (recent && accounts.length + snapshot.subaccounts.length <= 80) for (const subaccount of snapshot.subaccounts) accounts.push({ id: { owner: address, number: subaccount.subaccountNumber }, snapshot: subaccount });
      save("resolving_active_accounts");
    }
    assert.ok(running, "stopped"); assert.ok(accounts.length, "no_confirmed_recent_accounts"); save("complete");
  } catch (error) { save(running ? "blocked" : "stopped", error.message); process.exitCode = running ? 1 : 0; }
  finally { set("pid", null); db.close(); }
}
