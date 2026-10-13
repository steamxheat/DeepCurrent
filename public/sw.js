self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { return; }
  if (!payload || typeof payload !== "object") return;
  event.waitUntil(self.registration.showNotification(payload.title || "Deep Current", {
    body: payload.body || "Новое событие",
    icon: "/dc-pulse-mark.png",
    badge: "/dc-pulse-mark.png",
    // Different events for one wallet must not silently replace each other.
    tag: payload.eventId,
    data: { url: payload.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target;
  try { target = new URL(event.notification.data?.url || "/", self.location.origin); } catch { return; }
  if (target.origin !== self.location.origin) return;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((window) => new URL(window.url).pathname === target.pathname);
    return existing ? existing.focus() : clients.openWindow(target.href);
  }));
});
