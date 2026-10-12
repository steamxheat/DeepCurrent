import { createHmac, timingSafeEqual } from "node:crypto";

export type TelegramIdentity = {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
};

export function verifyTelegramInitData(initData: string, botToken: string, now = Date.now()): TelegramIdentity | null {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!hash || !Number.isFinite(authDate) || Math.abs(now / 1_000 - authDate) > 86_400) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const actual = createHmac("sha256", secret).update(dataCheckString).digest();
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "{}") as Record<string, unknown>;
    if (typeof user.id !== "number" && typeof user.id !== "string") return null;
    return {
      id: String(user.id), firstName: String(user.first_name ?? ""), lastName: String(user.last_name ?? ""),
      username: String(user.username ?? ""),
    };
  } catch { return null; }
}
