import assert from "node:assert/strict";

const leaderboard = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard").then((response) => {
  assert.equal(response.ok, true, `leaderboard returned ${response.status}`);
  return response.json();
});
assert.ok(leaderboard.leaderboardRows.length >= 200, "leaderboard has fewer than 200 wallets");

const post = (body) => fetch("https://api.hyperliquid.xyz/info", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).then((response) => {
  assert.equal(response.ok, true, `info endpoint returned ${response.status}`);
  return response.json();
});

const mids = await post({ type: "allMids" });
assert.ok(Number(mids.BTC) > 0, "BTC mid price is missing");
const fills = await post({ type: "userFills", user: leaderboard.leaderboardRows[0].ethAddress, aggregateByTime: true });
assert.ok(Array.isArray(fills), "wallet fills are not an array");
console.log(`Live check passed: ${leaderboard.leaderboardRows.length} wallets, BTC ${mids.BTC}, ${fills.length} fills in sample.`);
