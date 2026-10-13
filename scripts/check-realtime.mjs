import assert from "node:assert/strict";
import { decodeLiveFills } from "../src/lib/live-wire.ts";

const url = process.argv[2] || "http://localhost:3001/api/live";
const count = Number(process.argv[3] || 1000); assert.ok(Number.isInteger(count) && count > 0 && count <= 1000);
const duration = Number(process.argv[4] || 12_000); assert.ok(Number.isInteger(duration) && duration >= 6000 && duration <= 60_000);
const started = Date.now(); const controllers = []; const firstTimes = []; const delays = []; const eventDelays = []; const confirmedDelays = []; const uniqueEvents = new Map(); const observedWallets = new Set(); const confirmedWallets = new Set(); let bytes = 0; let messages = 0; let errors = 0;
await Promise.all(Array.from({ length: count }, async () => {
  const abort = new AbortController(); controllers.push(abort); const stop = setTimeout(() => abort.abort(), duration);
  let first = true;
  try {
    const response = await fetch(url, { signal: abort.signal }); assert.equal(response.status, 200);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) { if (Date.now() - started < duration - 1000) errors++; break; }
      bytes += value.length; buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith("data: ")) continue;
        const data = JSON.parse(frame.slice(6)); messages++;
        if (first) { firstTimes.push(Date.now() - started); first = false; }
        else {
          delays.push(Date.now() - data.serverAt);
          if (!data.reset) for (const fill of decodeLiveFills(data.rows ?? [])) if (fill.time >= started) {
            const age = Date.now() - fill.time; eventDelays.push(age);
            observedWallets.add(fill.wallet);
            if (fill.source === "user") { confirmedDelays.push(age); confirmedWallets.add(fill.wallet); }
            const key = `${fill.wallet}:${fill.coin}:${fill.time}:${fill.tid}`; if (!uniqueEvents.has(key)) uniqueEvents.set(key, age);
          }
        }
      }
    }
  } catch (error) { if (error.name !== "AbortError") errors++; }
  finally { clearTimeout(stop); abort.abort(); }
}));
controllers.forEach((abort) => abort.abort());
const percentile = (rows, value) => { rows.sort((a, b) => a - b); return rows[Math.min(rows.length - 1, Math.floor(rows.length * value))] ?? null; };
assert.equal(errors, 0); assert.equal(firstTimes.length, count);
console.log(JSON.stringify({ connections: count, errors, messages, bytes, elapsedMs: Date.now() - started,
  firstMessageP95Ms: percentile(firstTimes, .95), serverEmitToClientP95Ms: percentile(delays, .95),
  exchangeToClientP95Ms: percentile(eventDelays, .95), liveEventSamples: eventDelays.length,
  distinctEvents: uniqueEvents.size, observedWallets: observedWallets.size, confirmedWallets: confirmedWallets.size, firstDeliveryOfDistinctEventP95Ms: percentile([...uniqueEvents.values()], .95),
  confirmedEventP95Ms: percentile(confirmedDelays, .95), confirmedSamples: confirmedDelays.length,
  scope: "Local HTTP fan-out; not a 1000-user browser or production network benchmark" }));
