import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";

const traces = []; let fixture, buffer = "", errors = "";
const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/check-stages-7-10.mjs", "--keep"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${path.resolve("scripts/trace-coin-io.mjs")}` } });
child.stdout.on("data", (chunk) => { buffer += chunk; for (const line of buffer.split("\n")) { try { const row = JSON.parse(line); if (row.fixture) fixture = row; } catch {} } buffer = buffer.slice(-20000); });
child.stderr.on("data", (chunk) => { errors += chunk; const lines = errors.split("\n"); errors = lines.pop(); for (const line of lines) { if (line.startsWith("[DC_COIN_TRACE]")) traces.push(JSON.parse(line.slice(15))); else if (!line.includes("ExperimentalWarning") && !line.includes("trace-warnings")) process.stderr.write(line + "\n"); } });
try {
  for (let attempt = 0; !fixture && attempt < 300; attempt++) { assert.equal(child.exitCode, null); await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(fixture, "Fixture failed to start");
  const measurements = [];
  for (let request = 0; request < 3; request++) {
    const started = Date.now(); const response = await fetch(`${fixture.url}/coin/BTC`, { signal: AbortSignal.timeout(30000) }); const headersAt = Date.now(); const html = await response.text(); const ended = Date.now(); assert.equal(response.status, 200); assert.ok(html.includes("BTC"));
    if (process.env.DC_COIN_STALL === "1") { assert.ok(ended - started < 6500, "Upstream stall escaped page deadline"); assert.ok(html.includes("Часть рыночных данных недоступна"), "Degraded market must be labeled"); }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rows = traces.filter((row) => row.started >= started && row.started <= ended);
    const network = rows.filter((row) => row.stage === "upstream"); let cursor = started, upstreamWallMs = 0;
    for (const row of [...network].sort((a, b) => a.started - b.started)) { const from = Math.max(cursor, row.started), through = Math.min(ended, row.ended); if (through > from) upstreamWallMs += through - from; cursor = Math.max(cursor, through); }
    const sqliteMs = rows.filter((row) => row.stage === "sqlite").reduce((sum, row) => sum + row.ms, 0);
    measurements.push({ request, totalMs: ended - started, headersMs: headersAt - started, upstreamWallMs, sqliteMs, nonUpstreamWallMs: ended - started - upstreamWallMs, network });
  }
  console.log(JSON.stringify({ measurements, scope: "Isolated fixture with real public market requests. Non-upstream wall time includes Next rendering, scheduling and body transfer; not a pure CPU measurement. SQL timings include fixture maintenance. Production DB and overnight QA untouched." }, null, 2));
} finally { child.kill("SIGTERM"); }
