export function validPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && (url.hostname === "fcm.googleapis.com" || url.hostname === "web.push.apple.com" || url.hostname === "updates.push.services.mozilla.com" || url.hostname.endsWith(".push.services.mozilla.com") || url.hostname.endsWith(".notify.windows.com"));
  } catch { return false; }
}

export function validPushKeys(p256dh: string, auth: string) {
  if (!/^[A-Za-z0-9_-]{87}=?$/.test(p256dh) || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(auth)) return false;
  const key = Buffer.from(p256dh, "base64url"), secret = Buffer.from(auth, "base64url");
  return key.length === 65 && key[0] === 4 && secret.length === 16;
}
