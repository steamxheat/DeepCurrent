import { readConfluences } from "@/lib/confluence-data";
import { publicJson } from "@/lib/public-json";

const responses = new WeakMap<object, ReturnType<typeof readConfluences>>();

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const minutes = Number(p.get("minutes") ?? 15), minWallets = Number(p.get("minWallets") ?? 2), minQuality = Number(p.get("minQuality") ?? 0), minCopyability = Number(p.get("minCopyability") ?? 0);
  if (![1, 5, 15, 30, 60, 120, 240, 1440].includes(minutes) || !Number.isInteger(minWallets) || minWallets < 2 || minWallets > 1000 || ![minQuality, minCopyability].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) return Response.json({ error: "INVALID_QUERY" }, { status: 400 });
  const result = readConfluences(minutes, { minWallets, minQuality, minCopyability, onlyOpen: p.get("onlyOpen") === "true" });
  let payload = responses.get(result.groups);
  if (!payload) { payload = result; responses.set(result.groups, payload); }
  return publicJson(request, payload);
}
