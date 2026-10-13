import webpush from "web-push";
import { pushSubscriptionsForUser, removePushSubscriptionByEndpoint } from "./notification-store.ts";
import { validPushEndpoint } from "./push-endpoint.ts";

const publicKey = process.env.VAPID_PUBLIC_KEY ?? "";
const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
const configured = Boolean(publicKey && privateKey);
if (configured) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:notifications@deepcurrent.app", publicKey, privateKey);
export const webPushConfigured = () => configured;
export const webPushPublicKey = () => publicKey;

export async function sendWebPush(userId: string, payload: { title: string; body: string; url: string; endpoint?: string; eventId?: string }) {
  if (!configured) throw new Error("Web Push is not configured");
  let sent = 0; const failures: unknown[] = [];
  for (const subscription of pushSubscriptionsForUser(userId).filter((subscription) => !payload.endpoint || subscription.endpoint === payload.endpoint)) {
    if (!validPushEndpoint(subscription.endpoint)) { removePushSubscriptionByEndpoint(subscription.endpoint); continue; }
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify({ title: payload.title, body: payload.body, url: payload.url, eventId: payload.eventId }), { TTL: 60, timeout: 15_000 }); sent++;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) removePushSubscriptionByEndpoint(subscription.endpoint);
      else failures.push(error);
    }
  }
  if (failures.length) throw new Error(`${failures.length} Web Push delivery failures`);
  return sent;
}
