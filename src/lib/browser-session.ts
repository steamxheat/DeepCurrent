import "server-only";
import { randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

export const browserSessionCookie = "deep_current_session";
const browserId = /^web_[a-f0-9]{64}$/;

export function readBrowserSession(request: NextRequest) {
  const value = request.cookies.get(browserSessionCookie)?.value ?? "";
  return browserId.test(value) ? value : null;
}

export function createBrowserSession() {
  return `web_${randomBytes(32).toString("hex")}`;
}

export function writeBrowserSession(response: NextResponse, userId: string) {
  response.cookies.set(browserSessionCookie, userId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
    priority: "high",
  });
}

export function isSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  return !origin || origin === request.nextUrl.origin;
}
