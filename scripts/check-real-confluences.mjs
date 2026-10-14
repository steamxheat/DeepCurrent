import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFillJournal } from "../src/lib/fill-journal.ts";
import { findConfluences } from "../src/lib/stats.ts";
const source = new DatabaseSync(".data/deep-current.sqlite", { readOnly: true });
const memory = new DatabaseSync(":memory:"), journal = createFillJournal(memory), now = Date.now();
let checks = 0; const windows = [];
try {
  source.exec("BEGIN");
  const records = source.prepare("SELECT * FROM lifecycle_events WHERE occurred_at>=? AND occurred_at<=? ORDER BY occurred_at DESC,id DESC LIMIT 20001").all(now-86400000,now);
  assert.ok(records.length > 100, "Empty real history is not acceptance");
  const insert = memory.prepare("INSERT INTO lifecycle_events(id,wallet,coin,occurred_at,payload,revision,algorithm_version,confirmed_at) VALUES(?,?,?,?,?,1,7,?)");
  for (const row of records.slice(0,20000)) insert.run(row.id,row.wallet,row.coin,row.occurred_at,row.payload,row.confirmed_at);
  const wallets = [...new Set(records.map(row=>row.wallet))];
  for (const wallet of wallets) {
    for (const row of source.prepare("SELECT * FROM position_projection WHERE wallet=?").all(wallet)) memory.prepare("INSERT INTO position_projection VALUES(?,?,?,?,?,?)").run(row.wallet,row.coin,row.size,row.opened_at,row.last_time,row.reason);
    for (const row of source.prepare("SELECT * FROM completed_position_projection WHERE wallet=?").all(wallet)) memory.prepare("INSERT INTO completed_position_projection VALUES(?,?,?,?)").run(row.wallet,row.coin,row.payload,row.updated_at);
    for (const row of source.prepare("SELECT * FROM ingestion_coverage WHERE wallet=?").all(wallet)) journal.coverage(wallet,row.feed,row.from_time,row.through_time,row.status,row.reason);
    for (const row of source.prepare("SELECT * FROM scope_snapshots WHERE wallet=? AND payload IS NOT NULL").all(wallet)) journal.recordScope({wallet,scope:row.scope,requestedAt:row.requested_at,receivedAt:row.received_at,payload:JSON.parse(row.payload),error:row.last_error??undefined});
  }
  const fills = journal.evidence(journal.events(now-86400000,20000),now).filter(row=>row.precision==="exact");
  assert.ok(fills.length>100,"No exact transitions: cannot accept real confluence input");
  for (const minutes of [1,5,15,60,240,1440]) {
    const groups = findConfluences(fills,now,minutes*60000);
    for (const group of groups) {
      assert.equal(new Set(group.allEntries.map(e=>e.wallet)).size,group.allEntries.length);
      assert.equal(new Set(group.entries.map(e=>e.cluster)).size,group.independentWallets);
      assert.ok(group.independentWallets>=2);
      assert.ok(group.allEntries.every(e=>e.coin===group.coin&&e.direction===group.direction&&e.time<=now&&now-e.time<=minutes*60000));
      assert.equal(group.spanMs,Math.max(...group.allEntries.map(e=>e.time))-Math.min(...group.allEntries.map(e=>e.time)));
      assert.ok(Number.isFinite(group.totalNotional)); checks+=5;
    }
    const open=findConfluences(fills,now,minutes*60000,{}, {onlyOpen:true});
    assert.ok(open.every(g=>g.entries.every(e=>e.stillOpen===true))); checks++;
    windows.push({minutes,groups:groups.length,open:open.length,participants:groups.reduce((n,g)=>n+g.allEntries.length,0)});
  }
  console.log(JSON.stringify({checks,records:records.length,exact:fills.length,wallets:wallets.length,capped:records.length>20000,windows,productionChanged:false,sourceReadOnly:true,
    acceptance:windows.some(w=>w.groups)?"saved-history-structure-checked":"no-real-groups-not-accepted",note:"Ownership independence and current open positions require external evidence; zero open groups is not acceptance of live signals."}));
} finally { source.close(); memory.close(); }
