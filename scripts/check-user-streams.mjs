import assert from "node:assert/strict";

const wallets = process.argv.slice(2);
assert.ok(wallets.length > 0 && wallets.length <= 10 && new Set(wallets).size === wallets.length && wallets.every((value) => /^0x[a-f0-9]{40}$/i.test(value)), "Supply 1–10 unique public addresses; stop the collector before probing the shared IP");
const socket = new WebSocket("wss://api.hyperliquid.xyz/ws");
const acknowledged = new Set(), snapshots = new Set(), errors = [];
const started = Date.now();
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.close(); resolve(); }, 15000);
  socket.onopen = () => { for (const user of wallets) socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user, aggregateByTime: false } })); };
  socket.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(String(data));
      if (message.channel === "subscriptionResponse" && message.data?.method === "subscribe") acknowledged.add(message.data.subscription.user);
      if (message.channel === "userFills") snapshots.add(message.data.user);
      if (message.channel === "error") errors.push(String(message.data).slice(0, 300));
    } catch { errors.push("Invalid source message"); }
  };
  socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error("User-fill probe connection failed")); };
});
console.log(JSON.stringify({ requested: wallets.length, acknowledged: acknowledged.size, snapshots: snapshots.size, errors, elapsedMs: Date.now() - started, scope: "Single clean connection with fills only; no market/state/funding subscriptions and no database writes" }));
assert.equal(acknowledged.size, wallets.length, "Some user fills were rejected even on a clean fills-only connection");
