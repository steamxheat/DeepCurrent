import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createFillJournal, type RawFill } from "./fill-journal.ts";
import { closedTrades } from "./stats.ts";
import { fillTransition, orderFillChain, reducePosition } from "./position-reducer.ts";

const wallet = `0x${"a".repeat(40)}`;
const rows: RawFill[] = [
  [100,"B","2","0","100","1","0"], [200,"B","1","2","120","0.5","0"],
  [300,"A","1","3","110","0.25","10"], [400,"A","4","2","130","1","20"],
  [500,"B","1","-2","120","0.25","-3"], [600,"B","3","-1","125","0.75","-5"],
  [700,"A","2","2","127","0.5","4"], [800,"A","1","0","120","-0.1","0"],
  [900,"B","1","-1","118","0.2","2"],
].map(([time,side,sz,startPosition,px,fee,closedPnl], index) => ({ coin:"BTC", time:Number(time), tid:index+1, side:side as "A"|"B", sz:String(sz), startPosition:String(startPosition), px:String(px), fee:String(fee), closedPnl:String(closedPnl), feeToken:"USDC", hash:`0x${(index+1).toString(16).padStart(64,"0")}`, dir:"" }));
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual-expected)<1e-9, `${actual} != ${expected}`);

test("full lifecycle preserves both flips, repeat entry, opening times and fee allocation", () => {
  const journal=createFillJournal(new DatabaseSync(":memory:"));
  try {
    const actions=["OPEN","ADD","REDUCE","FLIP","REDUCE","FLIP","CLOSE","OPEN","CLOSE"];
    const sizes=["2","3","2","-2","-1","2","0","-1","0"];
    const openings=[100,100,100,400,400,600,null,800,null];
    rows.forEach((fill,index)=>{
      journal.ingest(wallet,fill,"userFills","history",1000); journal.project();
      const state=journal.getState(wallet,"BTC")!;
      assert.equal(state.size,sizes[index]); assert.equal(state.openedAt,openings[index]); assert.equal(state.reason,null);
      assert.equal(journal.events()[0].action,actions[index]);
    });
    const trades=journal.completed(wallet).sort((a,b)=>a.closedAt-b.closedAt);
    assert.deepEqual(trades.map(t=>[t.direction,t.openedAt,t.closedAt]),[["LONG",100,400],["SHORT",400,600],["LONG",600,700],["SHORT",800,900]]);
    [27.75,-9,3,1.9].forEach((expected,index)=>near(trades[index].netPnl,expected));
    near(trades.reduce((sum,t)=>sum+t.netPnl,0),23.65);
    near(trades[0].entryPx!,320/3); near(trades[0].exitPx,370/3); near(trades[1].entryPx!,130); near(trades[1].exitPx,122.5);
    const flips=journal.queryEvents({action:"FLIP"}).events;
    assert.deepEqual(flips.map(event=>event.legs.map((leg:{action:string;direction:string;size:string})=>[leg.action,leg.direction,leg.size])),[[["CLOSE","SHORT","1"],["OPEN","LONG","2"]],[["CLOSE","LONG","2"],["OPEN","SHORT","2"]]]);
    assert.equal(journal.readySignals().length,0);
  } finally { journal.db.close(); }
});

test("200 deterministic arrival orders converge without double-counting executions or commissions", () => {
  for(let seed=1;seed<=200;seed++) {
    let random=seed; const shuffled=[...rows];
    for(let i=shuffled.length-1;i>0;i--) { random=(Math.imul(random,1664525)+1013904223)>>>0; const j=random%(i+1); [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]]; }
    const journal=createFillJournal(new DatabaseSync(":memory:"));
    try {
      for(const fill of shuffled) { journal.ingest(wallet,fill,"userFills","history",1000); journal.project(); journal.ingest(wallet,fill,"userFills","history",1000); }
      journal.project(); assert.equal(journal.events().length,rows.length); assert.equal(journal.completed(wallet).length,4);
      assert.equal(journal.getState(wallet,"BTC")?.size,"0"); near(journal.completed(wallet).reduce((sum,t)=>sum+t.netPnl,0),23.65);
    } finally { journal.db.close(); }
  }
});

test("same timestamp partial fills follow position continuity, not tid or arrival order", () => {
  const chain=rows.slice(0,4).map((fill,index)=>({...fill,time:100,tid:20-index}));
  for(const arrival of [chain,[...chain].reverse(),[chain[2],chain[0],chain[3],chain[1]]]) {
    const ordered=orderFillChain(arrival); assert.equal(ordered.ambiguous,false);
    assert.deepEqual(ordered.fills.map(fill=>fillTransition(fill)?.action),["OPEN","ADD","REDUCE","FLIP"]);
    assert.equal(ordered.state?.size,"-2"); assert.equal(ordered.state?.openedAt,100);
    assert.equal(closedTrades(arrival)[0].openedAt,100); near(closedTrades(arrival)[0].netPnl,27.75);
  }
});

test("projection upgrade reconstructs previously ambiguous tied history without altering fills or issuing alerts", () => {
  const db=new DatabaseSync(":memory:"), old=createFillJournal(db);
  try {
    old.ingestBatch(rows.slice(0,4).map(fill=>({wallet,fill:{...fill,time:100},source:"userFills" as const,mode:"history" as const}))); old.project();
    db.exec("UPDATE lifecycle_events SET algorithm_version=6,payload=json_set(payload,'$.precision','observed'),confirmed_at=NULL; UPDATE position_projection SET opened_at=NULL,reason='ambiguous_order'");
    const upgraded=createFillJournal(db); upgraded.project();
    assert.equal(upgraded.fills(wallet).length,4); assert.equal(upgraded.events().length,4);
    assert.ok(upgraded.events().every(event=>event.precision==="exact"));
    assert.equal(upgraded.getState(wallet,"BTC")?.openedAt,100); assert.equal(upgraded.getState(wallet,"BTC")?.size,"-2");
    assert.equal(upgraded.completed(wallet).length,1); assert.equal(upgraded.readySignals().length,0);
    assert.equal(db.prepare("SELECT MIN(algorithm_version) version FROM lifecycle_events").get()?.version,7);
  } finally { db.close(); }
});

test("unresolvable tied cycles and missing history never invent an opening; a later new lifecycle restores it", () => {
  const tied=[{...rows[0],sz:"1"},{...rows[2],startPosition:"1",time:100},{...rows[0],sz:"2",tid:30},{...rows[2],sz:"2",startPosition:"2",time:100,tid:31}];
  const ambiguous=orderFillChain(tied); assert.equal(ambiguous.ambiguous,true); assert.equal(ambiguous.state?.openedAt,null);
  assert.equal(closedTrades(tied).length,0);
  const gap=reducePosition(null,rows[4]); assert.equal(gap.openedAt,null); assert.equal(gap.reason,"history_gap");
  const restored=reducePosition(gap,rows[7]); assert.equal(restored.openedAt,800); assert.equal(restored.reason,null);
});

test("tied ordering agrees with an independent exhaustive search for 80 small position walks", () => {
  const countPaths=(pending:RawFill[],size:number):number=>{
    if(!pending.length)return 1;
    let count=0;
    for(let i=0;i<pending.length && count<2;i++) if(Number(pending[i].startPosition)===size) count+=countPaths(pending.filter((_,j)=>i!==j),size+(pending[i].side==="B"?1:-1)*Number(pending[i].sz));
    return Math.min(count,2);
  };
  for(let seed=1;seed<=80;seed++) {
    let random=seed,before=0; const walk:RawFill[]=[];
    for(let i=0;i<6;i++) {
      random=(Math.imul(random,1664525)+1013904223)>>>0; let after=(random%7)-3; if(after===before) after+=1;
      walk.push({...rows[0],time:100,tid:i,side:after>before?"B":"A",sz:String(Math.abs(after-before)),startPosition:String(before)}); before=after;
    }
    const unique=countPaths(walk,0)===1;
    for(const arrival of [walk,[...walk].reverse()]) assert.equal(orderFillChain(arrival).ambiguous,!unique,`walk ${seed}`);
  }
});
