import assert from "node:assert/strict";
import test from "node:test";
import { eventDelay } from "./wallet-format.ts";

test("latency preserves milliseconds, zero and missing or inconsistent timestamps in both languages", () => {
  assert.equal(eventDelay(1000,2401,"en"),"1.401 s");
  assert.equal(eventDelay(1000,2401,"ru"),"1,401 с");
  assert.equal(eventDelay(1000,1000,"en"),"0.000 s");
  assert.equal(eventDelay(1000,999),"—"); assert.equal(eventDelay(1000,null),"—"); assert.equal(eventDelay(undefined,2000),"—"); assert.equal(eventDelay(NaN,2000),"—");
});
