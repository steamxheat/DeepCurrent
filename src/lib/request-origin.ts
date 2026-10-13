export function isSameOrigin(request: Request, appUrl = process.env.APP_URL) {
  const origin = request.headers.get("origin");
  if (!origin || origin === new URL(request.url).origin) return true;
  // The HTTPS proxy may use an HTTP origin internally. Trust configured origin, not forwarded headers.
  try { return Boolean(appUrl && origin === new URL(appUrl).origin); }
  catch { return false; }
}
