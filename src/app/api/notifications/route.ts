import { getSessionIdentity } from "@/lib/admin-store";
import { getNotificationProfile, saveNotificationProfile } from "@/lib/notification-store";
import { normalizeNotificationSettings } from "@/lib/notifications";
import { normalizeUserPreferences } from "@/lib/user-preferences";

const wallet = /^0x[a-f0-9]{40}$/i;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { initData?: unknown };
  const actor = getSessionIdentity(typeof body.initData === "string" ? body.initData : "");
  return actor
    ? Response.json(getNotificationProfile(actor.id))
    : Response.json({ error: "Telegram session is not valid" }, { status: 401 });
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({})) as { initData?: unknown; favorites?: unknown; settings?: unknown; preferences?: unknown };
  const actor = getSessionIdentity(typeof body.initData === "string" ? body.initData : "");
  if (!actor) return Response.json({ error: "Telegram session is not valid" }, { status: 401 });
  if (!Array.isArray(body.favorites) || body.favorites.length > 500 || body.favorites.some((address) => typeof address !== "string" || !wallet.test(address))) {
    return Response.json({ error: "Favorites are not valid" }, { status: 400 });
  }
  return Response.json(saveNotificationProfile(actor.id, body.favorites, normalizeNotificationSettings(body.settings), normalizeUserPreferences(body.preferences)));
}
