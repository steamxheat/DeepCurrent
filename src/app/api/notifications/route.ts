import { getSessionIdentity } from "@/lib/admin-store";
import { getNotificationProfile, saveNotificationProfile } from "@/lib/notification-store";
import { normalizeNotificationSettings } from "@/lib/notifications";
import { normalizeUserPreferences } from "@/lib/user-preferences";
import { isSameOrigin, readBrowserSession } from "@/lib/browser-session";
import { NextRequest } from "next/server";

const wallet = /^0x[a-f0-9]{40}$/i;

const actorId = (request: NextRequest, initData: unknown) => getSessionIdentity(typeof initData === "string" ? initData : "")?.id ?? readBrowserSession(request);

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { initData?: unknown };
  const userId = actorId(request, body.initData);
  return userId
    ? Response.json(getNotificationProfile(userId))
    : Response.json({ error: "Session is not valid" }, { status: 401 });
}

export async function PUT(request: NextRequest) {
  if (!isSameOrigin(request)) return Response.json({ error: "Origin is not valid" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { initData?: unknown; favorites?: unknown; settings?: unknown; preferences?: unknown };
  const userId = actorId(request, body.initData);
  if (!userId) return Response.json({ error: "Session is not valid" }, { status: 401 });
  if (!Array.isArray(body.favorites) || body.favorites.length > 500 || body.favorites.some((address) => typeof address !== "string" || !wallet.test(address))) {
    return Response.json({ error: "Favorites are not valid" }, { status: 400 });
  }
  const settings = normalizeNotificationSettings(body.settings);
  if (settings.maxLeverage > 0 && settings.minLeverage > settings.maxLeverage) return Response.json({ error: "Минимальное плечо не может быть больше максимального" }, { status: 400 });
  return Response.json(saveNotificationProfile(userId, body.favorites, settings, body.preferences === undefined ? undefined : normalizeUserPreferences(body.preferences)));
}
