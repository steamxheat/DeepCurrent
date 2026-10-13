import { randomUUID } from "node:crypto";
import { getSessionIdentity } from "@/lib/admin-store";
import { isSameOrigin, readBrowserSession } from "@/lib/browser-session";
import {
  clearInbox, hasPushSubscription, markInboxRead, recentInboxNotifications,
  recordInboxNotification, removePushSubscription, savePushSubscription,
  getNotificationProfile,
} from "@/lib/notification-store";
import { sendWebPush, webPushConfigured, webPushPublicKey } from "@/lib/web-push";
import { NextRequest } from "next/server";
import { validPushEndpoint, validPushKeys } from "@/lib/push-endpoint";

const userId = (request: NextRequest) => getSessionIdentity(request.headers.get("x-telegram-init-data") ?? "")?.id ?? readBrowserSession(request);
const snapshot = (id: string) => {
  const notifications = recentInboxNotifications(id);
  return { configured: webPushConfigured(), publicKey: webPushPublicKey(), subscribed: hasPushSubscription(id), notifications, unread: notifications.filter((item) => !item.readAt).length };
};

export async function GET(request: NextRequest) {
  const id = userId(request);
  return id ? Response.json(snapshot(id)) : Response.json({ error: "Session is not valid" }, { status: 401 });
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return Response.json({ error: "Origin is not valid" }, { status: 403 });
  const id = userId(request);
  if (!id) return Response.json({ error: "Session is not valid" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { action?: unknown; endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; id?: unknown };

  if (body.action === "subscribe") {
    if (!webPushConfigured()) return Response.json({ error: "Web Push is not configured" }, { status: 503 });
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
    const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
    if (!validPushEndpoint(endpoint) || !validPushKeys(p256dh, auth)) {
      return Response.json({ error: "Push subscription is not valid" }, { status: 400 });
    }
    savePushSubscription(id, { endpoint, p256dh, auth });
  } else if (body.action === "test") {
    const english = getNotificationProfile(id).preferences.language === "en";
    const title = english ? "Deep Current · notification center test" : "Deep Current · тест центра уведомлений";
    const message = english ? "Test entry saved. System Push delivery is checked separately." : "Тестовая запись сохранена. Доставка системного Push проверяется отдельно.";
    recordInboxNotification(id, `test:${randomUUID()}`, title, message, "/", Date.now());
    let pushAccepted = 0;
    if (webPushConfigured() && hasPushSubscription(id)) {
      try { pushAccepted = await sendWebPush(id, { title: "Deep Current · тест Web Push", body: "Тестовое системное уведомление.", url: "/" }); }
      catch { return Response.json({ ...snapshot(id), inboxCreated: true, pushAccepted: 0, pushFailed: true }); }
    }
    return Response.json({ ...snapshot(id), inboxCreated: true, pushAccepted, pushFailed: false });
  } else if (body.action === "read") {
    markInboxRead(id, typeof body.id === "number" && Number.isInteger(body.id) ? body.id : undefined);
  } else if (body.action === "clear") {
    clearInbox(id);
  } else return Response.json({ error: "Action is not valid" }, { status: 400 });

  return Response.json(snapshot(id));
}

export async function DELETE(request: NextRequest) {
  if (!isSameOrigin(request)) return Response.json({ error: "Origin is not valid" }, { status: 403 });
  const id = userId(request);
  if (!id) return Response.json({ error: "Session is not valid" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { endpoint?: unknown };
  if (typeof body.endpoint === "string") removePushSubscription(id, body.endpoint);
  return Response.json(snapshot(id));
}
