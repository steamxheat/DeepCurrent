import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function rankingAddresses(html) {
  return [...new Set([...html.matchAll(/href="\/leaderboards\/dydx\/(dydx1[a-z0-9]{38})"/g)].map(match => match[1]))];
}

if (process.argv.includes("--self-test")) {
  const address = "dydx124h9adt0ymc5dcz5t42ecnl0e98rtqkxdd29fj";
  const link = `<a href="/leaderboards/dydx/${address}">trader</a>`;
  assert.deepEqual(rankingAddresses(link + link), [address]);
  assert.deepEqual(rankingAddresses(`<a href="https://other.example/${address}">x</a>`), []);
  assert.deepEqual(rankingAddresses(`<a href="/leaderboards/dydx/${address}extra">x</a>`), []);
  console.log("dYdX ranking discovery self-checks: 3 passed");
} else {
  const directory = path.resolve(process.argv[2] ?? "backups/dydx-ranking-20261015");
  const target = path.resolve(process.argv[3] ?? "backups/dydx-screen-20261015/screening.sqlite");
  assert.ok(target.startsWith(path.resolve("backups") + path.sep) && path.basename(target) === "screening.sqlite", "screening_database_only");
  mkdirSync(directory, { recursive: true });
  const url = "https://coinner.co/leaderboards/dydx", response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const html = await response.text(), receivedAt = Date.now();
  writeFileSync(path.join(directory, "source.html"), html);
  assert.equal(response.status, 200, `HTTP_${response.status}`);
  const addresses = rankingAddresses(html);
  assert.ok(addresses.length > 0 && addresses.length <= 200, "missing_or_unexpected_public_ranking");
  const db = new DatabaseSync(target); db.exec("PRAGMA busy_timeout=5000");
  const rows = [];
  try {
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT INTO profiles(address,priority) VALUES(?,?) ON CONFLICT(address) DO NOTHING");
    for (const [rank, address] of addresses.entries()) {
      const result = insert.run(address, 1e18 - rank * 1e12);
      rows.push({ address, discoveryRank: rank + 1, inserted: result.changes === 1 });
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
  // This third-party page supplies addresses only; every metric is checked against official data.
  const report = { source: url, receivedAt, http: response.status, target, addresses: rows, inserted: rows.filter(row => row.inserted).length, fullyAccepted: 0 };
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  appendFileSync(path.join(path.dirname(target), "actions.jsonl"), JSON.stringify({ at: receivedAt, event: "public_ranking_seeded", source: url, discovered: rows.length, inserted: report.inserted, evidence: directory }) + "\n");
  console.log(JSON.stringify({ discovered: rows.length, inserted: report.inserted, target, fullyAccepted: 0 }));
}
