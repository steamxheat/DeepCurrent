"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function WalletLiveRefresh({ address, updatedAt }: { address: string; updatedAt: number }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(updatedAt);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    let socket: WebSocket | undefined; let retry = 0; let refresh = 0; let stopped = false; let lastRefresh = 0;
    const update = () => { if (document.visibilityState !== "visible" || Date.now() - lastRefresh < 2_500) return; window.clearTimeout(refresh); refresh = window.setTimeout(() => { lastRefresh = Date.now(); router.refresh(); }, 350); };
    const connect = () => {
      socket = new WebSocket("wss://api.hyperliquid.xyz/ws");
      socket.onopen = () => { setConnected(true); socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user: address } })); };
      socket.onmessage = (event) => { try { const message = JSON.parse(String(event.data)) as { channel?: string; data?: { isSnapshot?: boolean } }; if (message.channel === "userFills" && !message.data?.isSnapshot) update(); } catch { /* heartbeat or malformed event */ } };
      socket.onclose = () => { setConnected(false); if (!stopped) retry = window.setTimeout(connect, 1_500); };
      socket.onerror = () => socket?.close();
    };
    connect();
    const fallback = window.setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, 20_000);
    return () => { stopped = true; window.clearInterval(clock); window.clearInterval(fallback); window.clearTimeout(retry); window.clearTimeout(refresh); socket?.close(); };
  }, [address, router]);

  const age = Math.max(0, Math.round((now - updatedAt) / 1_000));
  return <span role="status" className={`flex items-center gap-2 rounded-full border border-white/[.08] bg-white/[.035] px-3 py-2 text-[10px] ${connected ? "text-[var(--cyan)]" : "text-[var(--muted)]"}`} title={`Последнее обновление: ${new Date(updatedAt).toLocaleString("ru-RU")}`}><i className={`size-1.5 rounded-full ${connected ? "live-dot bg-[var(--cyan)]" : "bg-[var(--loss)]"}`}/>{connected ? "LIVE" : "CONNECTING"} · {age}с</span>;
}
