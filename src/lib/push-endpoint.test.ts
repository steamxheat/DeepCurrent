import assert from "node:assert/strict";
import test from "node:test";
import { validPushEndpoint, validPushKeys } from "./push-endpoint.ts";

test("push accepts supported providers without permitting arbitrary server-side fetches", () => {
  for (const value of ["https://fcm.googleapis.com/fcm/send/token", "https://web.push.apple.com/token", "https://updates.push.services.mozilla.com/wpush/v2/token", "https://wns2.notify.windows.com/token"]) assert.equal(validPushEndpoint(value), true);
  for (const value of ["https://127.0.0.1/token", "http://fcm.googleapis.com/token", "https://fcm.googleapis.com.evil.example/token", "https://user:pass@fcm.googleapis.com/token", "https://fcm.googleapis.com:444/token", "https://evil.example/token", null]) assert.equal(validPushEndpoint(value), false);
});

test("push keys require an uncompressed public key and a 16-byte auth secret", () => {
  const key = Buffer.alloc(65, 1); key[0] = 4; const auth = Buffer.alloc(16, 2).toString("base64url");
  assert.equal(validPushKeys(key.toString("base64url"), auth), true);
  assert.equal(validPushKeys("junk", auth), false); assert.equal(validPushKeys(key.toString("base64url"), "junk"), false);
  key[0] = 2; assert.equal(validPushKeys(key.toString("base64url"), auth), false);
});
