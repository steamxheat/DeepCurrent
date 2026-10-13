import { subscribeLive } from "@/lib/live-stream";
import { connection } from "next/server";

export async function GET(request: Request) {
  await connection();
  const encoder = new TextEncoder(); let release: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => { release?.(); try { controller.close(); } catch { /* already closed */ } };
      try {
        release = subscribeLive((message) => {
          if ((controller.desiredSize ?? 0) <= 0) { stop(); return; }
          controller.enqueue(encoder.encode(`data: ${message}\n\n`));
        });
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) stop();
      } catch { controller.error(new Error("Live stream unavailable")); }
    },
    cancel() { release?.(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive" } });
}
