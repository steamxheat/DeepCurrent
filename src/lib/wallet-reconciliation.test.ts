import test from "node:test";
import assert from "node:assert/strict";
import { reconcileWalletFills } from "./wallet-reconciliation.ts";
import type { RawFill } from "./fill-journal.ts";
const fill:RawFill={coin:"BTC",time:100,tid:1,side:"B",px:"10",sz:"1",startPosition:"0",fee:"0",closedPnl:"0",hash:"h",dir:"Open Long"};
test("empty exact samples, missing rows and observed trades are not successful reconciliation",()=>{
  assert.equal(reconcileWalletFills([],[],200,0).status,"needs_review");
  const missing=reconcileWalletFills([fill],[],200,0); assert.equal(missing.missing.length,1); assert.equal(missing.status,"needs_review");
  const observed=reconcileWalletFills([fill],[{payload:{...fill,startPosition:undefined},conflict:0}],200,0); assert.equal(observed.observed,1); assert.equal(observed.status,"needs_review");
  assert.equal(reconcileWalletFills([fill],[],200,150).outsideTrackedHistory.length,1);
});
test("reconciliation identifies markets, financial differences, conflicts and non-atomic fresh rows",()=>{
  const rows=[{payload:{...fill,px:"10.00"},conflict:0}];
  assert.equal(reconcileWalletFills([fill],rows,200,0).status,"matched_sample");
  assert.equal(reconcileWalletFills([{...fill,coin:"ETH"}],rows,200,0).missing.length,1);
  assert.equal(reconcileWalletFills([fill],[{payload:{...fill,sz:"2"},conflict:0}],200,0).mismatches[0].field,"sz");
  assert.equal(reconcileWalletFills([fill],[{payload:fill,conflict:1}],200,0).conflicts,1);
  assert.equal(reconcileWalletFills([fill],rows,99,0).expected,0);
});
