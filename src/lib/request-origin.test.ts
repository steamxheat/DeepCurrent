import assert from "node:assert/strict";
import test from "node:test";
import { isSameOrigin } from "./request-origin.ts";

test("same-origin writes work through HTTPS termination without trusting spoofed forwarding", () => {
  const app = "https://app.example";
  const request = (origin?: string, forwarded = app) => new Request("http://localhost:3000/api/session", {
    method: "POST", headers: { ...(origin ? { origin } : {}), "x-forwarded-host": new URL(forwarded).host, "x-forwarded-proto": "https" },
  });
  assert.equal(isSameOrigin(request(app), app), true);
  assert.equal(isSameOrigin(request("http://localhost:3000"), app), true);
  assert.equal(isSameOrigin(request(), app), true);
  for (const origin of ["https://evil.example", "null", `${app}.evil.example`, `${app}/`, "http://app.example"]) {
    assert.equal(isSameOrigin(request(origin), app), false, origin);
  }
  assert.equal(isSameOrigin(request("https://evil.example", "https://evil.example"), app), false);
  assert.equal(isSameOrigin(request(app), "invalid config"), false);
  assert.equal(isSameOrigin(request(app), ""), false);
});
