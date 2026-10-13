import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import webpush from "web-push";

test("push retries a failed destination without sending again to a successful device", async () => {
  process.env.DEEPCURRENT_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "dc-push-delivery-")), "test.sqlite");
  const keys = webpush.generateVAPIDKeys(); process.env.VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  const { savePushSubscription } = await import("./notification-store.ts"); const { sendWebPush } = await import("./web-push-delivery.ts");
  const a = "https://fcm.googleapis.com/fcm/send/a", b = "https://fcm.googleapis.com/fcm/send/b", calls: string[] = [];
  for (const endpoint of [a, b]) savePushSubscription("test-user", { endpoint, p256dh: "test", auth: "test" });
  const original = webpush.sendNotification; let failed = false;
  webpush.sendNotification = async (subscription) => {
    calls.push(subscription.endpoint);
    if (subscription.endpoint === b && !failed) { failed = true; throw new Error("temporary failure"); }
    return { statusCode: 201, headers: {}, body: "accepted" };
  };
  try {
    await sendWebPush("test-user", { title: "test", body: "test", url: "/", endpoint: a });
    await assert.rejects(sendWebPush("test-user", { title: "test", body: "test", url: "/", endpoint: b }), /delivery failures/);
    await sendWebPush("test-user", { title: "test", body: "test", url: "/", endpoint: b });
    assert.deepEqual(calls, [a, b, b]);
  } finally { webpush.sendNotification = original; }
});
