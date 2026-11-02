import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";

// Independent arithmetic audit: deliberately does not call the screening reducer.
function replay(rows, account, asOf) {
  const states = new Map(), closed = [], issues = [];
  const recent = rows.filter(t => t.timestamp >= asOf - 60 * 86400000 && t.timestamp <= asOf);
  for (const t of [...rows].sort((a, b) => a.timestamp - b.timestamp || a.transaction_time - b.transaction_time)) {
    const ask = t.ask_account_id === account, role = ask === t.is_maker_ask ? "maker" : "taker";
    const before = Number(t[`${role}_position_size_before`]), size = Number(t.size);
    const price = Number(t.price) > 0 ? Number(t.price) : Number(t.usd_amount) / size;
    assert.ok(Number.isFinite(before) && size > 0 && price > 0);
    const after = before + (ask ? -size : size);
    const equal = (a, b) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-12);
    let s = states.get(t.market_id);
    if (!s || before === 0 || !equal(s.size, before)) {
      if (s && !equal(s.size, before)) issues.push(`chain:${t.trade_id_str}`);
      s = { size: before, openedAt: before === 0 ? t.timestamp : null, net: 0 };
    }
    const fee = Math.ceil(Number(t.usd_amount) * (Number(t[`${role}_fee`] ?? 0) + Number(t[`integrator_${role}_fee`] ?? 0)) - 1e-9) / 1e6;
    assert.ok(Number.isFinite(fee) && fee >= 0);
    const reducing = before !== 0 && Math.sign(before) !== (ask ? -1 : 1);
    const reduced = reducing ? Math.min(Math.abs(before), size) : 0;
    if (reduced) {
      const pnl = Number(t[ask ? "ask_account_pnl" : "bid_account_pnl"]);
      assert.ok(Number.isFinite(pnl));
      s.net += pnl - fee * reduced / size;
      const entryQuote = Number(t[`${role}_entry_quote_before`]);
      if (Number.isFinite(entryQuote)) {
        const expected = Math.sign(before) * reduced * (price - Math.abs(entryQuote / before));
        if (Math.abs(expected - pnl) > Math.max(.001, Math.abs(expected) * 1e-7)) issues.push(`realized_pnl:${t.trade_id_str}`);
      } else issues.push(`missing_entry_quote:${t.trade_id_str}`);
    } else s.net -= fee;
    const flip = before !== 0 && Math.sign(after) !== Math.sign(before) && !equal(after, 0);
    if (equal(after, 0) || flip) {
      if (t.timestamp >= asOf - 60 * 86400000 && t.timestamp <= asOf) closed.push({ openedAt: s.openedAt, closedAt: t.timestamp, net: s.net });
      s = { size: after, openedAt: flip ? t.timestamp : null, net: flip ? -fee * Math.abs(after) / size : 0 };
    }
    s.size = equal(after, 0) ? 0 : after;
    states.set(t.market_id, s);
  }
  return { states, closed, issues, transactions: new Set(recent.map(t => t.tx_hash).filter(Boolean)).size };
}

const example = (extra = {}) => ({ timestamp: 1, transaction_time: 1000, trade_id_str: "1", market_id: 1, ask_account_id: 9, bid_account_id: 4, is_maker_ask: true, taker_position_size_before: "0", taker_entry_quote_before: "0", size: "2", price: "100", usd_amount: "200", tx_hash: "a", ...extra });
const check = replay([example({ taker_fee: 100 }), example({ timestamp: 2, transaction_time: 2000, ask_account_id: 4, bid_account_id: 9, is_maker_ask: false, taker_position_size_before: "2", taker_entry_quote_before: "200", size: "1", price: "110", usd_amount: "110", ask_account_pnl: "10", tx_hash: "b" }), example({ timestamp: 3, transaction_time: 3000, ask_account_id: 4, bid_account_id: 9, is_maker_ask: false, taker_position_size_before: "1", taker_entry_quote_before: "100", size: "1", price: "90", usd_amount: "90", ask_account_pnl: "-10", tx_hash: "c" })], 4, 10);
assert.equal(check.closed.length, 1); assert.ok(Math.abs(check.closed[0].net + .02) < 1e-10); assert.equal(check.issues.length, 0); assert.equal(check.transactions, 3);
const reentries = replay([1, 3].flatMap(time => [example({ timestamp: time, transaction_time: time * 1000 }), example({ timestamp: time + 1, transaction_time: (time + 1) * 1000, ask_account_id: 4, bid_account_id: 9, is_maker_ask: false, taker_position_size_before: "2", taker_entry_quote_before: "200", price: "110", usd_amount: "220", ask_account_pnl: "20" })]), 4, 10);
assert.deepEqual(reentries.closed.map(c => c.openedAt), [1, 3]); assert.deepEqual(reentries.closed.map(c => c.net), [20, 20]);

const directory = path.resolve(process.argv[2]);
const db = new DatabaseSync(path.join(directory, "screening.sqlite"), { readOnly: true });
assert.equal(JSON.parse(db.prepare("SELECT value FROM state WHERE key='pid'").get().value), null, "Stop the screening worker cleanly before fresh API audit");
const asOf = JSON.parse(db.prepare("SELECT value FROM state WHERE key='asOf'").get().value);
const output = mkdtempSync(path.join(directory, "audit-"));
let next = 0;
async function request(route, parameters) {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, next - Date.now()))); next = Date.now() + 1300;
  const url = new URL(`https://mainnet.zklighter.elliot.ai/api/v1/${route}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const payload = await response.json(); assert.equal(payload.code, 200);
  return { receivedAt: Date.now(), payload };
}
const report = { startedAt: Date.now(), asOf, source: directory, wallets: [], limitations: ["Snapshot and history are not atomic; changed accounts require another history pass", "Reported official 30d P&L is not independently reconciled from funding and balances", "Realtime <=3 seconds and Bybit execution/load are not verified"] };
const selected = new Set(process.argv.slice(3).map(address => address.toLowerCase()));
for (const address of selected) assert.match(address, /^0x[\da-f]{40}$/);
const candidates = selected.size ? [...selected].map(address => db.prepare("SELECT address,result FROM candidates WHERE address=?").get(address)) : db.prepare("SELECT address,result FROM candidates WHERE status='verified_wallet_data'").all();
assert.ok(candidates.every(Boolean), "selected_wallet_missing");
for (const candidate of candidates) {
  const saved = JSON.parse(candidate.result), issues = [], accountResults = [], walletTransactions = new Set();
  let completed = 0, wins = 0;
  try {
    const fresh = await request("account", { by: "l1_address", value: candidate.address });
    assert.ok(Array.isArray(fresh.payload.accounts) && !fresh.payload.next_cursor && (!fresh.payload.total || fresh.payload.accounts.length >= fresh.payload.total));
    const savedIds = saved.accounts.map(a => a.account).sort((a,b) => a-b);
    assert.deepEqual(fresh.payload.accounts.map(a => a.index).sort((a,b) => a-b), savedIds);
    for (const account of saved.accounts) {
      const rows = db.prepare("SELECT payload FROM trades WHERE account=?").all(account.account).map(r => JSON.parse(r.payload));
      const result = replay(rows, account.account, asOf);
      for (const t of rows) if (t.timestamp >= asOf - 60 * 86400000 && t.timestamp <= asOf && t.tx_hash) walletTransactions.add(t.tx_hash);
      completed += result.closed.length; wins += result.closed.filter(c => c.openedAt !== null && c.net > .000001).length;
      if (result.closed.some(c => c.openedAt === null)) issues.push(`unknown_closed_opening:${account.account}`);
      issues.push(...result.issues.map(issue => `${account.account}:${issue}`));
      const positions = fresh.payload.accounts.find(a => a.index === account.account).positions;
      const openings = positions.filter(p => Number(p.position) !== 0).map(p => {
        const state = result.states.get(p.market_id), size = Number(p.position) * Number(p.sign);
        const matches = state && Math.abs(state.size - size) <= Math.max(1e-8, Math.abs(size) * 1e-12) && state.openedAt !== null;
        if (!matches) issues.push(`current_position_changed_or_missing:${account.account}:${p.market_id}`);
        return { market: p.market_id, size, openedAt: state?.openedAt ?? null, matches: Boolean(matches) };
      });
      for (const [market, state] of result.states) if (state.size !== 0 && !positions.some(p => p.market_id === market && Number(p.position) !== 0)) issues.push(`position_no_longer_present:${account.account}:${market}`);
      accountResults.push({ account: account.account, trades: rows.length, completed: result.closed, openings });
    }
    const month = await request("pnlLeaderboard", { time_window: "30d", sort_by: "pnl", sort_dir: "desc", limit: 20, offset: 0, search: candidate.address });
    const entry = month.payload.entries.find(e => e.l1_address.toLowerCase() === candidate.address);
    assert.ok(entry && Number.isFinite(entry.pnl));
    const winRate = completed ? wins / completed * 100 : null;
    if (walletTransactions.size < 6 || completed < 20 || winRate === null || winRate < 60 || entry.pnl <= 0) issues.push("criteria_failed");
    if (completed !== saved.closedPositions60d || wins !== saved.wins || walletTransactions.size !== saved.transactions60d) issues.push("screening_counts_disagree");
    report.wallets.push({ address: candidate.address, status: issues.length ? "needs_review" : "audit_passed", issues, transactions60d: walletTransactions.size, completed, wins, winRate, accounts: accountResults, freshAccount: fresh, freshMonthPnl: month });
  } catch (error) { report.wallets.push({ address: candidate.address, status: "needs_review", issues: [...issues, error.message], accounts: accountResults }); }
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ address: candidate.address, status: report.wallets.at(-1).status, issues: report.wallets.at(-1).issues }));
}
report.finishedAt = Date.now(); report.passed = report.wallets.filter(w => w.status === "audit_passed").length;
report.needsReview = report.wallets.length - report.passed;
writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
db.close(); console.log(JSON.stringify({ output, checked: report.wallets.length, passed: report.passed, needsReview: report.needsReview }));
