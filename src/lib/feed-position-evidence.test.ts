import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createFillJournal, type RawFill } from "./fill-journal.ts";
import { positionStatusAt } from "./live.ts";
import { shouldNotify, defaultNotificationSettings } from "./notifications.ts";

const wallet=`0x${"a".repeat(40)}`;
const fill=(time:number,startPosition:string,side:"B"|"A"="B"):RawFill=>({coin:"BTC",time,tid:time,px:"100",sz:"1",side,startPosition,dir:"",fee:"1",feeToken:"USDC",closedPnl:"0",hash:String(time)});
test("reopened position does not reactivate the old opening, even with the same side and size",()=>{
  const db=new DatabaseSync(":memory:"),j=createFillJournal(db);
  try {
    j.ingestBatch([fill(100,"0"),fill(200,"1","A"),fill(300,"0")].map(fill=>({wallet,fill,source:"userFills" as const,mode:"history" as const}))); j.project();
    j.recordScope({wallet,scope:"",requestedAt:305,receivedAt:310,payload:{assetPositions:[{position:{coin:"BTC",szi:"1",leverage:{value:5}}}]}});
    j.coverage(wallet,"fills",100,310,"covered_interval");
    const evidence=j.evidence(j.events(),311);
    assert.equal(evidence.find(e=>e.time===100)?.positionStatus,"closed"); assert.equal(evidence.find(e=>e.time===200)?.positionStatus,"closed"); assert.equal(evidence.find(e=>e.time===300)?.positionStatus,"open");
    j.markStreamGap([wallet]); const uncertain=j.evidence([j.events()[0]],311)[0]; assert.equal(uncertain.positionStatus,"unknown");
    assert.equal(shouldNotify(defaultNotificationSettings,{...uncertain,action:"OPEN",coin:"BTC",notional:100}),false);
    assert.equal(j.evidence([j.events()[0]],309)[0].positionStatus,"unknown");
  } finally { db.close(); }
});
test("a proven close with unknown opening remains closed, without inventing full duration or PnL",()=>{
  const db=new DatabaseSync(":memory:"),j=createFillJournal(db);
  try {
    j.ingest(wallet,fill(200,"1","A"),"userFills"); j.ingest(wallet,fill(300,"0"),"userFills"); j.project();
    j.recordScope({wallet,scope:"",requestedAt:305,receivedAt:310,payload:{assetPositions:[{position:{coin:"BTC",szi:"1"}}]}}); j.coverage(wallet,"fills",200,310,"covered_interval");
    const closed=j.evidence(j.events().filter(e=>e.time===200),311)[0]; assert.equal(closed.positionStatus,"closed"); assert.equal(closed.closedAt,200); assert.equal(closed.openedAt,null); assert.equal(closed.netPnl,null);
  } finally { db.close(); }
});
test("saved feed rows expire independently of live messages; historical closure remains a fact",()=>{
  for(const positionStatus of ["open","absent"] as const) {
    assert.equal(positionStatusAt({positionStatus,checkedAt:1000},30999),positionStatus);
    assert.equal(positionStatusAt({positionStatus,checkedAt:1000},31000),"unknown");
    assert.equal(positionStatusAt({positionStatus},1100),"unknown");
    assert.equal(positionStatusAt({positionStatus,checkedAt:1000},999),"unknown");
  }
  assert.equal(positionStatusAt({positionStatus:"closed"},999999),"closed");
  assert.equal(positionStatusAt({positionStatus:"open",checkedAt:NaN},1000),"unknown");
});

test("failed, stale or contradictory scoped snapshots cannot confirm a live entry",()=>{
  const db=new DatabaseSync(":memory:"),j=createFillJournal(db);
  try {
    j.ingest(wallet,fill(100,"0"),"userFills"); j.project(); j.coverage(wallet,"fills",100,200,"covered_interval");
    const event=j.events()[0];
    j.recordScope({wallet,scope:"",requestedAt:150,receivedAt:160,payload:{assetPositions:[{position:{coin:"BTC",szi:"1"}}]}});
    assert.equal(j.evidence([event],161)[0].positionStatus,"open");
    assert.equal(j.evidence([{...event,direction:"SHORT"}],161)[0].positionStatus,"unknown");
    assert.equal(j.evidence([event],30160)[0].positionStatus,"unknown");
    j.recordScope({wallet,scope:"",requestedAt:170,receivedAt:180,error:"offline"}); assert.equal(j.evidence([event],181)[0].positionStatus,"unknown");
    j.recordScope({wallet,scope:"",requestedAt:190,receivedAt:200,payload:{assetPositions:[{position:{coin:"BTC",szi:"2"}}]}}); assert.equal(j.evidence([event],201)[0].positionStatus,"unknown");
  } finally {db.close();}
});
