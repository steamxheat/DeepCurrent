import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { publicJson } from "./public-json.ts";

test("public JSON compresses large shared payloads without changing facts or requiring gzip", async () => {
  const payload = { entries: Array.from({ length: 100 }, (_, id) => ({ id, wallet: "0xpublic", status: "unknown" })) };
  const request = new Request("http://localhost", { headers: { "accept-encoding": "br, gzip;q=1" } });
  const response = publicJson(request, payload), data = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-encoding"), "gzip"); assert.equal(response.headers.get("vary"), "Accept-Encoding");
  assert.deepEqual(JSON.parse(gunzipSync(data).toString()), payload); assert.ok(data.length < JSON.stringify(payload).length / 4);
  assert.deepEqual(Buffer.from(await publicJson(request, payload).arrayBuffer()), data);
  for (const accept of ["", "gzip;q=0", "deflate"]) {
    const plain = publicJson(new Request("http://localhost", { headers: { "accept-encoding": accept } }), payload);
    assert.equal(plain.headers.get("content-encoding"), null); assert.deepEqual(await plain.json(), payload);
  }
});
