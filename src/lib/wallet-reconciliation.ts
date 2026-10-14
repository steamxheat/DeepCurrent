import { decimalEqual, validDecimal } from "./position-reducer.ts";
import type { RawFill } from "./fill-journal.ts";

export function reconcileWalletFills(source: RawFill[], stored: Array<{ payload: RawFill; conflict: number }>, cutoff: number, trackedFrom: number | null) {
  const key = (fill: RawFill) => `${fill.coin}:${fill.time}:${fill.tid}`;
  const saved = new Map(stored.map(row => [key(row.payload),row]));
  const expected = source.filter(fill => fill.time<=cutoff);
  const result = { status:"needs_review", expected:expected.length, matched:0, exact:0, observed:0, conflicts:0, missing:[] as string[], outsideTrackedHistory:[] as string[], mismatches:[] as {id:string;field:string}[] };
  for(const fill of expected) {
    const id=key(fill), row=saved.get(id);
    if(!row) { (trackedFrom!==null && fill.time>=trackedFrom ? result.missing : result.outsideTrackedHistory).push(id); continue; }
    result.matched++;
    if(row.conflict) result.conflicts++;
    const exact=row.payload.startPosition!==undefined && !row.conflict;
    if(exact)result.exact++; else result.observed++;
    for(const field of exact ? ["px","sz","fee","closedPnl","startPosition"] as const : ["px","sz"] as const) {
      const actual=row.payload[field], original=fill[field];
      if(actual===undefined || original===undefined ? actual!==original : !validDecimal(actual) || !validDecimal(original) || !decimalEqual(actual,original)) result.mismatches.push({id,field});
    }
    for(const field of ["side","hash"] as const) if(row.payload[field]!==fill[field])result.mismatches.push({id,field});
  }
  if(result.expected>0 && result.exact===result.expected && !result.missing.length && !result.outsideTrackedHistory.length && !result.mismatches.length && !result.conflicts)result.status="matched_sample";
  return result;
}
