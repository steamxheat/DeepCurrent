import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Public, read-only source qualification. A successful subscription is not a verified trader.
export function liveFills(message, receivedAt) {
  if (message.type !== "channel_data" || message.channel !== "v4_subaccounts") return [];
  assert.ok(typeof message.id === "string" && Array.isArray(message.contents?.fills ?? []), "invalid_account_message");
  return (message.contents.fills ?? []).map(fill => {
    const market = fill.market ?? fill.ticker;
    assert.ok(typeof fill.id === "string" && fill.id && typeof market === "string" && market, "missing_fill_identity");
    assert.ok(!fill.market || !fill.ticker || fill.market === fill.ticker, "conflicting_fill_market");
    const exchangeAt = Date.parse(fill.createdAt);
    const numeric = value => typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value));
    assert.ok(Number.isSafeInteger(exchangeAt) && ["BUY", "SELL"].includes(fill.side), "invalid_fill_time_or_side");
    assert.ok(numeric(fill.price) && Number(fill.price) > 0 && numeric(fill.size) && Number(fill.size) > 0 && numeric(fill.fee), "missing_fill_price_size_fee");
    return { account: message.id, id: fill.id, market, exchangeAt, receivedAt, delayMs: receivedAt - exchangeAt, fill };
  });
}
function reconnectDelay(code, attempts) {
  if (attempts >= 3 || ![1000, 1001, 1006, 1011, 1012, 1013].includes(code)) return null;
  return code === 1013 ? 30000 : 1000 * 2 ** attempts;
}

if (process.argv.includes("--self-test")) {
  const message = { type: "channel_data", channel: "v4_subaccounts", id: "address/0", contents: { fills: [{ id: "f1", market: "BTC-USD", createdAt: new Date(1000).toISOString(), side: "BUY", price: "10", size: "2", fee: "-0.01" }] } };
  assert.equal(liveFills(message, 6001)[0].delayMs, 5001);
  assert.deepEqual(liveFills({ ...message, type: "subscribed" }, 6001), []);
  assert.throws(() => liveFills({ ...message, contents: { fills: [{ ...message.contents.fills[0], fee: undefined }] } }, 6001));
  assert.throws(() => liveFills({ ...message, contents: { fills: [{ ...message.contents.fills[0], createdAt: "bad" }] } }, 6001));
  assert.deepEqual(liveFills({ ...message, contents: { orders: [] } }, 6001), []);
  const account = { id: { owner: "dydx14dltc2w6y3dhf0naz8luglsvjt0vhvswm2j6d0", number: 0 } };
  assert.equal(allSelectedAccountsAreValid([account]), true);
  assert.equal(allSelectedAccountsAreValid([account, account]), false);
  assert.equal(allSelectedAccountsAreValid([{ id: { ...account.id, number: -1 } }]), false);
  assert.equal(liveFills({ ...message, contents: { fills: [{ ...message.contents.fills[0], market: undefined, ticker: "BTC-USD" }] } }, 2307)[0].delayMs, 1307);
  assert.throws(() => liveFills({ ...message, contents: { fills: [{ ...message.contents.fills[0], ticker: "ETH-USD" }] } }, 2307), /conflicting_fill_market/);
  assert.equal(reconnectDelay(1011, 0), 1000);
  assert.equal(reconnectDelay(1008, 0), null);
  assert.equal(reconnectDelay(1011, 3), null);
  assert.equal(reconnectDelay(1013, 0), 30000);
  console.log("dYdX probe self-checks: 14 passed");
} else {
  const directory = path.resolve(process.argv[2] ?? `backups/dydx-public-probe-${Date.now()}`);
  const durationSeconds = Number(process.argv[3] ?? 300);
  assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 60 && durationSeconds <= 3600);
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "evidence.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS responses(id INTEGER PRIMARY KEY,url TEXT,started_at INTEGER,received_at INTEGER,http INTEGER,server_date TEXT,payload TEXT); CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,received_at INTEGER,payload TEXT); CREATE TABLE IF NOT EXISTS executions(account TEXT,id TEXT,received_at INTEGER,exchange_at INTEGER,payload TEXT,PRIMARY KEY(account,id));");
  db.exec("CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY,opened_at INTEGER,closed_at INTEGER,code INTEGER,reason TEXT);");
  const state = key => { const row = db.prepare("SELECT value FROM state WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; };
  const set = (key, value) => db.prepare("INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  const prior = state("pid");
  if (prior) { let alive = true; try { process.kill(prior, 0); } catch { alive = false; } assert.ok(!alive, `already_running_${prior}`); }
  set("pid", process.pid);
  const selectedFile = process.argv[4];
  if (selectedFile) {
    const selection = JSON.parse(readFileSync(selectedFile, "utf8"));
    assert.ok(selection.revision === "dydx-active-v1" && selection.status === "complete" && Array.isArray(selection.accounts) && selection.accounts.length > 0 && selection.accounts.length <= 80, "invalid_active_selection");
    assert.ok(Number.isFinite(selection.updatedAt) && selection.updatedAt <= Date.now() && Date.now() - selection.updatedAt < 15 * 60000, "stale_active_selection");
    assert.equal(allSelectedAccountsAreValid(selection.accounts), true, "invalid_selected_account");
    for (const account of selection.accounts) db.prepare("INSERT OR IGNORE INTO accounts VALUES(?,?)").run(`${account.id.owner}/${account.id.number}`, JSON.stringify(account));
    set("pages", 10);
  }
  let running = true, lastRequestAt = 0, requests = state("requests") ?? 0, socket, timer, finished = false;
  let reconnectAt = null, reconnects = 0, connectionAttempts = 0, connectDeadline = null;
  const disconnects = [];
  const errors = [], ack = new Set(), updates = new Set();
  const startedAt = Date.now(); let status = "discovering", deadline = null, nextSend = 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const allAccounts = () => db.prepare("SELECT id FROM accounts ORDER BY id").all().map(row => row.id);
  function summary(reason = null) {
    const sample = db.prepare("SELECT account,count(*) samples,max(received_at-exchange_at) maxDelayMs,sum(received_at-exchange_at>5000) over5000,sum(received_at<exchange_at) negative FROM executions GROUP BY account").all();
    const report = { status, reason, pid: process.pid, startedAt, updatedAt: Date.now(), deadline, durationSeconds, requests, accounts: allAccounts().length, acknowledged: ack.size, accountsWithUpdates: updates.size, executions: sample.reduce((n, r) => n + r.samples, 0), perAccount: sample, errors, fullyAccepted: 0, liveProven: false, limitations: ["Qualification probe, not a selected trader list", "Observed delay is not future maximum or Bybit execution time", "Clock offset has not been independently calibrated; HTTP server Date and round-trip bounds are saved", "All-time history, fees/funding allocation and current position reconstruction still need independent validation", "No reconnect/backfill or 500-user/100-copy-account load acceptance"] };
    report.sampleScope = "Cumulative saved first-receipt samples, including replay across probe runs";
    report.previousReports = db.prepare("SELECT count(*) n FROM state WHERE key LIKE '%report_%'").get().n;
    report.reconnects = reconnects; report.connectionAttempts = connectionAttempts; report.disconnects = disconnects;
    writeFileSync(path.join(directory, "summary.json.tmp"), JSON.stringify(report, null, 2));
    renameSync(path.join(directory, "summary.json.tmp"), path.join(directory, "summary.json"));
    return report;
  }
  function finish(reason) {
    if (finished) return; finished = true; running = false; clearInterval(timer); status = reason === "completed" ? "complete" : "stopped";
    db.prepare("UPDATE connections SET closed_at=?,code=1000,reason=? WHERE closed_at IS NULL AND opened_at>=?").run(Date.now(), `probe_${reason}`, startedAt);
    const report = summary(reason); writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2)); set(`run_report_${startedAt}`, report);
    socket?.close(); set("pid", null); db.close(); console.log(JSON.stringify({ directory, ...report }));
    setTimeout(() => process.exit(reason === "completed" && !errors.length ? 0 : 1), 1000);
  }
  process.on("SIGTERM", () => { running = false; if (socket) finish("signal"); });
  process.on("SIGINT", () => { running = false; if (socket) finish("signal"); });
  // Read-only harness control: SIGUSR2 closes only this probe socket to exercise reconnect.
  process.on("SIGUSR2", () => { if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "controlled_probe_reconnect"); });
  async function request(url) {
    for (let attempt = 0; attempt < 3 && running; attempt++) {
      await pause(Math.max(0, lastRequestAt + 1500 - Date.now())); assert.ok(running, "stopped");
      const sentAt = Date.now(); lastRequestAt = sentAt; requests++; set("requests", requests);
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) }); const body = await response.text();
      db.prepare("INSERT INTO responses(url,started_at,received_at,http,server_date,payload) VALUES(?,?,?,?,?,?)").run(String(url), sentAt, Date.now(), response.status, response.headers.get("date"), body);
      if (response.status === 429) { status = "rate_limit_backoff"; summary(); for (let n = 0; n < 60 && running; n++) await pause(1000); continue; }
      assert.equal(response.status, 200, `HTTP_${response.status}`); return JSON.parse(body);
    }
    throw Error(running ? "persistent_rate_limit" : "stopped");
  }
  function recordExecutions(message, receivedAt) {
    for (const event of liveFills(message, receivedAt)) {
      const old = db.prepare("SELECT payload FROM executions WHERE account=? AND id=?").get(event.account, event.id);
      assert.ok(!old || old.payload === JSON.stringify(event.fill), "conflicting_execution");
      db.prepare("INSERT OR IGNORE INTO executions VALUES(?,?,?,?,?)").run(event.account, event.id, receivedAt, event.exchangeAt, JSON.stringify(event.fill));
    }
  }
  try {
    for (const row of db.prepare("SELECT received_at,payload FROM messages WHERE payload LIKE '%\"fills\"%' ORDER BY id").all()) {
      try { recordExecutions(JSON.parse(row.payload), row.received_at); }
      catch (error) { errors.push({ stage: "saved_message_replay", receivedAt: row.received_at, error: error.message }); }
    }
    // shortcut: first 1,000 chain records only qualify the source; expand discovery only after live/history gates pass.
    for (let page = state("pages") ?? 0; page < 10 && running && allAccounts().length < 80; page++) {
      const url = new URL("https://dydx-dao-api.polkachu.com/dydxprotocol/subaccounts/subaccount"); url.searchParams.set("pagination.limit", "100");
      const cursor = state("cursor"); if (cursor) url.searchParams.set("pagination.key", cursor);
      const payload = await request(url); assert.ok(Array.isArray(payload.subaccount), "missing_subaccounts");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const account of payload.subaccount) if (account.perpetual_positions?.length) {
          assert.ok(/^dydx1[a-z0-9]{38}$/.test(account.id?.owner) && Number.isInteger(account.id?.number), "invalid_account");
          db.prepare("INSERT OR IGNORE INTO accounts VALUES(?,?)").run(`${account.id.owner}/${account.id.number}`, JSON.stringify(account));
        }
        assert.ok(!payload.pagination?.next_key || payload.pagination.next_key !== cursor, "stuck_cursor");
        set("pages", page + 1); set("cursor", payload.pagination?.next_key ?? null); db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      summary(); if (!payload.pagination?.next_key) break;
    }
    assert.ok(running && allAccounts().length, "no_accounts_or_stopped");
    // Store public historical capabilities separately from live samples; none of these snapshots counts as delivery.
    if (!state("capabilitiesSaved")) {
      for (const account of allAccounts().slice(0, 2)) {
        const [address, subaccountNumber] = account.split("/");
        await request(`https://indexer.dydx.trade/v4/addresses/${address}`);
        for (const route of ["fills", "fundingPayments", "perpetualPositions", "pnl"]) {
          const url = new URL(`https://indexer.dydx.trade/v4/${route}`); Object.entries({ address, subaccountNumber, limit: "10" }).forEach(([k, v]) => url.searchParams.set(k, v));
          const payload = await request(url); const keys = { fills: "fills", fundingPayments: "fundingPayments", perpetualPositions: "positions", pnl: "pnl" };
          assert.ok(Array.isArray(payload[keys[route]]), `missing_${route}`);
        }
      }
      set("capabilitiesSaved", true);
    }
    const selected = allAccounts().slice(0, 80), sent = new Set();
    function connect() {
      status = "connecting"; connectionAttempts++; connectDeadline = Date.now() + 25000; ack.clear(); sent.clear(); nextSend = 0;
      socket = new WebSocket("wss://indexer.dydx.trade/v4/ws"); const transport = socket; let connectionId = null;
      transport.onopen = () => { status = "observing"; deadline ??= Date.now() + durationSeconds * 1000; summary(); };
      transport.onmessage = ({ data }) => {
      if (finished) return; const receivedAt = Date.now(); db.prepare("INSERT INTO messages(received_at,payload) VALUES(?,?)").run(receivedAt, String(data));
      try {
        const message = JSON.parse(data);
        if (message.type === "connected" && typeof message.connection_id === "string") {
          connectionId = message.connection_id; db.prepare("INSERT OR IGNORE INTO connections(id,opened_at) VALUES(?,?)").run(connectionId, receivedAt);
        }
        if (message.type === "error" || message.error) { errors.push({ receivedAt, message }); finish("subscription_rejected"); return; }
        if (message.type === "subscribed" && message.channel === "v4_subaccounts") ack.add(message.id);
        if (message.type === "channel_data" && message.channel === "v4_subaccounts") updates.add(message.id);
        recordExecutions(message, receivedAt);
      } catch (error) { errors.push({ receivedAt, error: error.message }); }
      };
      transport.onerror = event => { if (!finished) errors.push({ error: "transport_error", at: Date.now(), message: event.message ?? null }); };
      transport.onclose = event => {
        if (finished || socket !== transport) return;
        const at = Date.now(), delay = reconnectDelay(event.code, reconnects);
        if (connectionId) db.prepare("UPDATE connections SET closed_at=?,code=?,reason=? WHERE id=?").run(at, event.code, event.reason, connectionId);
        disconnects.push({ at, code: event.code, reason: event.reason, wasClean: event.wasClean, retryAfterMs: delay }); ack.clear();
        if (delay === null) { errors.push({ error: "unrecoverable_close", code: event.code }); finish("unrecoverable_close"); return; }
        reconnects++; reconnectAt = at + delay; status = "reconnecting"; summary();
      };
      summary();
    }
    connect();
    timer = setInterval(() => {
      if (finished) return;
      if (reconnectAt && Date.now() >= reconnectAt) { reconnectAt = null; connect(); }
      if (socket.readyState === WebSocket.OPEN && Date.now() >= nextSend) {
        const account = selected.find(id => !sent.has(id));
        if (account) { socket.send(JSON.stringify({ type: "subscribe", channel: "v4_subaccounts", id: account, batched: false })); sent.add(account); nextSend = Date.now() + 550; }
      }
      if (status === "connecting" && Date.now() > connectDeadline) { errors.push({ error: "connect_timeout" }); finish("connect_timeout"); return; }
      if (deadline && Date.now() >= deadline) { finish("completed"); return; }
      summary();
    }, 500);
  } catch (error) { errors.push({ error: error.message }); finish(running ? "blocked" : "signal"); }
}

function allSelectedAccountsAreValid(accounts) {
  return accounts.every(a => /^dydx1[a-z0-9]{38}$/.test(a.id?.owner) && Number.isInteger(a.id?.number) && a.id.number >= 0) && new Set(accounts.map(a => `${a.id.owner}/${a.id.number}`)).size === accounts.length;
}
