import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("service worker handles malformed pushes, distinct event tags and safe notification links", async () => {
  type Event = { data?: { json(): unknown }; notification?: { close(): void; data: { url: string } }; waitUntil(task: Promise<unknown>): void };
  const handlers = new Map<string, (event: Event) => void>(); const shown: { title: string; options: { tag: string } }[] = []; const opened: string[] = [];
  runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), {
    URL, self: { location: { origin: "https://dc.example" }, addEventListener: (type: string, handler: (event: Event) => void) => handlers.set(type, handler),
      registration: { showNotification: async (title: string, options: { tag: string }) => { shown.push({ title, options }); } } },
    clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } },
  });
  let task: Promise<unknown> | undefined; const waitUntil = (value: Promise<unknown>) => { task = value; };
  handlers.get("push")!({ data: { json: () => { throw new Error("invalid JSON"); } }, waitUntil }); assert.equal(shown.length, 0);
  for (const eventId of ["event-a", "event-b"]) { handlers.get("push")!({ data: { json: () => ({ title: "BTC", body: "Open", url: "/wallet/a", eventId }) }, waitUntil }); await task; }
  assert.equal(shown[0].options.tag, "event-a"); assert.equal(shown[1].options.tag, "event-b");
  for (const url of ["https://evil.example/path", "http://[", "/wallet/a"]) { handlers.get("notificationclick")!({ notification: { close() {}, data: { url } }, waitUntil }); await task; }
  assert.deepEqual(opened, ["https://dc.example/wallet/a"]);
});
