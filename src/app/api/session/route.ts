import { registerSession } from "@/lib/admin-store";
import { createBrowserSession, isSameOrigin, readBrowserSession, writeBrowserSession } from "@/lib/browser-session";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Origin is not valid" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { initData?: unknown };
  const initData = typeof body.initData === "string" ? body.initData : "";
  const session = await registerSession(initData);
  if (session) return NextResponse.json({ ...session, channel: initData ? "telegram" : "web" });
  if (initData) return NextResponse.json({ error: "Telegram session is not valid" }, { status: 401 });

  const userId = readBrowserSession(request) ?? createBrowserSession();
  const response = NextResponse.json({ user: { id: userId, firstName: "Web", lastName: "", username: "" }, isAdmin: false, channel: "web" });
  writeBrowserSession(response, userId);
  return response;
}
