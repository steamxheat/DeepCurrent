import { gzipSync } from "node:zlib";

const encoded = new WeakMap<object, { text: string; gzip?: Uint8Array<ArrayBuffer> }>();

// Only public market data: never use this shared encoding cache for session or personal responses.
export function publicJson(request: Request, payload: object) {
  let value = encoded.get(payload);
  if (!value) { value = { text: JSON.stringify(payload) }; encoded.set(payload, value); }
  const gzip = (request.headers.get("accept-encoding") ?? "").split(",").some((entry) => {
    const [name, ...parameters] = entry.trim().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="))?.trim().slice(2);
    return name === "gzip" && (quality === undefined || Number(quality) > 0);
  }) && value.text.length >= 1024;
  if (gzip && !value.gzip) value.gzip = new Uint8Array(gzipSync(value.text, { level: 1 }));
  return new Response(gzip ? value.gzip : value.text, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Encoding", ...(gzip ? { "Content-Encoding": "gzip", "Content-Length": String(value.gzip!.byteLength) } : {}) } });
}
